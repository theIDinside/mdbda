import { randomUUID } from 'node:crypto';
import * as path from 'path';
import { MdbConnection, ConnectionAdapter } from './connection';
import { blockedResponse } from './blocked';
import { BreakpointCache, CACHED_BREAKPOINT_COMMANDS } from './breakpointCache';
import { patchCapabilities } from './capabilities';
import { Host } from './host';
import {
  alignSetBreakpointsResponse,
  buildChildAttachArgs,
  buildLaunchArgs,
  foldMemoryOffset,
  rewriteDisassemble,
  rewriteNext,
  rewriteSetBreakpoints,
  rewriteSetFunctionBreakpoints,
  sliceStackTrace,
  stripMdbEventFields,
  wrapCustomRequest,
} from './rewrites';
import {
  Breakpoint,
  CONFIG_TOKEN_COMMANDS,
  CUSTOM_COMMANDS,
  Event,
  FORWARDED_REQUESTS,
  LOCALLY_ANSWERED,
  ProtocolMessage,
  Request,
  Response,
  SessionType,
} from './protocol';
import { ShimHello } from './shimListener';
import { ShimRuns, ShimRunsOptions } from './shimRuns';

export interface SessionAdapterOptions {
	sessionType: SessionType;
	isChild: boolean;
	childPid?: number;
	config: Record<string, any>;
	/** Run a command and attach to each process it starts through mdb_shim, one at a time. */
	shimRuns?: Omit<ShimRunsOptions, 'mdbPid'>;
}

interface ResponseRewrite {
	originalCommand: string;
	stackTraceArgs?: Record<string, any>;
	breakpoints?: {
		requested: Record<string, any>[];
		mapping: ReadonlyMap<number, number>;
		local: ReadonlyMap<number, Breakpoint>;
	};
	/** Shim-run sessions: the adapter-owned ids of the requested breakpoints. */
	adapterIds?: number[];
}

export class MdbSessionAdapter implements ConnectionAdapter {
  configToken = randomUUID();
  readonly sessionType: SessionType;
  readonly isChild: boolean;
  readonly childPid?: number;
  readonly config: Record<string, any>;
  readonly processes: number[] = [];
  readonly listeners = new Set<(message: ProtocolMessage) => void>();
  readonly pendingRewrites = new Map<number, ResponseRewrite>();
  pid: number;
  selectedPid: number;
  hasTerminated = false;
  private outSeq = 0;
  private disposed = false;
  private readonly placeholderPid: number;
  private initializeArgs: Record<string, any> = {};
  // Shim-run sessions (see ShimRuns): one VS Code session that attaches to each process the command starts.
  private readonly shimOptions?: Omit<ShimRunsOptions, 'mdbPid'>;
  private shimRuns?: ShimRuns;
  private readonly breakpoints = new BreakpointCache();
  /** No process is attached; breakpoint requests are cached and answered locally. */
  private awaitingShim = false;
  /** Set while attaching; VS Code's requests wait until the attach has finished. */
  private deferredRequests: Request[] | undefined;
  private runPid: number | undefined;
  private initializedForwarded = false;
  private shutDown = false;

  constructor(
		private readonly connection: MdbConnection,
		private readonly host: Host,
		opts: SessionAdapterOptions,
  ) {
    this.sessionType = opts.sessionType;
    this.isChild = opts.isChild;
    this.childPid = opts.childPid;
    this.config = opts.config;
    this.shimOptions = opts.shimRuns;
    this.awaitingShim = opts.shimRuns !== undefined;
    this.pid = this.connection.register(this);
    this.placeholderPid = this.pid;
    this.selectedPid = this.pid;
  }

  handleMessage(message: any): void {
    if (this.disposed || message.type !== 'request') {
      return;
    }
    const request = message as Request;
    this.trace('vscode→', request);
    void this.handleRequest(request).catch((error: unknown) => {
      this.host.showError(`Failed to handle ${request.command}: ${errorMessage(error)}`);
      this.emitMessage({
        seq: ++this.outSeq, type: 'response', request_seq: request.seq, command: request.command,
        success: false, message: errorMessage(error),
      });
    });
  }

  onDidSendMessage(listener: (message: any) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    void this.shimRuns?.dispose();
    this.connection.unregister(this);
    this.listeners.clear();
  }

  selectProcess(pid: number): void {
    this.selectedPid = pid;
    this.emitEvent('invalidated', { areas: ['all'] });
  }

