import { randomUUID } from 'node:crypto';
import * as path from 'path';
import { MdbConnection, ConnectionAdapter } from './connection';
import { blockedResponse } from './blocked';
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

export interface SessionAdapterOptions {
	sessionType: SessionType;
	isChild: boolean;
	childPid?: number;
	config: Record<string, any>;
}

interface ResponseRewrite {
	originalCommand: string;
	stackTraceArgs?: Record<string, any>;
	breakpoints?: {
		requested: Record<string, any>[];
		mapping: ReadonlyMap<number, number>;
		local: ReadonlyMap<number, Breakpoint>;
	};
}

export class MdbSessionAdapter implements ConnectionAdapter {
	readonly configToken = randomUUID();
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

	constructor(
		private readonly connection: MdbConnection,
		private readonly host: Host,
		opts: SessionAdapterOptions,
	) {
		this.sessionType = opts.sessionType;
		this.isChild = opts.isChild;
		this.childPid = opts.childPid;
		this.config = opts.config;
		this.pid = this.connection.register(this);
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
				this.processes.splice(0, this.processes.length, ...(Array.isArray(response.body.processes)
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
		}
		this.emitMessage({ ...rewritten, seq: ++this.outSeq });
		if (rewrite?.originalCommand === 'continueAll' && response.success) {
			this.emitEvent('continued', { allThreadsContinued: true });
		}
	}

	onConnectionEvent(event: Event): void {
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

		if (this.isChild && (command === 'terminate' || (command === 'disconnect' && args.terminateDebuggee !== false))) {
			await this.stopChild(request);
			return;
		}

		let wireCommand = command;
		let wireArgs: Record<string, any> = { ...args };
		const rewrite: ResponseRewrite = { originalCommand: command };
		if (command === 'initialize') {
			wireArgs = { ...wireArgs, RRSession: this.sessionType === 'rr' };
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
		if (wireCommand !== command || rewrite.stackTraceArgs || rewrite.breakpoints) {
			this.pendingRewrites.set(request.seq, rewrite);
		}
		const forwarded = this.connection.forward(this, wireRequest, processId);
		if (forwarded && !this.isChild && (command === 'disconnect' || command === 'terminate')) {
			this.connection.expectShutdown();
		}
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
