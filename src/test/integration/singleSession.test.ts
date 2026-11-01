import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createMiniDapSession } from './miniDapClient';
import { TestConfig } from '../testPaths';

const testConfig = TestConfig.readTestConfig();
const defaultSubject = testConfig.testSubject("stackframes");
const subjectSource = testConfig.file('test/stackframes.cpp');

suite('single mdb session integration', () => {
  for (const transport of ['stdio', 'socket'] as const) {
    test(`runs the initialize, breakpoint, launch, inspect, step, and exit lifecycle (${transport})`, async function () {

      const sourceText = fs.readFileSync(subjectSource, 'utf8');
      const breakpointLine = sourceText.split(/\r?\n/).findIndex((line) => line.includes('// BPLine1')) + 1;
      assert.ok(breakpointLine > 0, 'expected BPLine1 marker in stackframes.cpp');

      const session = createMiniDapSession(
        testConfig,
        { name: 'stackframes', sessionType: 'ptrace', program: defaultSubject, args: [] },
        { transport, timeoutMs: 10000 },
      );
      const { client } = session;
      try {
        await client.initialize();

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

        const threads = await client.threads();
        const stack = await threads[0].stackTrace({startFrame: 0, levels: 1});
        assert.ok(stack.length >= 1);
        const threadId = threads[0].id;
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
        await session.dispose();
      }
    });
  }
});