  onConnectionResponse(response: Response): void {
    const { processId: _mdbProcessId, ...responseWithoutProcessId } = response as Response & { processId?: number };
    const rewrite = this.pendingRewrites.get(response.request_seq);
    this.pendingRewrites.delete(response.request_seq);
    let rewritten: Response = { ...responseWithoutProcessId };
    if (rewrite) {
      rewritten.command = rewrite.originalCommand;
    }
    if (response.command === 'initialize' && response.body) {
      rewritten.body = patchCapabilities(response.body, this.sessionType);
    }
    const boundPid = response.body?.processId ?? (response.command === 'attach' && this.isChild ? this.childPid : undefined);
    if ((response.command === 'launch' || response.command === 'attach') && boundPid !== undefined) {
      this.pid = Number(boundPid);
      this.connection.bindPid(this, this.pid);
      if (this.sessionType === 'rr') {
        this.processes.splice(0, this.processes.length, ...(Array.isArray(response.body?.processes)
          ? response.body.processes as number[]
          : [this.pid]));
        this.selectedPid = this.pid;
      }
    }
    if (rewrite?.stackTraceArgs && response.body) {
      rewritten.body = sliceStackTrace(rewrite.stackTraceArgs, response.body);
    }
    if (rewrite?.breakpoints && response.body) {
      const mdbBreakpoints = Array.isArray(response.body.breakpoints) ? response.body.breakpoints as Breakpoint[] : [];
      rewritten.body = {
        ...response.body,
        breakpoints: alignSetBreakpointsResponse(
          rewrite.breakpoints.requested,
          rewrite.breakpoints.mapping,
          rewrite.breakpoints.local,
          mdbBreakpoints,
        ),
      };
      if (rewrite.adapterIds) {
        rewritten.body.breakpoints = withForwardedIds(
          rewritten.body.breakpoints as Breakpoint[], rewrite.breakpoints.mapping, mdbBreakpoints);
      }
    }
    if (rewrite?.adapterIds && rewritten.body) {
      const breakpoints = Array.isArray(rewritten.body.breakpoints) ? rewritten.body.breakpoints as Breakpoint[] : [];
      rewritten.body = { ...rewritten.body, breakpoints: this.breakpoints.bind(rewrite.adapterIds, breakpoints) };
    }
    this.emitMessage({ ...rewritten, seq: ++this.outSeq });
    if (rewrite?.originalCommand === 'continueAll' && response.success) {
      this.emitEvent('continued', { allThreadsContinued: true });
    }
  }

  onConnectionEvent(event: Event): void {
    if (this.shimOptions) {
      const shimEvent = this.shimRunEvent(event);
      if (!shimEvent) {
        return;
      }
      event = shimEvent;
    }
    if (event.event === 'terminated') {
      this.hasTerminated = true;
    }
    if (event.event === 'process') {
      const childPid = Number(event.body?.processId);
      if (Number.isFinite(childPid)) {
        this.host.startChildSession(this, childPid, `${this.baseName()} [fork ${childPid}]`);
      }
      return;
    }
    if (event.event === 'setProcessName') {
      this.host.logger.info(`mdb process name: ${String(event.body?.name ?? '')}`);
      return;
    }
    if (event.event === 'stopped' && this.sessionType === 'rr' && Array.isArray(event.body?.processes)) {
      this.updateProcesses(event.body.processes as number[]);
    }
    const stripped = stripMdbEventFields(event);
    this.emitMessage({ ...stripped.event, seq: ++this.outSeq });
  }

