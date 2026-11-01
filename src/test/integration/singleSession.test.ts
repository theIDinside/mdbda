import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MdbConnection } from '../../core/connection';
import { Host } from '../../core/host';
import { nullLogger } from '../../core/logger';
import { MdbProcess } from '../../core/mdbProcess';
import { MdbSocketProcess } from '../../core/mdbSocketProcess';
import { MdbSessionAdapter } from '../../core/sessionAdapter';
import { MiniDapClient, binaryDirectory, resolveMdbPath, Log } from './miniDapClient';

const defaultSubject = path.join(binaryDirectory, 'stackframes');
const subjectSource = '/home/sfarre/dev/dbm/test/stackframes.cpp';

function createHost(): Host {
	return {
		logger: nullLogger,
		trace: false,
		showError: (message) => { throw new Error(message); },
		startChildSession: () => undefined,
	};
}

suite('single mdb session integration', () => {
	for (const transport of ['stdio', 'socket'] as const) {
		test(`runs the initialize, breakpoint, launch, inspect, step, and exit lifecycle (${transport})`, async function () {
			const mdbPath = resolveMdbPath();
			if (!fs.existsSync(mdbPath) || !fs.existsSync(defaultSubject) || !fs.existsSync(subjectSource)) {
				this.skip();
			}
			const sourceText = fs.readFileSync(subjectSource, 'utf8');
			const breakpointLine = sourceText.split(/\r?\n/).findIndex((line) => line.includes('// BPLine1')) + 1;
			assert.ok(breakpointLine > 0, 'expected BPLine1 marker in stackframes.cpp');

			const log = new Log(fs.mkdtempSync(path.join(os.tmpdir(), 'mdbda-integration-')));
			const processOptions = { path: mdbPath, args: [], logDirectory: log.directory() };
			const process = transport === 'socket'
				? new MdbSocketProcess(processOptions)
				: new MdbProcess(processOptions);
			const connection = new MdbConnection(process, log.directory());
			const adapter = new MdbSessionAdapter(connection, createHost(), {
				sessionType: 'ptrace',
				isChild: false,
				config: { name: 'stackframes', sessionType: 'ptrace', program: defaultSubject, args: [] },
			});
			const client = new MiniDapClient(adapter, log, 10000);
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
				log.dispose();
			}
		});
	}
});
