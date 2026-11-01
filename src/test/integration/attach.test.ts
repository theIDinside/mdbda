import * as assert from 'assert';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { MdbConnection } from '../../core/connection';
import { Host } from '../../core/host';
import { nullLogger } from '../../core/logger';
import { MdbSocketProcess } from '../../core/mdbSocketProcess';
import { MdbSessionAdapter } from '../../core/sessionAdapter';
import { TestConfig } from '../testPaths';
import { Log, MiniDapClient } from './miniDapClient';

const testConfig = TestConfig.readTestConfig();

const shimMagic = Buffer.from([0x4d, 0x44, 0x42, 0x53, 0x48, 0x49, 0x4d, 0x00]);
const shimHeaderSize = 16;
const maxShimPayload = 1024 * 1024;

interface ShimHello {
  pid: number;
  argv: string[];
}

function parseShimHello(payload: Buffer): ShimHello {
  if (payload.length < 8) {
    throw new Error('Shim hello payload is truncated');
  }
  const pid = payload.readUInt32BE(0);
  const argumentCount = payload.readUInt32BE(4);
  if (pid === 0 || argumentCount === 0 || argumentCount > 4096) {
    throw new Error('Shim hello has invalid pid/argc');
  }
  let offset = 8;
  const argv: string[] = [];
  for (let index = 0; index < argumentCount; index++) {
    if (offset + 4 > payload.length) {
      throw new Error('Shim hello argument length is truncated');
    }
    const length = payload.readUInt32BE(offset);
    offset += 4;
    if (offset + length > payload.length) {
      throw new Error('Shim hello argument is truncated');
    }
    argv.push(payload.subarray(offset, offset + length).toString('utf8'));
    offset += length;
  }
  if (offset !== payload.length) {
    throw new Error('Shim hello has trailing data');
  }
  return { pid, argv };
}

function shimFrame(type: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(shimHeaderSize);
  shimMagic.copy(header, 0);
  header.writeUInt16BE(1, 8);
  header[10] = type;
  header.writeUInt32BE(payload.length, 12);
  return Buffer.concat([header, payload]);
}

class ShimListener {
  private readonly server = net.createServer((socket) => this.onConnection(socket));
  private socket: net.Socket | undefined;
  private buffer = Buffer.alloc(0);
  private hello: ShimHello | undefined;
  private helloWaiter: { resolve: (value: ShimHello) => void; reject: (error: Error) => void } | undefined;

  constructor() {
    this.server.on('error', (error) => this.rejectHello(error));
  }

