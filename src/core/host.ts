import { Logger } from './logger';
import type { MdbSessionAdapter } from './sessionAdapter';

export interface RunInTerminalOptions {
	name: string;
	program: string;
	args: string[];
	cwd?: string;
	env?: Record<string, string>;
}

export interface TerminalRun {
	/** Called once, when the program exits or its terminal is closed. */
	onExit(listener: (exitCode: number | undefined) => void): void;
	kill(): void;
}

export interface Host {
	startChildSession(parent: MdbSessionAdapter, childPid: number, name: string): void;
	runInTerminal(options: RunInTerminalOptions): TerminalRun;
	logger: Logger;
	showError(message: string): void;
	trace: boolean;
}
