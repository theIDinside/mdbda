import { Logger } from './logger';
import type { MdbSessionAdapter } from './sessionAdapter';

export interface Host {
	startChildSession(parent: MdbSessionAdapter, childPid: number, name: string): void;
	logger: Logger;
	showError(message: string): void;
	trace: boolean;
}
