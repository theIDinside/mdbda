import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MdbSocketProcess } from '../../core/mdbSocketProcess';

suite('MdbSocketProcess', () => {
	let tempDirectory: string;

	setup(() => {
		tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mdbda-socket-'));
	});

	teardown(() => {
		fs.rmSync(tempDirectory, { recursive: true, force: true });
	});

	function createFakeMdb(delayMs = 0): { executable: string; marker: string } {
		const executable = path.join(tempDirectory, 'fake-mdb');
		const marker = path.join(tempDirectory, 'fake-marker');
		const script = `
const fs = require('fs');
const net = require('net');
const args = process.argv.slice(2);
const socketPath = args[args.indexOf('-i') + 1].slice('unix:'.length);
const marker = process.env.FAKE_MARKER;
const mode = process.env.FAKE_MODE;
const expected = Number(process.env.FAKE_EXPECTED);
fs.writeFileSync(marker + '.socket', socketPath);
if (mode === 'never') {
	process.on('SIGTERM', () => { fs.writeFileSync(marker + '.killed', 'yes'); process.exit(0); });
	setInterval(() => undefined, 1000);
} else {
	const frame = (value) => {
		const json = JSON.stringify(value);
		return 'Content-Length: ' + Buffer.byteLength(json) + '\\r\\n\\r\\n' + json;
	};
	let server;
	setTimeout(() => {
		server = net.createServer((socket) => {
			let buffer = Buffer.alloc(0);
			const received = [];
			const finish = () => {
				fs.writeFileSync(marker + '.received', JSON.stringify(received));
				socket.end(frame({ type: 'event', event: 'final' }), () => server.close(() => process.exit(0)));
			};
			socket.write(frame({ type: 'event', event: 'connected' }));
			if (expected === 0) {
				finish();
			}
			socket.on('data', (chunk) => {
				buffer = Buffer.concat([buffer, chunk]);
				while (true) {
					const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
					if (headerEnd < 0) {
						return;
					}
					const match = /Content-Length: (\\d+)/i.exec(buffer.subarray(0, headerEnd).toString());
					if (!match) {
						return;
					}
					const length = Number(match[1]);
					if (buffer.length < headerEnd + 4 + length) {
						return;
					}
					received.push(JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString()));
					buffer = buffer.subarray(headerEnd + 4 + length);
					fs.writeFileSync(marker + '.received', JSON.stringify(received));
					if (received.length === expected) {
						finish();
					}
				}
			});
		});
		server.listen(socketPath);
	}, ${delayMs});
}
`;
		fs.writeFileSync(executable, `#!${process.execPath}\n${script}\n`);
		fs.chmodSync(executable, 0o755);
		return { executable, marker };
	}

	function createProcess(fake: { executable: string; marker: string }, mode: string, expected: number, connectTimeoutMs = 2000): MdbSocketProcess {
		return new MdbSocketProcess({
			path: fake.executable,
			args: [],
			logDirectory: path.join(tempDirectory, 'logs'),
			connectTimeoutMs,
			env: { ...process.env, FAKE_MARKER: fake.marker, FAKE_MODE: mode, FAKE_EXPECTED: String(expected) },
		});
	}

	function waitForFile(file: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const deadline = Date.now() + 3000;
			const poll = (): void => {
				if (fs.existsSync(file)) {
					resolve();
				} else if (Date.now() >= deadline) {
					reject(new Error(`Timed out waiting for ${file}`));
				} else {
					setTimeout(poll, 10);
				}
			};
			poll();
		});
	}

	test('exchanges framed messages in both directions', async () => {
		const fake = createFakeMdb();
		const mdb = createProcess(fake, 'normal', 1);
		const messages: unknown[] = [];
		const exit = new Promise<void>((resolve) => {
			mdb.on('message', (message: unknown) => messages.push(message));
			mdb.once('exit', resolve);
		});
		mdb.start();
		mdb.send({ type: 'request', command: 'test', seq: 1 });
		await exit;
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(fake.marker + '.received', 'utf8')), [
			{ type: 'request', command: 'test', seq: 1 },
		]);
		assert.deepStrictEqual(messages, [
			{ type: 'event', event: 'connected' },
			{ type: 'event', event: 'final' },
		]);
	});

	test('queues messages sent before the fake listens and preserves their order', async () => {
		const fake = createFakeMdb(200);
		const mdb = createProcess(fake, 'normal', 2);
		const exit = new Promise<void>((resolve) => mdb.once('exit', resolve));
		mdb.start();
		mdb.send({ seq: 1 });
		mdb.send({ seq: 2 });
		await exit;
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(fake.marker + '.received', 'utf8')), [{ seq: 1 }, { seq: 2 }]);
	});

	test('emits stdout and stderr lines', async () => {
		const fake = createFakeMdb();
		const script = fs.readFileSync(fake.executable, 'utf8').replace("const marker = process.env.FAKE_MARKER;", "const marker = process.env.FAKE_MARKER;\nprocess.stdout.write('out one\\nout two\\n');\nprocess.stderr.write('err one\\n');");
		fs.writeFileSync(fake.executable, script);
		const mdb = createProcess(fake, 'normal', 0);
		const stdout: string[] = [];
		const stderr: string[] = [];
		const exit = new Promise<void>((resolve) => {
			mdb.on('stdout', (line: string) => stdout.push(line));
			mdb.on('stderr', (line: string) => stderr.push(line));
			mdb.once('exit', resolve);
		});
		mdb.start();
		await exit;
		assert.deepStrictEqual(stdout, ['out one', 'out two']);
		assert.deepStrictEqual(stderr, ['err one']);
	});

	test('delivers the final socket message before exit', async () => {
		const fake = createFakeMdb();
		const mdb = createProcess(fake, 'normal', 0);
		const order: string[] = [];
		const exit = new Promise<void>((resolve) => {
			mdb.on('message', () => order.push('message'));
			mdb.once('exit', () => { order.push('exit'); resolve(); });
		});
		mdb.start();
		await exit;
		assert.deepStrictEqual(order, ['message', 'message', 'exit']);
	});

	test('reports a connection timeout and kills a fake that never listens', async () => {
		const fake = createFakeMdb();
		const mdb = createProcess(fake, 'never', 0, 250);
		const spawnError = new Promise<Error>((resolve) => mdb.once('spawnError', resolve));
		const exit = new Promise<void>((resolve) => mdb.once('exit', resolve));
		mdb.start();
		const error = await spawnError;
		assert.match(error.message, /mdb did not accept a connection/);
		await exit;
		await waitForFile(fake.marker + '.killed');
	});

	test('removes the socket file after exit', async () => {
		const fake = createFakeMdb();
		const mdb = createProcess(fake, 'normal', 0);
		const exit = new Promise<void>((resolve) => mdb.once('exit', resolve));
		mdb.start();
		await waitForFile(fake.marker + '.socket');
		await exit;
		const socketPath = fs.readFileSync(fake.marker + '.socket', 'utf8');
		assert.strictEqual(fs.existsSync(socketPath), false);
	});
});
