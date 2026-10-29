import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MdbConnection } from '../../core/connection';
import { Host } from '../../core/host';
import { nullLogger } from '../../core/logger';
import { MdbProcess } from '../../core/mdbProcess';
import { MdbSessionAdapter } from '../../core/sessionAdapter';
import { ProtocolMessage } from '../../core/protocol';

const defaultMdbPath = '/home/sfarre/dev/dbm/obj/debug/bin/mdb';
const defaultSubject = '/home/sfarre/dev/dbm/obj/debug/bin/stackframes';
const subjectSource = '/home/sfarre/dev/dbm/test/stackframes.cpp';

class MiniDapClient {
	private sequence = 0;
	private readonly waiting: ProtocolMessage[] = [];
	readonly delivered: ProtocolMessage[] = [];
	private readonly notify: Array<() => void> = [];

	constructor(private readonly adapter: MdbSessionAdapter) {
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

	waitFor(predicate: (message: ProtocolMessage) => boolean, timeoutMs = 10000): Promise<ProtocolMessage> {
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
				reject(new Error('Timed out waiting for DAP message'));
			}, timeoutMs);
			this.notify.push(check);
		});
	}
}

function createHost(): Host {
	return {
		logger: nullLogger,
		trace: false,
		showError: (message) => { throw new Error(message); },
		startChildSession: () => undefined,
	};
}

suite('single mdb session integration', () => {
	test('runs the initialize, breakpoint, launch, inspect, step, and exit lifecycle', async function () {
		const mdbPath = process.env.MDB_PATH ?? defaultMdbPath;
		if (!fs.existsSync(mdbPath) || !fs.existsSync(defaultSubject) || !fs.existsSync(subjectSource)) {
			this.skip();
		}
		const sourceText = fs.readFileSync(subjectSource, 'utf8');
		const breakpointLine = sourceText.split(/\r?\n/).findIndex((line) => line.includes('// BPLine1')) + 1;
		assert.ok(breakpointLine > 0, 'expected BPLine1 marker in stackframes.cpp');

		const logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mdbda-integration-'));
		const process = new MdbProcess({ path: mdbPath, args: [], logDirectory });
		const connection = new MdbConnection(process, logDirectory);
		const adapter = new MdbSessionAdapter(connection, createHost(), {
			sessionType: 'ptrace',
			isChild: false,
			config: { name: 'stackframes', sessionType: 'ptrace', program: defaultSubject, args: [] },
		});
		const client = new MiniDapClient(adapter);
		try {
			const initialize = await client.request('initialize', { adapterID: 'mdbda' });
			assert.strictEqual(initialize.success, true);
			await client.waitFor((message) => message.type === 'event' && message.event === 'initialized');

			const setBreakpoints = await client.request('setBreakpoints', {
				source: { name: path.basename(subjectSource), path: subjectSource },
				breakpoints: [{ line: breakpointLine }],
			});
			assert.strictEqual(setBreakpoints.success, true);
			assert.strictEqual(setBreakpoints.body.breakpoints.length, 1);

			const launch = await client.request('launch', { program: defaultSubject, sessionType: 'ptrace' });
			assert.strictEqual(launch.success, true);
			const configured = await client.request('configurationDone');
			assert.strictEqual(configured.success, true);

			const stopped = await client.waitFor((message) => message.type === 'event' && message.event === 'stopped');
			assert.strictEqual(stopped.type, 'event');
			const threads = await client.request('threads');
			assert.strictEqual(threads.success, true);
			const threadId = threads.body.threads[0].id;
			const stack = await client.request('stackTrace', { threadId, startFrame: 0, levels: 1 });
			assert.strictEqual(stack.success, true);
			assert.strictEqual(stack.body.stackFrames.length, 1);
			assert.ok(stack.body.totalFrames >= 1);
			const scopes = await client.request('scopes', { frameId: stack.body.stackFrames[0].id });
			assert.strictEqual(scopes.success, true);
			const variablesReference = scopes.body.scopes.find((scope: Record<string, any>) => scope.variablesReference > 0).variablesReference;
			const variables = await client.request('variables', { variablesReference });
			assert.strictEqual(variables.success, true);
			const next = await client.request('next', { threadId, granularity: 'statement' });
			assert.strictEqual(next.success, true);
			await client.waitFor((message) => message.type === 'event' && message.event === 'stopped');
			const continued = await client.request('continue', { threadId });
			assert.strictEqual(continued.success, true);
			await client.waitFor((message) => message.type === 'event' && message.event === 'exited');
			await client.waitFor((message) => message.type === 'event' && message.event === 'terminated');

			let previousSeq = 0;
			for (const message of client.delivered) {
				assert.ok(!('processId' in message), 'client message leaked mdb processId');
				assert.ok(message.seq > previousSeq, 'client DAP sequence numbers must increase');
				previousSeq = message.seq;
			}
		} finally {
			adapter.dispose();
			await process.kill(100);
			fs.rmSync(logDirectory, { recursive: true, force: true });
		}
	});
});
