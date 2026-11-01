import * as fs from 'fs';
import * as path from 'path';
import { MdbSessionAdapter } from '../../core/sessionAdapter';
import { ProtocolMessage } from '../../core/protocol';
import { PrepareStacktrace } from './testUtils';
import { consoleLogger } from '../../core/logger';

export const defaultMdbPath = '/home/sfarre/dev/dbm/obj/debug/bin/mdb';
export const binaryDirectory = '/home/sfarre/dev/dbm/obj/debug/bin';

export function resolveMdbPath(): string {
	return process.env.MDB_PATH ?? defaultMdbPath;
}

export class Log {
	constructor(private logDirectory: string, private persist: boolean = false) {}

	persistLogs() {
		this.persist = true;
	}

	directory() {
		return this.logDirectory;
	}

	dispose() {
		if(!this.persist) {
			fs.rmSync(this.logDirectory, { recursive: true, force: true });
		} else {
			consoleLogger.warn(`log directory persisted=${this.logDirectory}`);
		}
	}
}

export class MiniDapClient {
	private sequence = 0;
	private readonly waiting: ProtocolMessage[] = [];
	private logsPersisted: boolean = false;
	readonly delivered: ProtocolMessage[] = [];
	private readonly notify: Array<() => void> = [];

	constructor(private readonly adapter: MdbSessionAdapter, private log: Log, private readonly timeoutMs = 15000) {
		adapter.onDidSendMessage((message) => {
			this.waiting.push(message);
			this.delivered.push(message);
			for (const wake of this.notify.splice(0)) {
				wake();
			}
		});
	}

	async request(command: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
		const seq = ++this.sequence;
		this.adapter.handleMessage({ seq, type: 'request', command, arguments: args });
		return this.waitFor((message) => message.type === 'response' && message.request_seq === seq) as Promise<Record<string, any>>;
	}

	persistLogs() {
		this.log.persistLogs();
	}

	waitFor(predicate: (message: ProtocolMessage) => boolean): Promise<ProtocolMessage> {
		const err = PrepareStacktrace('Timed out waiting for DAP message', this.waitFor);
		const find = (): ProtocolMessage | undefined => {
			const index = this.waiting.findIndex(predicate);
			return index < 0 ? undefined : this.waiting.splice(index, 1)[0];
		};
		const current = find();
		if (current) {
			return Promise.resolve(current);
		}
		return new Promise((resolve, reject) => {
			let timer: NodeJS.Timeout;
			const check = (): void => {
				const next = find();
				if (next) {
					clearTimeout(timer);
					resolve(next);
				} else {
					this.notify.push(check);
				}
			};
			timer = setTimeout(() => {
				const index = this.notify.indexOf(check);
				if (index >= 0) {
					this.notify.splice(index, 1);
				}
				this.persistLogs();
				reject(err);
			}, this.timeoutMs);
			this.notify.push(check);
		});
	}
}