  private async handleRequest(request: Request): Promise<void> {
    const command = request.command;
    const args = request.arguments ?? {};
    if (LOCALLY_ANSWERED.has(command)) {
      this.emitMessage({ seq: ++this.outSeq, type: 'response', request_seq: request.seq, command, success: true, body: { breakpoints: [] } });
      return;
    }
    if (!FORWARDED_REQUESTS.has(command) && !CUSTOM_COMMANDS.includes(command as typeof CUSTOM_COMMANDS[number])) {
      this.emitMessage({ ...blockedResponse(request), seq: ++this.outSeq });
      return;
    }
    if (this.shimOptions && await this.handleShimRunRequest(request)) {
      return;
    }

    if (this.isChild && (command === 'terminate' || (command === 'disconnect' && args.terminateDebuggee !== false))) {
      await this.stopChild(request);
      return;
    }

    let wireCommand = command;
    let wireArgs: Record<string, any> = { ...args };
    const rewrite: ResponseRewrite = { originalCommand: command };
    if (command === 'initialize') {
      wireArgs = { ...wireArgs, RRSession: this.sessionType === 'rr' };
      this.initializeArgs = wireArgs;
    }
    if (this.shimOptions && CACHED_BREAKPOINT_COMMANDS.has(command)) {
      rewrite.adapterIds = this.breakpoints.record(command, args);
    }
    if (command === 'launch') {
      wireArgs = buildLaunchArgs(this.config, this.configToken);
    }
    if (command === 'attach' && this.isChild) {
      wireArgs = buildChildAttachArgs(this.childPid ?? this.pid, this.configToken);
    }
    if (command === 'next') {
      wireArgs = rewriteNext(wireArgs);
    }
    if (command === 'disassemble') {
      wireArgs = rewriteDisassemble(wireArgs);
    }
    if (command === 'readMemory' || command === 'writeMemory') {
      wireArgs = foldMemoryOffset(wireArgs);
    }
    if (command === 'stackTrace') {
      rewrite.stackTraceArgs = { ...wireArgs };
    }
    if (command === 'setBreakpoints') {
      const rewritten = rewriteSetBreakpoints(wireArgs);
      this.emitWarnings(rewritten.warnings);
      const requested = Array.isArray(args.breakpoints)
        ? args.breakpoints
        : Array.isArray(args.lines) ? args.lines.map((line: number) => ({ line })) : [];
      rewrite.breakpoints = { requested, mapping: rewritten.mapping, local: rewritten.local };
      // Always forward, even with nothing left to set: an empty list is how mdb clears a file's breakpoints.
      wireArgs = rewritten.forward;
    }
    if (command === 'setFunctionBreakpoints') {
      const rewritten = rewriteSetFunctionBreakpoints(wireArgs);
      this.emitWarnings(rewritten.warnings);
      wireArgs = rewritten.forward;
    }
    if (CUSTOM_COMMANDS.includes(command as typeof CUSTOM_COMMANDS[number])) {
      const wrapped = wrapCustomRequest(command, args);
      wireCommand = wrapped.command;
      wireArgs = wrapped.arguments;
    }
    if (CONFIG_TOKEN_COMMANDS.has(wireCommand)) {
      wireArgs = { ...wireArgs, configToken: this.configToken };
    }

    const processId = this.sessionType === 'rr' ? this.selectedPid : this.pid;
    const wireRequest: Request = { ...request, command: wireCommand, arguments: wireArgs };
    if (wireCommand !== command || rewrite.stackTraceArgs || rewrite.breakpoints || rewrite.adapterIds) {
      this.pendingRewrites.set(request.seq, rewrite);
    }
    const forwarded = this.connection.forward(this, wireRequest, processId);
    if (forwarded && !this.isChild && (command === 'disconnect' || command === 'terminate')) {
      this.connection.expectShutdown();
    }
  }

  /** Answers requests that a shim-run session handles itself. Returns false for requests to forward. */
  private async handleShimRunRequest(request: Request): Promise<boolean> {
    const command = request.command;
    const args = request.arguments ?? {};
    if (this.deferredRequests) {
      this.deferredRequests.push(request);
      return true;
    }
    if (command === 'launch') {
      await this.startShimRuns(request);
      return true;
    }
    if (command === 'disconnect' || command === 'terminate') {
      await this.shutDownShimRuns();
      this.respond(request);
      return true;
    }
    if (!this.awaitingShim || command === 'initialize') {
      return false;
    }
    if (CACHED_BREAKPOINT_COMMANDS.has(command)) {
      const ids = this.breakpoints.record(command, args);
      this.respond(request, { breakpoints: this.breakpoints.unverified(command, args, ids) });
    } else if (command === 'configurationDone') {
      this.respond(request);
    } else if (command === 'threads') {
      this.respond(request, { threads: [] });
    } else {
      this.emitMessage({
        seq: ++this.outSeq, type: 'response', request_seq: request.seq, command, success: false,
        message: 'No process is being debugged yet',
      });
    }
    return true;
  }

  private async startShimRuns(request: Request): Promise<void> {
    const mdbPid = this.connection.mdbPid;
    if (!this.shimOptions || mdbPid === undefined) {
      throw new Error('mdb is not running');
    }
    this.shimRuns = new ShimRuns(this.host, {
      attachShim: (hello) => this.attachShim(hello),
      runnerExited: (exitCode) => {
        this.emitEvent('output', { category: 'console', output: `${this.baseName()} exited with code ${exitCode ?? 'unknown'}\n` });
        void this.shutDownShimRuns();
      },
      output: (text) => this.emitEvent('output', { category: 'console', output: text }),
    }, { ...this.shimOptions, mdbPid });
    try {
      await this.shimRuns.start();
    } catch (error) {
      await this.shimRuns.dispose();
      throw error;
    }
    this.respond(request);
  }

