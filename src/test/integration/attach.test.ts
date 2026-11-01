import * as assert from 'assert';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MdbConnection } from '../../core/connection';
import { Host } from '../../core/host';
import { nullLogger } from '../../core/logger';
import { MdbSocketProcess } from '../../core/mdbSocketProcess';
import { MdbSessionAdapter } from '../../core/sessionAdapter';
import { ShimConnection, ShimHello, ShimListener } from '../../core/shimListener';
import { TestConfig } from '../testPaths';
import { Log, MiniDapClient } from './miniDapClient';

const testConfig = TestConfig.readTestConfig();

/** Resolves with the first shim that connects to `listener` and sends a valid hello. */
function nextShimHello(listener: ShimListener, timeoutMs: number): Promise<{ connection: ShimConnection; hello: ShimHello }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listener.off('connection', onConnection);
      reject(new Error(`Timed out after ${timeoutMs} ms waiting for shim hello`));
    }, timeoutMs);
    const onConnection = (connection: ShimConnection): void => {
      connection.once('hello', (hello: ShimHello) => {
        clearTimeout(timer);
        listener.off('connection', onConnection);
        resolve({ connection, hello });
      });
    };
    listener.on('connection', onConnection);
  });
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
      runInTerminal: () => { throw new Error('runInTerminal is not used by this test'); },
    };
    const adapters: MdbSessionAdapter[] = [];
    try {
      assert.ok(mdb.pid, 'mdb must have a tracer pid');
      for (let run = 1; run <= 2; run++) {
        const socketDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mdbda-shim-'));
        const socketPath = path.join(socketDirectory, 'handoff.sock');
        const listener = new ShimListener();
        await listener.listen(socketPath);
        const helloReceived = nextShimHello(listener, 10000);
        const shim: ChildProcessWithoutNullStreams = spawn(shimPath, [
          '--tracer-pid', String(mdb.pid), '--socket', socketPath, '--', subject,
        ]);
        const shimClosed = new Promise<void>((resolve) => shim.once('close', () => resolve()));
        // Drain output and handle a possible pipe closure during failure cleanup.
        shim.stdout.resume();
        shim.stderr.resume();
        shim.stdin.on('error', (error) => { errors.push(error.message); });
        try {
          const { connection: shimConnection, hello } = await helloReceived;
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

          shimConnection.go();
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
