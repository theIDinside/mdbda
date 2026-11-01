import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MdbConnection } from '../../core/connection';
import { Host } from '../../core/host';
import { nullLogger } from '../../core/logger';
import { MdbProcess } from '../../core/mdbProcess';
import { MdbSessionAdapter } from '../../core/sessionAdapter';
import { Log, MiniDapClient } from './miniDapClient';
import { TestConfig } from '../testPaths';

const testConfig = TestConfig.readTestConfig();

const forkSubject = testConfig.testSubject('fork');
const childSubject = testConfig.testSubject('childprogram');
const forkSource = testConfig.file('test/fork.cpp');

suite('mdb fork integration', () => {
  test('attaches each fork child and completes both session lifecycles', async function () {
    const mdbPath = testConfig.mdbPath;
    const log = new Log(testConfig);
    const process = new MdbProcess({ path: mdbPath, args: [], logDirectory: log.directory() });
    const errors: string[] = [];
    let connection!: MdbConnection;
    let childAdapter: MdbSessionAdapter | undefined;
    let childClient: MiniDapClient | undefined;
    let childSequence: Promise<void> | undefined;
    let onProcess!: () => void;
    const processSeen = new Promise<void>((resolve) => { onProcess = resolve; });
    let startChildSession: Host['startChildSession'] = () => undefined;
    const host: Host = {
      logger: nullLogger,
      trace: false,
      showError: (message) => { errors.push(message); },
      startChildSession: (parent, pid, name) => startChildSession(parent, pid, name),
    };
    connection = new MdbConnection(process, log.directory());
    const parentAdapter = new MdbSessionAdapter(connection, host, {
      sessionType: 'ptrace',
      isChild: false,
      config: { name: 'fork', sessionType: 'ptrace', program: forkSubject, args: [childSubject] },
    });
    const parentClient = new MiniDapClient(parentAdapter, log);

    startChildSession = (_parent, childPid) => {
      onProcess();
      childAdapter = new MdbSessionAdapter(connection, host, {
        sessionType: 'ptrace',
        isChild: true,
        childPid,
        config: { name: `fork [fork ${childPid}]`, request: 'attach', processId: childPid },
      });
      childClient = new MiniDapClient(childAdapter, log);
      childSequence = driveChild(childClient);
    };

    async function driveChild(client: MiniDapClient): Promise<void> {
      await client.initialize();
      const attached = await client.request('attach', { processId: 0 });
      assert.strictEqual(attached.success, true);
      const breakpoints = await client.request('setBreakpoints', {
        source: { name: path.basename(forkSource), path: forkSource },
        breakpoints: [],
      });
      assert.strictEqual(breakpoints.success, true);
      const configured = await client.request('configurationDone');
      assert.strictEqual(configured.success, true);
      // mdb stops every exec'd process at main (SupervisorState::HandleExec), so the child has to be resumed
      // for it, and the parent waiting on it, to exit.
      const stopped = await client.waitFor((message) => message.type === 'event' && message.event === 'stopped');
      const resumed = await client.request('continue', { threadId: (stopped as Record<string, any>).body.threadId });
      assert.strictEqual(resumed.success, true);
    }

    try {
      await parentClient.initialize();
      const launched = await parentClient.request('launch', { program: forkSubject, args: [childSubject] });
      assert.strictEqual(launched.success, true);
      const configured = await parentClient.request('configurationDone');
      assert.strictEqual(configured.success, true);

      let processTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          processSeen,
          new Promise<void>((_resolve, reject) => {
            processTimer = setTimeout(() => reject(new Error('no fork process event from mdb')), 15000);
          }),
        ]);
      } finally {
        if (processTimer) {
          clearTimeout(processTimer);
        }
      }
      assert.ok(childSequence, 'the fork event should start the child attach sequence');
      await childSequence;
      assert.ok(childAdapter && childClient, 'the fork event should create its own child session');

      await parentClient.waitFor((message) => message.type === 'event' && message.event === 'exited');
      await parentClient.waitFor((message) => message.type === 'event' && message.event === 'terminated');
      await childClient!.waitFor((message) => message.type === 'event' && message.event === 'exited');
      await childClient!.waitFor((message) => message.type === 'event' && message.event === 'terminated');
      assert.deepStrictEqual(errors, []);
    } finally {
      childAdapter?.dispose();
      parentAdapter.dispose();
      await process.kill(100);
      log.dispose();
    }
  });
});
