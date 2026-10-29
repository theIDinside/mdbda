export interface ProtocolMessage {
	seq: number;
	type: 'request' | 'response' | 'event';
}

export interface Request extends ProtocolMessage {
	type: 'request';
	command: string;
	arguments?: Record<string, unknown>;
}

export interface Response extends ProtocolMessage {
	type: 'response';
	request_seq: number;
	command: string;
	success: boolean;
	message?: string;
	body?: Record<string, unknown>;
}

export interface Event extends ProtocolMessage {
	type: 'event';
	event: string;
	body?: Record<string, unknown>;
	processId?: number;
}

export interface Capabilities extends Record<string, unknown> {
	supportsConditionalBreakpoints?: boolean;
	supportsHitConditionalBreakpoints?: boolean;
	supportsLogPoints?: boolean;
	supportsTerminateThreadsRequest?: boolean;
	supportsStepBack?: boolean;
	supportsSingleThreadExecutionRequests?: boolean;
	exceptionBreakpointFilters?: unknown[];
}

export interface Breakpoint extends Record<string, unknown> {
	id?: number;
	verified: boolean;
	line?: number;
	column?: number;
	message?: string;
	source?: Source;
}

export interface Source extends Record<string, unknown> {
	name?: string;
	path?: string;
}

export type SessionType = 'ptrace' | 'rr';

export const FORWARDED_REQUESTS: ReadonlySet<string> = new Set([
	'initialize', 'launch', 'attach', 'configurationDone', 'setBreakpoints', 'setFunctionBreakpoints',
	'setInstructionBreakpoints', 'threads', 'stackTrace', 'scopes', 'variables', 'evaluate', 'pause', 'continue',
	'next', 'stepIn', 'stepOut', 'reverseContinue', 'disassemble', 'readMemory', 'writeMemory', 'disconnect',
	'terminate', 'customRequest',
]);

export const LOCALLY_ANSWERED: ReadonlySet<string> = new Set(['setExceptionBreakpoints']);

export const CUSTOM_COMMANDS = ['continueAll', 'pauseAll', 'getProcesses'] as const;

export const CONFIG_TOKEN_COMMANDS: ReadonlySet<string> = new Set([
	'initialize', 'launch', 'attach', 'configurationDone', 'setBreakpoints', 'setFunctionBreakpoints',
	'setInstructionBreakpoints',
]);
