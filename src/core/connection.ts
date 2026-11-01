import { nullLogger, Logger } from './logger';
import { Event, Request, Response, SessionType } from './protocol';

export interface MdbProcessLike {
	start(): void;
	send(message: unknown): void;
	kill(graceMs?: number): Promise<void>;
	on(event: string, listener: (...args: any[]) => void): this;
}

export interface ConnectionAdapter {
	sessionType: SessionType;
	hasTerminated: boolean;
	onConnectionResponse(response: Response): void;
	onConnectionEvent(event: Event): void;
}

interface PendingRequest {
	adapter: ConnectionAdapter;
	command: string;
	originalSeq: number;
	internal: boolean;
	resolve?: (response: Response) => void;
}

export type ProcessKiller = (pid: number, signal: NodeJS.Signals) => void;

export class MdbConnection {
  private readonly adapters = new Set<ConnectionAdapter>();
  private readonly pidAdapters = new Map<number, ConnectionAdapter>();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly bufferedEvents: Array<{ pid: number; event: Event }> = [];
  private mdbSeq = 0;
  private placeholderPid = 0;
  private internalSeq = 0;
  private disposed = false;
  private expectedShutdown = false;
  private readonly logger: Logger;
  private readonly killProcess: ProcessKiller;

  constructor(
		private readonly process: MdbProcessLike,
		private readonly logDirectory: string,
		logger: Logger = nullLogger,
		killProcess: ProcessKiller = (pid, signal) => processKill(pid, signal),
		private readonly trace = false,
  ) {
    this.logger = logger;
    this.killProcess = killProcess;
    this.process.on('message', (message: unknown) => this.onMessage(message));
    this.process.on('garbage', (text: string) => this.logger.error(`Garbage on mdb stdout: ${text}`));
    this.process.on('stderr', (line: string) => this.logger.info(`mdb stderr: ${line}`));
    this.process.on('stdout', (line: string) => this.logger.info(`mdb stdout: ${line}`));
    this.process.on('spawnError', (error: NodeJS.ErrnoException) => this.onSpawnError(error));
    this.process.on('exit', (result: { code: number | null; signal: NodeJS.Signals | null }) => this.onExit(result));
    this.process.start();
  }

  register(adapter: ConnectionAdapter): number {
    this.adapters.add(adapter);
    const placeholder = ++this.placeholderPid;
    this.bindPid(adapter, placeholder);
    return placeholder;
  }

  unregister(adapter: ConnectionAdapter): void {
    this.adapters.delete(adapter);
    for (const [pid, owner] of this.pidAdapters) {
      if (owner === adapter) {
        this.pidAdapters.delete(pid);
      }
    }
    if (this.adapters.size === 0) {
      void this.dispose();
    }
  }

  bindPid(adapter: ConnectionAdapter, pid: number): void {
    const previous = this.pidAdapters.get(pid);
    if (previous && previous !== adapter) {
      this.logger.warn(`Reassigning mdb process ${pid} to another session`);
    }
    this.pidAdapters.set(pid, adapter);
    const waiting = this.bufferedEvents.filter((item) => item.pid === pid);
    if (waiting.length > 0) {
      for (let index = this.bufferedEvents.length - 1; index >= 0; index -= 1) {
        if (this.bufferedEvents[index].pid === pid) {
          this.bufferedEvents.splice(index, 1);
        }
      }
      for (const item of waiting) {
        this.deliverEvent(adapter, item.event);
      }
    }
  }

  forward(adapter: ConnectionAdapter, request: Request, processId: number): boolean {
    return this.sendRequest(adapter, request, processId, false);
  }

  request(adapter: ConnectionAdapter, command: string, args: Record<string, unknown>, processId: number): Promise<Response> {
    const request: Request = {
      seq: --this.internalSeq,
      type: 'request',
      command,
      arguments: args,
    };
    return new Promise((resolve) => {
      this.sendRequest(adapter, request, processId, true, resolve);
    });
  }

  killTracee(pid: number, signal: NodeJS.Signals): void {
    this.killProcess(pid, signal);
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.expectedShutdown = true;
    this.disposed = true;
    await this.process.kill(1500);
  }

  expectShutdown(): void {
    this.expectedShutdown = true;
  }

