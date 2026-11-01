import * as assert from 'assert';
import { BreakpointCache } from '../../core/breakpointCache';
import { shellQuote, substituteChildDebuggerArgs } from '../../core/rewrites';
import { parseShimHello, shimHelloFrame } from '../../core/shimListener';

suite('shim runs', () => {
  test('substitutes the shim path and shell-quoted shim arguments', () => {
    assert.deepStrictEqual(
      substituteChildDebuggerArgs(
        ['--debugger={shimPath}', '--debugger-args={shimArgs}', '--debugger-interactive'],
        '/opt/mdb/mdb_shim',
        ['--tracer-pid', '42', '--socket', "/tmp/a dir/it's.sock"],
      ),
      [
        '--debugger=/opt/mdb/mdb_shim',
        `--debugger-args=--tracer-pid 42 --socket '/tmp/a dir/it'\\''s.sock'`,
        '--debugger-interactive',
      ],
    );
    assert.strictEqual(shellQuote(''), `''`);
    assert.strictEqual(shellQuote('/tmp/mdbda-shim-x/handoff.sock'), '/tmp/mdbda-shim-x/handoff.sock');
  });

  test('round-trips a shim hello', () => {
    const frame = shimHelloFrame({ pid: 1234, argv: ['/bin/firefox', '-profile', 'with space', ''] });
    assert.strictEqual(frame.readUInt32BE(12), frame.length - 16);
    assert.deepStrictEqual(parseShimHello(frame.subarray(16)), {
      pid: 1234, argv: ['/bin/firefox', '-profile', 'with space', ''],
    });
    assert.throws(() => parseShimHello(frame.subarray(16, frame.length - 1)), /truncated/);
  });

  test('keeps adapter breakpoint ids stable across processes', () => {
    const cache = new BreakpointCache();
    const args = { source: { path: '/src/a.cpp' }, breakpoints: [{ line: 3 }, { line: 7 }] };
    const ids = cache.record('setBreakpoints', args);
    assert.deepStrictEqual(cache.unverified('setBreakpoints', args, ids).map((bp) => [bp.id, bp.verified, bp.line]),
      [[ids[0], false, 3], [ids[1], false, 7]]);

    const first = cache.bind(ids, [{ id: 100, verified: true, line: 3 }, { id: 101, verified: true, line: 8 }]);
    assert.deepStrictEqual(first.map((bp) => [bp.id, bp.line]), [[ids[0], 3], [ids[1], 8]]);
    const stopped = cache.translateEvent({ seq: 1, type: 'event', event: 'stopped', body: { hitBreakpointIds: [101] } });
    assert.deepStrictEqual(stopped.body?.hitBreakpointIds, [ids[1]]);

    cache.resetRun();
    cache.bind(ids, [{ id: 200, verified: true, line: 3 }, { id: 201, verified: true, line: 8 }]);
    const changed = cache.translateEvent({
      seq: 2, type: 'event', event: 'breakpoint', body: { reason: 'changed', breakpoint: { id: 200, verified: true } },
    });
    assert.strictEqual((changed.body?.breakpoint as { id: number }).id, ids[0]);

    // A newer request for the same file replaces the old one.
    cache.record('setBreakpoints', { source: { path: '/src/a.cpp' }, breakpoints: [{ line: 9 }] });
    cache.record('setFunctionBreakpoints', { breakpoints: [{ name: 'main' }] });
    assert.deepStrictEqual(cache.cached().map((entry) => [entry.command, entry.ids.length]),
      [['setBreakpoints', 1], ['setFunctionBreakpoints', 1]]);
  });
});
