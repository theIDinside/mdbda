import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MdbProcess } from '../../core/mdbProcess';
import { encodeMessage } from '../../core/framing';

suite('MdbProcess', () => {
	let tempDirectory: string;

	setup(() => {
		tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mdbda-'));
	});

	teardown(() => {
		fs.rmSync(tempDirectory, { recursive: true, force: true });
	});

	function createFakeMdb(script: string): string {
		const executable = path.join(tempDirectory, 'fake-mdb');
		fs.writeFileSync(executable, `#!${process.execPath}\n${script}\n`);
		fs.chmodSync(executable, 0o755);
		return executable;
	}

	test('collects stderr lines, delivers stdout messages before exit, and reports exit status', async () => {
		const output = encodeMessage({ type: 'event', event: 'initialized' }).toString('utf8');
		const executable = createFakeMdb(`process.stderr.write('first\\nsecond\\n'); process.stdout.write(${JSON.stringify(output)});`);
		const mdb = new MdbProcess({ path: executable, args: [], logDirectory: path.join(tempDirectory, 'logs') });
		const stderr: string[] = [];
		const order: string[] = [];
		let message: unknown;
		const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
			mdb.on('stderr', (line: string) => stderr.push(line));
			mdb.on('message', (value: unknown) => {
				message = value;
				order.push('message');
			});
			mdb.on('exit', (result) => {
				order.push('exit');
				resolve(result);
			});
		});
		mdb.start();
		const result = await exit;
		assert.deepStrictEqual(stderr, ['first', 'second']);
		assert.deepStrictEqual(message, { type: 'event', event: 'initialized' });
		assert.deepStrictEqual(order, ['message', 'exit']);
		assert.strictEqual(result.code, 0);
	});

	test('emits spawnError for a nonexistent executable', async () => {
		const mdb = new MdbProcess({
			path: path.join(tempDirectory, 'missing-mdb'),
			args: [],
			logDirectory: path.join(tempDirectory, 'logs'),
		});
		const spawnError = new Promise<NodeJS.ErrnoException>((resolve) => mdb.once('spawnError', resolve));
		mdb.start();
		const error = await spawnError;
		assert.strictEqual(error.code, 'ENOENT');
	});

	test('kill resolves when the process is terminated', async () => {
		const executable = createFakeMdb("process.stderr.write('ready\\n'); setInterval(() => undefined, 1000);");
		const mdb = new MdbProcess({ path: executable, args: [], logDirectory: path.join(tempDirectory, 'logs') });
		const ready = new Promise<void>((resolve) => {
			mdb.on('stderr', (line: string) => {
				if (line === 'ready') {
					resolve();
				}
			});
		});
		mdb.start();
		await ready;
		await mdb.kill(100);
	});
});