  /** Attaches mdb to a shim, replays the cached breakpoints and finishes mdb's configuration of it. */
  private async attachShim(hello: ShimHello): Promise<void> {
    const token = randomUUID();
    const mdbRequest = async (command: string, args: Record<string, any>): Promise<Response> => {
      const response = await this.connection.request(this, command, { ...args, configToken: token }, this.pid);
      if (!response.success) {
        throw new Error(`${command} failed: ${response.message ?? 'unknown error'}`);
      }
      return response;
    };
    this.deferredRequests = [];
    this.configToken = token;
    try {
      await mdbRequest('initialize', this.initializeArgs);
      await mdbRequest('attach', {
        ...buildChildAttachArgs(hello.pid, token),
        ...(Array.isArray(this.config.views) ? { views: this.config.views } : {}),
      });
      this.runPid = hello.pid;
      this.pid = hello.pid;
      this.selectedPid = hello.pid;
      this.connection.bindPid(this, hello.pid);
      for (const cached of this.breakpoints.cached()) {
        const response = await mdbRequest(cached.command, replayArgs(cached.command, cached.args));
        const mdbBreakpoints = Array.isArray(response.body?.breakpoints) ? response.body.breakpoints as Breakpoint[] : [];
        const aligned = cached.command === 'setBreakpoints' ? alignReplayedBreakpoints(cached.args, mdbBreakpoints) : mdbBreakpoints;
        for (const breakpoint of this.breakpoints.bind(cached.ids, aligned)) {
          this.emitEvent('breakpoint', { reason: 'changed', breakpoint });
        }
      }
      await mdbRequest('configurationDone', {});
      this.awaitingShim = false;
    } catch (error) {
      if (this.runPid !== undefined) {
        await this.stopShimRun();
      }
      throw error;
    } finally {
      const deferred = this.deferredRequests;
      this.deferredRequests = undefined;
      for (const request of deferred) {
        this.handleMessage(request);
      }
    }
  }

  /** Filters mdb's events for a shim-run session; returns undefined for events it consumes. */
  private shimRunEvent(event: Event): Event | undefined {
    if (event.event === 'initialized') {
      // Only VS Code's own initialize is answered with initialized; the per-attach ones are internal.
      if (this.initializedForwarded) {
        return undefined;
      }
      this.initializedForwarded = true;
    }
    if (event.processId !== undefined && event.processId === this.runPid) {
      if (event.event === 'exited') {
        this.emitEvent('output', {
          category: 'console',
          output: `Process ${event.processId} exited with code ${String(event.body?.exitCode ?? 'unknown')}\n`,
        });
        return undefined;
      }
      if (event.event === 'terminated') {
        this.endShimRun();
        return undefined;
      }
    }
    if (event.event === 'terminated') {
      // mdb itself went away.
      void this.shimRuns?.dispose();
    }
    return this.breakpoints.translateEvent(event);
  }

  /** The attached process is gone: forget it and wait for the next shim. */
  private endShimRun(): void {
    const pid = this.runPid;
    if (pid === undefined) {
      return;
    }
    this.runPid = undefined;
    this.connection.unbindPid(this, pid);
    this.pid = this.placeholderPid;
    this.selectedPid = this.pid;
    this.awaitingShim = true;
    this.breakpoints.resetRun();
    for (const cached of this.breakpoints.cached()) {
      for (const breakpoint of this.breakpoints.unverified(cached.command, cached.args, cached.ids)) {
        this.emitEvent('breakpoint', { reason: 'changed', breakpoint });
      }
    }
    this.emitEvent('invalidated', { areas: ['all'] });
    this.shimRuns?.runEnded();
  }

  private async stopShimRun(): Promise<void> {
    const pid = this.runPid;
    if (pid === undefined) {
      return;
    }
    await this.connection.request(this, 'disconnect', { terminateDebuggee: false }, pid);
    try {
      this.connection.killTracee(pid, 'SIGKILL');
    } catch (error) {
      if (!isErrno(error, 'ESRCH')) {
        throw error;
      }
    }
    this.endShimRun();
  }

