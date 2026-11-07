import * as assert from 'assert';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MdbConnection } from '../../core/connection';
import { Host, RunInTerminalOptions } from '../../core/host';
import { nullLogger } from '../../core/logger';
import { MdbSocketProcess } from '../../core/mdbSocketProcess';
import { MdbSessionAdapter } from '../../core/sessionAdapter';
import { TestConfig } from '../testPaths';
import { Log, MiniDapClient } from './miniDapClient';

const testConfig = TestConfig.readTestConfig();

// A stand-in for a test harness such as `mach wpt --debugger=… --debugger-args=…`: it runs the subject under the
// debugger once per run, one after another, and prints each exit status.
const fakeHarness = `
const { spawnSync } = require('child_process');
const [subject, runs, ...rest] = process.argv.slice(2);
const debuggerPath = rest.find((arg) => arg.startsWith('--debugger=')).slice('--debugger='.length);
const debuggerArgs = rest.find((arg) => arg.startsWith('--debugger-args=')).slice('--debugger-args='.length);
function shellSplit(text) {
  const words = [];
  let word = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      word = (word ?? '') + text.slice(i + 1, end);
      i = end;
    } else if (c === ' ') {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? '') + c;
    }
  }
  if (word !== null) words.push(word);
  return words;
}
for (let run = 0; run < Number(runs); run++) {
  const result = spawnSync(debuggerPath, [...shellSplit(debuggerArgs), subject], { stdio: ['ignore', 'ignore', 'inherit'] });
  console.log(JSON.stringify({ status: result.status }));
}
`;