  listen(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(socketPath, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
  }

  waitForHello(timeoutMs: number): Promise<ShimHello> {
    if (this.hello) {
      return Promise.resolve(this.hello);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Timed out after ${timeoutMs} ms waiting for shim hello`)), timeoutMs);
      const finish = (error: Error | undefined, value?: ShimHello): void => {
        clearTimeout(timer);
        this.helloWaiter = undefined;
        if (error) {
          reject(error);
        } else {
          resolve(value!);
        }
      };
      this.helloWaiter = {
        resolve: (value) => finish(undefined, value),
        reject: (error) => finish(error),
      };
    });
  }

  private onConnection(socket: net.Socket): void {
    if (this.socket) {
      socket.destroy();
      return;
    }
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (error) => this.rejectHello(error));
    socket.on('close', () => {
      if (!this.hello) {
        this.rejectHello(new Error('Shim disconnected before hello'));
      }
    });
  }

  private onData(chunk: Buffer): void {
    if (this.buffer.length + chunk.length > shimHeaderSize + maxShimPayload) {
      this.rejectHello(new Error('Shim hello exceeds the payload limit'));
      this.socket?.destroy();
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length < shimHeaderSize) {
      return;
    }
    const header = this.buffer.subarray(0, shimHeaderSize);
    if (!header.subarray(0, 8).equals(shimMagic) || header.readUInt16BE(8) !== 1 || header[10] !== 1 || header[11] !== 0) {
      this.rejectHello(new Error('Invalid shim hello header'));
      this.socket?.destroy();
      return;
    }
    const payloadLength = header.readUInt32BE(12);
    if (payloadLength > maxShimPayload) {
      this.rejectHello(new Error('Shim hello exceeds the payload limit'));
      this.socket?.destroy();
      return;
    }
    if (this.buffer.length < shimHeaderSize + payloadLength) {
      return;
    }
    if (this.buffer.length !== shimHeaderSize + payloadLength) {
      this.rejectHello(new Error('Shim sent unexpected data after hello'));
      this.socket?.destroy();
      return;
    }
    try {
      this.hello = parseShimHello(this.buffer.subarray(shimHeaderSize));
      this.helloWaiter?.resolve(this.hello);
    } catch (error) {
      this.rejectHello(error instanceof Error ? error : new Error(String(error)));
      this.socket?.destroy();
    }
  }

  private rejectHello(error: Error): void {
    this.helloWaiter?.reject(error);
  }

  go(): void {
    assert.ok(this.socket && !this.socket.destroyed, 'shim socket must be connected');
    this.socket.write(shimFrame(2));
  }

  async close(): Promise<void> {
    this.socket?.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

suite('mdb shim attach integration', () => {
  test('attaches two shims over a Unix socket and reuses symbols in one persistent mdb', async function () {
    this.timeout(40000);
    const shimPath = testConfig.testSubject('mdb_shim');
    const subject = testConfig.testSubject('stackframes');
    const source = testConfig.file('test/stackframes.cpp');
    const line = fs.readFileSync(source, 'utf8').split(/\r?\n/)
      .findIndex((text) => text.includes('// BPLine1')) + 1;
    assert.ok(line > 0, 'expected BPLine1 marker in stackframes.cpp');

    const log = new Log(testConfig);
    const mdb = new MdbSocketProcess({
      path: testConfig.mdbPath, args: ['--keep-alive'], logDirectory: log.directory(), threads: 4,
    });
    let mdbExited = false;
    mdb.on('exit', () => { mdbExited = true; });
    const connection = new MdbConnection(mdb, log.directory());
    const errors: string[] = [];
    const host: Host = {
      logger: nullLogger,
      trace: false,
      showError: (message) => { errors.push(message); },
      startChildSession: () => assert.fail('stackframes should not fork'),
    };
    const adapters: MdbSessionAdapter[] = [];
    try {
      assert.ok(mdb.pid, 'mdb must have a tracer pid');
      for (let run = 1; run <= 2; run++) {
        const socketDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mdbda-shim-'));
        const socketPath = path.join(socketDirectory, 'handoff.sock');
        const listener = new ShimListener();
        await listener.listen(socketPath);
        const shim: ChildProcessWithoutNullStreams = spawn(shimPath, [
          '--tracer-pid', String(mdb.pid), '--socket', socketPath, '--', subject,
        ]);
        const shimClosed = new Promise<void>((resolve) => shim.once('close', () => resolve()));
        // Drain output and handle a possible pipe closure during failure cleanup.
        shim.stdout.resume();
        shim.stderr.resume();
        shim.stdin.on('error', (error) => { errors.push(error.message); });
        try {
          const hello = await listener.waitForHello(10000);
          const pid = hello.pid;
          assert.strictEqual(hello.argv[0], subject, 'shim must report the target executable');
          assert.strictEqual(pid, shim.pid, 'the shim must exec the subject in the same process');
          const adapter = new MdbSessionAdapter(connection, host, {
            sessionType: 'ptrace', isChild: true, childPid: pid,
            config: { name: `shim run ${run}`, request: 'attach', processId: pid },
          });
          // Keep sessions registered until teardown: unregistering the last adapter closes the connection.
          adapters.push(adapter);
          const client = new MiniDapClient(adapter, log, 10000);
          await client.initialize();
          const attached = await client.request('attach', { processId: pid });
          assert.strictEqual(attached.success, true, attached.message);
          assert.strictEqual(adapter.pid, pid);
          const breakpoints = await client.request('setBreakpoints', {
            source: { name: path.basename(source), path: source }, breakpoints: [{ line }],
          });
          assert.strictEqual(breakpoints.success, true, breakpoints.message);
          assert.strictEqual(breakpoints.body.breakpoints.length, 1);
          const configured = await client.request('configurationDone');
          assert.strictEqual(configured.success, true, configured.message);

          listener.go();
          const breakpointStop = await client.waitFor((message) => message.type === 'event'
            && message.event === 'stopped' && (message.body as { reason?: string })?.reason === 'breakpoint');
          const threadId = (breakpointStop.body as { threadId: number }).threadId;
          assert.ok(threadId > 0, 'breakpoint stop must identify a thread');
          const frames = await client.stackTrace(threadId, { levels: 1 });
          assert.strictEqual(frames[0].line, line);
          const continued = await client.request('continue', { threadId });
          assert.strictEqual(continued.success, true, continued.message);
          const exited = await client.waitFor((message) => message.type === 'event' && message.event === 'exited');
          // stackframes returns -15, which the OS exposes as an unsigned byte.
          assert.strictEqual((exited.body as { exitCode: number }).exitCode, 241);
          await client.waitFor((message) => message.type === 'event' && message.event === 'terminated');
          await shimClosed;
          assert.strictEqual(shim.exitCode, 241, 'the shim must preserve the exec target exit status');
          assert.strictEqual(mdbExited, false, `mdb must survive attach run ${run}`);
          process.kill(mdb.pid, 0);
        } finally {
          shim.stdin.end();
          if (shim.exitCode === null && shim.signalCode === null) {
            shim.kill('SIGKILL');
          }
          await shimClosed;
          await listener.close();
          fs.rmSync(socketDirectory, { recursive: true, force: true });
        }
      }
      const parseCount = fs.readFileSync(path.join(log.directory(), 'core.log'), 'utf8').split(/\r?\n/)
        .filter((text) => text.includes('Parsing objfile') && text.includes('stackframes')).length;
      assert.strictEqual(parseCount, 1, 'both attaches must share the cached stackframes object file');
      assert.deepStrictEqual(errors, []);
    } catch (error) {
      log.persistLogs();
      throw error;
    } finally {
      for (const adapter of adapters) {
        adapter.dispose();
      }
      await mdb.kill(100);
      log.dispose();
    }
  });
});