  private async shutDownShimRuns(): Promise<void> {
    if (this.shutDown) {
      return;
    }
    this.shutDown = true;
    await this.shimRuns?.dispose();
    try {
      await this.stopShimRun();
    } catch (error) {
      this.host.showError(`Failed to stop process ${this.runPid}: ${errorMessage(error)}`);
    }
    this.connection.expectShutdown();
    this.emitEvent('terminated');
  }

  private respond(request: Request, body?: Record<string, unknown>): void {
    this.emitMessage({
      seq: ++this.outSeq, type: 'response', request_seq: request.seq, command: request.command, success: true,
      ...(body ? { body } : {}),
    });
  }

  private async stopChild(request: Request): Promise<void> {
    const childPid = this.childPid ?? this.pid;
    try {
      const response = await this.connection.request(this, 'disconnect', { terminateDebuggee: false }, childPid);
      if (!response.success) {
        this.emitMessage({ ...response, command: request.command, request_seq: request.seq, seq: ++this.outSeq });
        return;
      }
      try {
        this.connection.killTracee(childPid, 'SIGKILL');
      } catch (error) {
        if (!isErrno(error, 'ESRCH')) {
          throw error;
        }
      }
      this.emitMessage({ seq: ++this.outSeq, type: 'response', request_seq: request.seq, command: request.command, success: true });
      this.emitEvent('terminated');
    } catch (error) {
      this.host.showError(`Failed to stop child process ${childPid}: ${errorMessage(error)}`);
      this.emitMessage({
        seq: ++this.outSeq, type: 'response', request_seq: request.seq, command: request.command,
        success: false, message: errorMessage(error),
      });
    }
  }

  private updateProcesses(processes: number[]): void {
    this.processes.splice(0, this.processes.length, ...processes);
    if (this.selectedPid === undefined || !this.processes.includes(this.selectedPid)) {
      if (this.processes.length > 0) {
        this.selectedPid = this.processes[0];
        this.emitEvent('invalidated', { areas: ['all'] });
      }
    }
  }

  private emitWarnings(warnings: Array<{ message: string }>): void {
    for (const warning of warnings) {
      this.emitEvent('output', { category: 'console', output: `${warning.message}\n` });
    }
  }

  private emitEvent(event: string, body?: Record<string, unknown>): void {
    if (event === 'terminated') {
      this.hasTerminated = true;
    }
    this.emitMessage({ seq: ++this.outSeq, type: 'event', event, ...(body ? { body } : {}) });
  }

  private emitMessage(message: ProtocolMessage): void {
    this.trace('→vscode', message);
    for (const listener of [...this.listeners]) {
      listener(message);
    }
  }

  private trace(prefix: string, message: unknown): void {
    if (this.host.trace) {
      this.host.logger.trace(`${prefix} ${JSON.stringify(message)}`);
    }
  }

  private baseName(): string {
    return this.config.name ?? (typeof this.config.program === 'string' ? path.basename(this.config.program) : 'mdb');
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function replayArgs(command: string, args: Record<string, any>): Record<string, any> {
  if (command === 'setBreakpoints') {
    return rewriteSetBreakpoints(args).forward;
  }
  if (command === 'setFunctionBreakpoints') {
    return rewriteSetFunctionBreakpoints(args).forward;
  }
  return args;
}

function alignReplayedBreakpoints(args: Record<string, any>, mdbBreakpoints: Breakpoint[]): Breakpoint[] {
  const rewritten = rewriteSetBreakpoints(args);
  const requested = Array.isArray(args.breakpoints)
    ? args.breakpoints
    : Array.isArray(args.lines) ? args.lines.map((line: number) => ({ line })) : [];
  const aligned = alignSetBreakpointsResponse(requested, rewritten.mapping, rewritten.local, mdbBreakpoints);
  return withForwardedIds(aligned, rewritten.mapping, mdbBreakpoints);
}

/**
 * Alignment drops mdb's id from breakpoints it can't place yet, such as before the process has exec'd. Restore
 * the id by request position, so the id in mdb's later `breakpoint` events can be translated.
 */
function withForwardedIds(aligned: Breakpoint[], mapping: ReadonlyMap<number, number>, mdbBreakpoints: Breakpoint[]): Breakpoint[] {
  if (mdbBreakpoints.length !== mapping.size) {
    return aligned;
  }
  return aligned.map((breakpoint, index) => {
    const forwardedIndex = mapping.get(index);
    const id = forwardedIndex !== undefined ? mdbBreakpoints[forwardedIndex]?.id : undefined;
    return breakpoint.id === undefined && id !== undefined ? { ...breakpoint, id } : breakpoint;
  });
}