  private sendRequest(
    adapter: ConnectionAdapter,
    request: Request,
    processId: number,
    internal: boolean,
    resolve?: (response: Response) => void,
  ): boolean {
    if (this.disposed) {
      const response = this.errorResponse(request.command, request.seq, 'mdb connection is closed');
      if (internal) {
        resolve?.(response);
      } else {
        adapter.onConnectionResponse(response);
      }
      return false;
    }
    const seq = ++this.mdbSeq;
    const forwarded: Request & { processId: number; arguments: Record<string, unknown> } = {
      ...request,
      seq,
      processId,
      arguments: request.arguments ?? {},
    };
    const responseCommand = forwarded.command === 'customRequest' && typeof forwarded.arguments.command === 'string'
      ? forwarded.arguments.command
      : forwarded.command;
    this.pending.set(seq, { adapter, command: responseCommand, originalSeq: request.seq, internal, resolve });
    if (this.trace) {
      this.logger.trace(`→mdb ${JSON.stringify(forwarded)}`);
    }
    this.process.send(forwarded);
    return true;
  }

  private onMessage(message: unknown): void {
    if (this.trace) {
      this.logger.trace(`mdb→ ${JSON.stringify(message)}`);
    }
    if (!isRecord(message)) {
      this.logger.warn('Ignoring non-object message from mdb');
      return;
    }
    if (message.type === 'response') {
      this.onResponse(message as unknown as Response);
    } else if (message.type === 'event') {
      this.onEvent(message as unknown as Event);
    }
  }

  private onResponse(response: Response): void {
    let seq = response.request_seq;
    let pending = this.pending.get(seq);
    if (!pending) {
      const fallback = [...this.pending.entries()].find(([, item]) => item.command === response.command);
      if (fallback) {
        [seq, pending] = fallback;
        this.logger.warn(`mdb response ${response.request_seq} was unmatched; routed to oldest pending ${response.command}`);
      } else {
        this.logger.warn(`Ignoring unmatched mdb response for ${response.command} (${response.request_seq})`);
        return;
      }
    }
    this.pending.delete(seq);
    const restored: Response = { ...response, request_seq: pending.originalSeq };
    if (pending.internal) {
      pending.resolve?.(restored);
    } else {
      pending.adapter.onConnectionResponse(restored);
    }
  }

  private onEvent(event: Event): void {
    const pid = event.processId;
    if (pid === undefined) {
      this.logger.warn(`Ignoring mdb event without processId: ${event.event}`);
      return;
    }
    const adapter = this.pidAdapters.get(pid);
    if (!adapter) {
      if (this.bufferedEvents.length >= 1000) {
        this.bufferedEvents.shift();
        this.logger.warn('Dropping oldest buffered mdb event (buffer limit 1000)');
      }
      this.bufferedEvents.push({ pid, event });
      return;
    }
    this.deliverEvent(adapter, event);
  }

  private deliverEvent(adapter: ConnectionAdapter, event: Event): void {
    if (adapter.sessionType === 'rr' && event.event === 'stopped' && Array.isArray(event.body?.processes)) {
      for (const pid of event.body.processes as number[]) {
        this.pidAdapters.set(pid, adapter);
      }
    }
    adapter.onConnectionEvent(event);
  }

  private onExit(result: { code: number | null; signal: NodeJS.Signals | null }): void {
    this.disposed = true;
    const detail = `mdb exited (code ${result.code ?? 'null'}, signal ${result.signal ?? 'null'}). Log directory: ${this.logDirectory}`;
    const crash = !this.expectedShutdown && (
      (result.code !== null && result.code !== 0) || result.signal !== null ||
			[...this.adapters].some((adapter) => !adapter.hasTerminated)
    );
    if (this.expectedShutdown) {
      this.logger.info(detail);
    } else if (!crash) {
      this.logger.info(detail);
    }
    for (const adapter of this.adapters) {
      if (crash) {
        adapter.onConnectionEvent({
          seq: 0, type: 'event', event: 'output', body: { category: 'important', output: `${detail}\n` },
        });
      }
      if (!adapter.hasTerminated) {
        adapter.onConnectionEvent({ seq: 0, type: 'event', event: 'terminated' });
      }
    }
    for (const [seq, pending] of this.pending) {
      const response = this.errorResponse(pending.command, pending.originalSeq, detail);
      if (pending.internal) {
        pending.resolve?.(response);
      } else {
        pending.adapter.onConnectionResponse(response);
      }
      this.pending.delete(seq);
    }
  }

  private onSpawnError(error: NodeJS.ErrnoException): void {
    const message = `Failed to start mdb: ${error.message}. Log directory: ${this.logDirectory}`;
    for (const adapter of this.adapters) {
      adapter.onConnectionEvent({ seq: 0, type: 'event', event: 'output', body: { category: 'important', output: `${message}\n` } });
    }
  }

  private errorResponse(command: string, requestSeq: number, message: string): Response {
    return { seq: 0, type: 'response', request_seq: requestSeq, command, success: false, message };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function processKill(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}
