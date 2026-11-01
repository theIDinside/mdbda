import * as assert from 'assert';
import { patchCapabilities } from '../../core/capabilities';

suite('patchCapabilities', () => {
  test('disables unsupported capabilities and removes malformed capability fields', () => {
    const original = {
      supportsConditionalBreakpoints: true,
      supportsHitConditionalBreakpoints: true,
      supportsLogPoints: true,
      supportsTerminateThreadsRequest: true,
      supportsStepBack: true,
      supportsSingleThreadExecutionRequests: true,
      exceptionBreakpointFilters: [{ filter: 'all' }],
      completionTriggerCharacters: ['.'],
      additionalModuleColumns: false,
      supportedChecksumAlgorithms: false,
      supportsFunctionBreakpoints: true,
    };
    const patched = patchCapabilities(original, 'rr');

    assert.strictEqual(patched.supportsConditionalBreakpoints, false);
    assert.strictEqual(patched.supportsHitConditionalBreakpoints, false);
    assert.strictEqual(patched.supportsLogPoints, false);
    assert.strictEqual(patched.supportsTerminateThreadsRequest, false);
    assert.strictEqual(patched.supportsStepBack, false);
    assert.deepStrictEqual(patched.exceptionBreakpointFilters, []);
    assert.strictEqual(patched.supportsSingleThreadExecutionRequests, true);
    assert.strictEqual(patched.supportsFunctionBreakpoints, true);
    assert.ok(!('completionTriggerCharacters' in patched));
    assert.ok(!('additionalModuleColumns' in patched));
    assert.ok(!('supportedChecksumAlgorithms' in patched));
    assert.strictEqual(original.supportsConditionalBreakpoints, true);
    assert.notStrictEqual(patched, original);
  });
});
