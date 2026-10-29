import * as assert from 'assert';
import { EventEmitter } from 'events';
import { MdbConnection } from '../../core/connection';
import { Host } from '../../core/host';
import { nullLogger } from '../../core/logger';
import { MdbSessionAdapter } from '../../core/sessionAdapter';

class FakeMdbProcess extends EventEmitter {
	readonly sent: Record<string, any>[] = [];

	start(): void {}

	send(message: unknown): void {
		this.sent.push(message as Record<string, any>);
	}

	async kill(): Promise<void> {}

	respond(request: Record<string, any>, body?: Record<string, unknown>): void {
		this.emit('message', {
			seq: 0, type: 'response', request_seq: request.seq, command: request.command, success: true,
			...(body ? { body } : {}),
		});
	}
}

const host: Host = {
	logger: nullLogger,
	trace: false,
	showError: () => undefined,
	startChildSession: () => undefined,
};

suite('rr session adapter', () => {
	test('tracks replay processes, switches selected pid, and routes later requests to it', () => {
		const process = new FakeMdbProcess();
		const connection = new MdbConnection(process, '/tmp/mdb-rr-logs');
		const adapter = new MdbSessionAdapter(connection, host, {
			sessionType: 'rr',
			isChild: false,
			config: { name: 'replay', sessionType: 'rr', traceDir: '/tmp/trace' },
		});
		const messages: Record<string, any>[] = [];
		adapter.onDidSendMessage((message) => messages.push(message as Record<string, any>));

		adapter.handleMessage({ seq: 1, type: 'request', command: 'initialize' });
		assert.strictEqual(process.sent[0].arguments.RRSession, true);
		assert.strictEqual(typeof process.sent[0].arguments.configToken, 'string');
		process.respond(process.sent[0], {});

		adapter.handleMessage({ seq: 2, type: 'request', command: 'launch' });
		assert.strictEqual(process.sent[1].arguments.type, 'rr');
		assert.strictEqual(process.sent[1].arguments.traceDir, '/tmp/trace');
		process.respond(process.sent[1], { processId: 42, processes: [42, 43] });
		assert.deepStrictEqual(adapter.processes, [42, 43]);
		assert.strictEqual(adapter.selectedPid, 42);

		process.emit('message', {
			seq: 0, type: 'event', processId: 42, event: 'stopped', body: { reason: 'step', processes: [42, 43] },
		});
		assert.deepStrictEqual(adapter.processes, [42, 43]);
		adapter.selectProcess(43);
		assert.strictEqual(messages[messages.length - 1].event, 'invalidated');

		adapter.handleMessage({ seq: 3, type: 'request', command: 'threads' });
		assert.strictEqual(process.sent[2].processId, 43);
		process.respond(process.sent[2], { threads: [] });

		process.emit('message', {
			seq: 0, type: 'event', processId: 42, event: 'stopped', body: { reason: 'step', processes: [42] },
		});
		assert.deepStrictEqual(adapter.processes, [42]);
		assert.strictEqual(adapter.selectedPid, 42);
		assert.strictEqual(messages[messages.length - 2].event, 'invalidated');

		adapter.handleMessage({ seq: 4, type: 'request', command: 'threads' });
		assert.strictEqual(process.sent[3].processId, 42);
		adapter.dispose();
	});
});
