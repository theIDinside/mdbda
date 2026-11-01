import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createMiniDapSession, RequestedVariable, Scope } from './miniDapClient';
import { TestConfig } from '../testPaths';
import { consoleLogger } from '../../core/logger';

const testConfig = TestConfig.readTestConfig();
const testSubject = testConfig.testSubject('stl');
const sourceFile = testConfig.file('test/stl.cpp');
const viewsFile = testConfig.file('test/views/stl.mdbv');

type DapVariable = Record<string, any>;

function expectValue(variables: RequestedVariable[], name: string, expected: string): RequestedVariable {
  const variable = variables.find(v => v.name === name);
  assert.ok(variable, `expected to find variable ${name}`);
  assert.strictEqual(variable!.value, expected, `unexpected value for ${name}`);
  return variable!;
}

suite('mdb views integration', () => {
  for (const transport of ['stdio', 'socket'] as const) {
    test(`displays standard library views (${transport})`, async function () {
      const sourceText = fs.readFileSync(sourceFile, 'utf8');
      const breakpointLine = sourceText.split(/\r?\n/).findIndex((line) => line.includes('// STL_BP')) + 1;
      assert.ok(breakpointLine > 0, 'expected STL_BP marker in stl.cpp');

      const session = createMiniDapSession(
        testConfig,
        { name: 'stl', sessionType: 'ptrace', program: testSubject, args: [] },
        { transport, timeoutMs: 10000 },
      );
      const { client } = session;
      try {
        await client.initialize();
        const breakpoints = await client.request('setBreakpoints', {
          source: { name: path.basename(sourceFile), path: sourceFile },
          breakpoints: [{ line: breakpointLine }],
        });
        assert.strictEqual(breakpoints.success, true);
        assert.strictEqual(breakpoints.body.breakpoints.length, 1);

        const launch = await client.request('launch', { program: testSubject, sessionType: 'ptrace' });
        assert.strictEqual(launch.success, true);
        const configured = await client.request('configurationDone');
        assert.strictEqual(configured.success, true);
        await client.waitFor((message) => message.type === 'event' && message.event === 'stopped');

        const loadedViews = await client.request('evaluate', {
          expression: `loadViews(${JSON.stringify(viewsFile)})`,
          context: 'repl',
        });
        assert.strictEqual(loadedViews.success, true);
        assert.ok(loadedViews.body.result.startsWith('loaded'), loadedViews.body.result);
        assert.ok(!loadedViews.body.result.includes('\n'), loadedViews.body.result);

        const takeFirst = (array: any) => array[0];

        const scopes = await client.threads()
          .then(takeFirst)
          .then(thr => thr.stackTrace({startFrame: 0, levels: 1}))
          .then(takeFirst)
          .then(frame => frame.scopes());

        const localsScope = scopes.find((scope: Scope) => scope.name === 'Locals');
        assert.ok(localsScope, 'expected a Locals scope');
        const locals = await localsScope!.variables();

        // std::vector<T> reports size and capacity, and exposes its elements as indexed children.
        expectValue(locals, 'empty', 'size=0 capacity=0');
        const ints = expectValue(locals, 'ints', 'size=1000 capacity=1024');
        assert.strictEqual(ints.indexedVariables, 1000);
        const lastInts = await ints.variables({start: 990, count: 20});

        assert.strictEqual(lastInts.length, 10, 'the last page should stop at size, not capacity');
        lastInts.forEach((item, index) => {
          assert.strictEqual(item.name, `[${990 + index}]`);
          assert.strictEqual(item.value, `${(990 + index) * 2}`);
        });

        const points = expectValue(locals, 'points', 'size=2 capacity=2');

        const pointElements = await points.variables();
        assert.strictEqual(pointElements.length, 2);
        const secondPoint = await pointElements[1].variables();
        expectValue(secondPoint, 'x', '3');
        expectValue(secondPoint, 'y', '4');

        const nested = expectValue(locals, 'nested', 'size=3 capacity=3');
        const nestedElements = await nested.variables();
        assert.deepStrictEqual(nestedElements.map((item) => item.value), [
          'size=1 capacity=1',
          'size=2 capacity=2',
          'size=0 capacity=0',
        ]);
        const secondNested = await nestedElements[1].variables();
        assert.deepStrictEqual(secondNested.map((item) => item.value), ['2', '3']);

        // vector<bool> stores packed bits, so the view computes children without memory references.
        const bools = expectValue(locals, 'bools', 'size=70');
        const bits = await bools.variables();
        assert.strictEqual(bits.length, 70);
        bits.forEach((bit, index) => {
          assert.strictEqual(bit.name, `[${index}]`);
          assert.strictEqual(bit.value, [0, 3, 64, 69].includes(index) ? 'true' : 'false');
          assert.ok(!Object.prototype.hasOwnProperty.call(bit, 'memoryReference'));
        });

        // std::string and std::string_view use their corresponding text views.
        expectValue(locals, 'emptyString', '""');
        expectValue(locals, 'shortString', '"short"');
        expectValue(locals, 'longString', '"a string that is too long for the inline buffer"');
        expectValue(locals, 'utf16String', '"日本語"');
        expectValue(locals, 'constString', '"const"');
        expectValue(locals, 'hello', '"string"');
        expectValue(locals, 'emptyView', '""');
        const strings = expectValue(locals, 'strings', 'size=2 capacity=2');
        const stringElements = await strings.variables();
        assert.deepStrictEqual(stringElements.map((item) => item.value), ['"one"', '"two"']);
      } finally {
        await session.dispose();
      }
    });
  }
});