suite('mdb shim runs integration', () => {
  test('one session attaches to each process a command starts and replays its breakpoints', async function () {
    this.timeout(60000);
    const subject = testConfig.testSubject('stackframes');
    const shimPath = testConfig.testSubject('mdb_shim');
    const source = testConfig.file('test/stackframes.cpp');
    const line = fs.readFileSync(source, 'utf8').split(/\r?\n/)
      .findIndex((text) => text.includes('// BPLine1')) + 1;
    assert.ok(line > 0, 'expected BPLine1 marker in stackframes.cpp');

    const viewFile = testConfig.file('test/views/stl.mdbv');
    const log = new Log(testConfig);
    const harnessDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mdbda-harness-'));
    const harnessPath = path.join(harnessDirectory, 'harness.js');
    fs.writeFileSync(harnessPath, fakeHarness);

    const mdb = new MdbSocketProcess({
      path: testConfig.mdbPath, args: ['--keep-alive'], logDirectory: log.directory(), threads: 4,
    });
    let mdbExited = false;
    mdb.on('exit', () => { mdbExited = true; });
    const connection = new MdbConnection(mdb, log.directory());

    let harness: ChildProcess | undefined;
    let harnessArgs: string[] = [];
    let harnessOutput = '';
    let onHarnessExit!: (code: number | undefined) => void;
    const harnessExited = new Promise<number | undefined>((resolve) => { onHarnessExit = resolve; });
    const errors: string[] = [];
    const host: Host = {
      logger: nullLogger,
      trace: false,
      showError: (message) => { errors.push(message); },
      startChildSession: () => assert.fail('stackframes should not fork'),
      runInTerminal: (options: RunInTerminalOptions) => {
        harnessArgs = options.args;
        harness = spawn(options.program, options.args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        harness.stdout?.on('data', (chunk: Buffer) => { harnessOutput += chunk.toString(); });
        harness.stderr?.resume();
        const exited = new Promise<number | undefined>((done) => harness!.once('close', (code) => done(code ?? undefined)));
        void exited.then(onHarnessExit);
        return {
          onExit: (listener) => { void exited.then(listener); },
          kill: () => { harness?.kill(); },
        };
      },
    };
    const adapter = new MdbSessionAdapter(connection, host, {
      sessionType: 'ptrace',
      isChild: false,
      config: { name: 'harness', request: 'launch', program: process.execPath, views: [viewFile] },
      shimRuns: {
        name: 'harness',
        program: process.execPath,
        args: [harnessPath, subject, '2'],
        cwd: harnessDirectory,
        childDebuggerArgs: ['--debugger={shimPath}', '--debugger-args={shimArgs}', '--debugger-interactive'],
        shimPath,
      },
    });
    const client = new MiniDapClient(adapter, log, 20000);
    try {
      await client.initialize();
      const launched = await client.request('launch', {});
      assert.strictEqual(launched.success, true, launched.message);
      const breakpoints = await client.request('setBreakpoints', {
        source: { name: path.basename(source), path: source }, breakpoints: [{ line }],
      });
      assert.strictEqual(breakpoints.success, true, breakpoints.message);
      const [requested] = breakpoints.body.breakpoints as Array<{ id: number; verified: boolean }>;
      assert.strictEqual(requested.verified, false, 'no process is attached yet');
      const configured = await client.request('configurationDone');
      assert.strictEqual(configured.success, true, configured.message);

      for (let run = 1; run <= 2; run++) {
        const stop = await client.waitFor((message) => message.type === 'event' && message.event === 'stopped'
          && (message.body as { reason?: string })?.reason === 'breakpoint');
        const body = stop.body as { threadId: number; hitBreakpointIds?: number[] };
        assert.deepStrictEqual(body.hitBreakpointIds, [requested.id], `run ${run} must report the adapter's id`);
        const frames = await client.stackTrace(body.threadId, { levels: 1 });
        assert.strictEqual(frames[0].line, line);

        if (run === 1) {
          // A second shim while one process is being debugged is refused, and does not run its program.
          const shimArgs = harnessArgs.find((arg) => arg.startsWith('--debugger-args='))!
            .slice('--debugger-args='.length).split(' ');
          const refused = spawn(shimPath, [...shimArgs, subject], { stdio: ['ignore', 'ignore', 'pipe'] });
          let refusedError = '';
          refused.stderr.on('data', (chunk: Buffer) => { refusedError += chunk.toString(); });
          const refusedStatus = await new Promise<number | null>((resolve) => refused.once('close', resolve));
          assert.strictEqual(refusedStatus, 1);
          assert.match(refusedError, /already debugging another process/);
        }

        const continued = await client.request('continue', { threadId: body.threadId });
        assert.strictEqual(continued.success, true, continued.message);
        assert.strictEqual(mdbExited, false, `mdb must survive run ${run}`);
      }

      assert.strictEqual(await harnessExited, 0);
      await client.waitFor((message) => message.type === 'event' && message.event === 'terminated');
      // stackframes returns -15, which the OS exposes as an unsigned byte.
      assert.deepStrictEqual(harnessOutput.trim().split('\n').map((text) => JSON.parse(text).status), [241, 241]);
      assert.strictEqual(client.delivered.filter((message) => message.type === 'event'
        && message.event === 'terminated').length, 1, 'the session must only terminate when the harness exits');

      const socketArgs = harnessArgs.find((arg) => arg.startsWith('--debugger-args='))!;
      const socketPath = socketArgs.split(' ')[3];
      assert.strictEqual(fs.existsSync(path.dirname(socketPath)), false, 'the shim socket directory must be removed');

      const coreLog = fs.readFileSync(path.join(log.directory(), 'core.log'), 'utf8').split(/\r?\n/);
      assert.ok(coreLog.some((text) => text.includes(`Loaded view file ${viewFile}`)), 'attach must load the session views');
      const parseCount = coreLog
        .filter((text) => text.includes('Parsing objfile') && text.includes('stackframes')).length;
      assert.strictEqual(parseCount, 1, 'both processes must share the cached stackframes object file');
      assert.deepStrictEqual(errors, []);
    } catch (error) {
      log.persistLogs();
      throw error;
    } finally {
      adapter.dispose();
      harness?.kill('SIGKILL');
      await mdb.kill(100);
      fs.rmSync(harnessDirectory, { recursive: true, force: true });
      log.dispose();
    }
  });
});
