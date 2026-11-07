import * as assert from 'assert';
import {
  alignSetBreakpointsResponse,
  buildChildAttachArgs,
  buildLaunchArgs,
  foldMemoryOffset,
  rewriteDisassemble,
  rewriteNext,
  rewriteSetBreakpoints,
  rewriteSetFunctionBreakpoints,
  sliceStackTrace,
  stripMdbEventFields,
  wrapCustomRequest,
} from '../../core/rewrites';
import { blockedResponse } from '../../core/blocked';
import { CONFIG_TOKEN_COMMANDS, CUSTOM_COMMANDS, FORWARDED_REQUESTS, LOCALLY_ANSWERED } from '../../core/protocol';

suite('protocol rewrites', () => {
  test('rewrites statement stepping granularity', () => {
    assert.deepStrictEqual(rewriteNext({ granularity: 'statement', threadId: 3 }), { granularity: 'line', threadId: 3 });
    assert.deepStrictEqual(rewriteNext({ granularity: 'instruction' }), { granularity: 'instruction' });
  });

  test('fills required disassemble offsets without replacing supplied offsets', () => {
    assert.deepStrictEqual(rewriteDisassemble({ memoryReference: '0x10' }), {
      memoryReference: '0x10', offset: 0, instructionOffset: 0,
    });
    assert.deepStrictEqual(rewriteDisassemble({ offset: 4, instructionOffset: -2 }), {
      offset: 4, instructionOffset: -2,
    });
  });

  test('folds positive and negative memory offsets into hex references', () => {
    assert.deepStrictEqual(foldMemoryOffset({ memoryReference: '0x1000', offset: 16 }), { memoryReference: '0x1010' });
    assert.deepStrictEqual(foldMemoryOffset({ memoryReference: '1000', offset: 16 }), { memoryReference: '0x1010' });
    assert.deepStrictEqual(foldMemoryOffset({ memoryReference: '0x1000', offset: -1 }), { memoryReference: '0xfff' });
    assert.deepStrictEqual(foldMemoryOffset({ memoryReference: '0x20' }), { memoryReference: '0x20' });
  });

  test('slices stack frames and retains the full frame count at boundaries', () => {
    const body = { stackFrames: [{ id: 1 }, { id: 2 }, { id: 3 }] };
    assert.deepStrictEqual(sliceStackTrace({}, body), { stackFrames: body.stackFrames, totalFrames: 3 });
    assert.deepStrictEqual(sliceStackTrace({ startFrame: 1, levels: 1 }, body), {
      stackFrames: [{ id: 2 }], totalFrames: 3,
    });
    assert.deepStrictEqual(sliceStackTrace({ startFrame: 2, levels: 0 }, body), {
      stackFrames: [{ id: 3 }], totalFrames: 3,
    });
    assert.deepStrictEqual(sliceStackTrace({ startFrame: 3, levels: 1 }, body), { stackFrames: [], totalFrames: 3 });
  });

  test('strips breakpoint conditions and forwards logpoints', () => {
    const result = rewriteSetBreakpoints({
      source: { path: '/src/main.cpp' },
      lines: [10, 11, 12],
      breakpoints: [
        { line: 10, condition: 'x > 1' },
        { line: 11, logMessage: 'value {x}' },
        { line: 12, hitCondition: '3' },
      ],
    });
    assert.deepStrictEqual(result.forward.breakpoints, [{ line: 10 }, { line: 11, logMessage: 'value {x}' }, { line: 12 }]);
    assert.deepStrictEqual(result.forward.lines, [10, 11, 12]);
    assert.deepStrictEqual([...result.mapping], [[0, 0], [1, 1], [2, 2]]);
    assert.strictEqual(result.local.size, 0);
    assert.deepStrictEqual(result.warnings.map(({ message }) => message), [
      'mdb: breakpoint conditions are not supported yet; ignoring condition on /src/main.cpp:10',
      'mdb: breakpoint conditions are not supported yet; ignoring condition on /src/main.cpp:12',
    ]);
  });

  test('converts legacy lines-only requests into mdb breakpoint entries', () => {
    const result = rewriteSetBreakpoints({ source: { path: '/src/a.cpp' }, lines: [4, 9] });
    assert.deepStrictEqual(result.forward.breakpoints, [{ line: 4 }, { line: 9 }]);
    assert.deepStrictEqual(result.forward.lines, [4, 9]);
    assert.deepStrictEqual([...result.mapping], [[0, 0], [1, 1]]);
  });

  test('aligns one-to-one breakpoint responses by line, preferring verified exact results', () => {
    const requested = [{ line: 10 }, { line: 20 }];
    const aligned = alignSetBreakpointsResponse(
      requested,
      new Map([[0, 0], [1, 1]]),
      new Map(),
      [
        { id: 20, verified: true, line: 21 },
        { id: 10, verified: false, line: 10 },
        { id: 11, verified: true, line: 10 },
        { id: 21, verified: true, line: 20 },
        { id: 12, verified: true, line: 11 },
      ],
    );
    assert.deepStrictEqual(aligned, [
      { id: 11, verified: true, line: 10 },
      { id: 21, verified: true, line: 20 },
    ]);
  });

  test('uses nearest following location, avoids cross-line ID reuse, and permits duplicate requested lines', () => {
    const candidates = [
      { id: 1, verified: true, line: 15 },
      { id: 2, verified: true, line: 18 },
    ];
    const aligned = alignSetBreakpointsResponse(
      [{ line: 10 }, { line: 12 }, { line: 12 }],
      new Map([[0, 0], [1, 1], [2, 2]]),
      new Map(),
      candidates,
    );
    assert.deepStrictEqual(aligned, [
      { id: 1, verified: true, line: 15 },
      { id: 2, verified: true, line: 18 },
      { id: 2, verified: true, line: 18 },
    ]);
    assert.deepStrictEqual(alignSetBreakpointsResponse(
      [{ line: 1 }], new Map([[0, 0]]), new Map(), [],
    ), [{ verified: false, line: 1, message: 'No breakpoint location found' }]);
  });

  test('copies local logpoint responses into the requested response positions', () => {
    const requested = [{ line: 1 }, { line: 2 }];
    const local = new Map([[1, { verified: false, line: 2, message: 'local' }]]);
    assert.deepStrictEqual(alignSetBreakpointsResponse(requested, new Map([[0, 0]]), local, [
      { id: 4, verified: true, line: 1 },
    ]), [
      { id: 4, verified: true, line: 1 },
      { verified: false, line: 2, message: 'local' },
    ]);
  });

  test('strips function breakpoint conditions and converts slash names to regexes', () => {
    const result = rewriteSetFunctionBreakpoints({ breakpoints: [
      { name: '/^main$/', condition: 'x' },
      { name: 'worker', hitCondition: '2' },
    ] });
    assert.deepStrictEqual(result.forward.breakpoints, [
      { name: '^main$', regex: true },
      { name: 'worker' },
    ]);
    assert.deepStrictEqual(result.warnings.map(({ message }) => message), [
      'mdb: breakpoint conditions are not supported yet; ignoring condition on /^main$/:?',
      'mdb: breakpoint conditions are not supported yet; ignoring condition on worker:?',
    ]);
  });

  test('builds launch arguments and drops VS Code-only configuration properties', () => {
    const result = buildLaunchArgs({
      type: 'mdb', sessionType: 'rr', request: 'launch', name: 'Replay', cwd: '/work',
      program: 'bin/app', args: ['one'], stopOnEntry: true, breakpointBehavior: 'Stop all threads',
      traceDir: '/trace', views: ['views/a.mdbv'], mdbPath: '/mdb', __internal: true,
    }, 'token');
    assert.deepStrictEqual(result, {
      type: 'rr', configToken: 'token', program: '/work/bin/app', args: ['one'], stopOnEntry: true,
      breakpointBehavior: 'Stop all threads', traceDir: '/trace', views: ['/work/views/a.mdbv'],
    });
  });

  test('builds child attach args and wraps custom requests', () => {
    assert.deepStrictEqual(buildChildAttachArgs(42, 'child-token'), {
      sessionType: 'ptrace', processId: 42, configToken: 'child-token',
    });
    assert.deepStrictEqual(wrapCustomRequest('continueAll'), {
      command: 'customRequest', arguments: { command: 'continueAll', arguments: {} },
    });
    assert.deepStrictEqual(wrapCustomRequest('pauseAll', { reason: 'user' }), {
      command: 'customRequest', arguments: { command: 'pauseAll', arguments: { reason: 'user' } },
    });
  });

  test('strips process fields and extracts rr process lists without mutating input', () => {
    const stopped = {
      seq: 7, type: 'event' as const, event: 'stopped', processId: 42,
      body: { reason: 'step', processes: [42, 43] },
    };
    assert.deepStrictEqual(stripMdbEventFields(stopped), {
      event: { seq: 7, type: 'event', event: 'stopped', body: { reason: 'step' } },
      processes: [42, 43],
    });
    assert.deepStrictEqual(stopped.body.processes, [42, 43]);
    assert.deepStrictEqual(stripMdbEventFields({ seq: 8, type: 'event', event: 'output', processId: 1 }), {
      event: { seq: 8, type: 'event', event: 'output' }, processes: undefined,
    });
  });

  test('builds a blocked DAP response and exposes the expected command sets', () => {
    assert.deepStrictEqual(blockedResponse({ seq: 9, type: 'request', command: 'modules' }), {
      seq: 0, type: 'response', request_seq: 9, command: 'modules', success: false,
      message: 'modules is not supported by mdb',
    });
    assert.deepStrictEqual(blockedResponse({ seq: 10, type: 'request', command: 'x' }, 'blocked'), {
      seq: 0, type: 'response', request_seq: 10, command: 'x', success: false, message: 'blocked',
    });
    assert.ok(FORWARDED_REQUESTS.has('initialize'));
    assert.ok(FORWARDED_REQUESTS.has('reverseContinue'));
    assert.deepStrictEqual([...LOCALLY_ANSWERED], ['setExceptionBreakpoints']);
    assert.deepStrictEqual(CUSTOM_COMMANDS, ['continueAll', 'pauseAll', 'getProcesses']);
    assert.deepStrictEqual([...CONFIG_TOKEN_COMMANDS], [
      'initialize', 'launch', 'attach', 'configurationDone', 'setBreakpoints',
      'setFunctionBreakpoints', 'setInstructionBreakpoints',
    ]);
  });
});
