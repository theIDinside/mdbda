import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TestConfig } from '../testPaths';


function waitForActiveStackItem(timeoutMs: number): { promise: Promise<void>; cancel(): void } {
  let subscription: vscode.Disposable | undefined;
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  let resolvePromise: () => void = () => undefined;
  let rejectPromise: (error: Error) => void = () => undefined;
  const cleanup = (): void => {
    subscription?.dispose();
    if (timer) {
      clearTimeout(timer);
    }
  };
  const finish = (): void => {
    if (!settled) {
      settled = true;
      cleanup();
      resolvePromise();
    }
  };
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
    subscription = vscode.debug.onDidChangeActiveStackItem((item) => {
      if (item) {
        finish();
      }
    });
    timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        rejectPromise(new Error(`No active stack item appeared within ${timeoutMs} ms`));
      }
    }, timeoutMs);
  });
  return { promise, cancel: () => finish() };
}

suite('mdb extension', () => {
  const testConfig = TestConfig.readTestConfig();

  test('activates and contributes the mdb debugger', async () => {
    const extension = vscode.extensions.all.find((candidate) => candidate.packageJSON.name === 'mdbda');
    assert.ok(extension, 'mdbda extension should be present in the Extension Host');
    await extension.activate();
    assert.strictEqual(extension.isActive, true);
    const manifest = JSON.parse(fs.readFileSync(path.join(extension.extensionPath, 'package.json'), 'utf8'));
    assert.ok(manifest.contributes.debuggers.some((debuggerContribution: { type: string }) => debuggerContribution.type === 'mdb'));
  });

  test('starts helloworld and pauses on entry', async function () {
    const mdb = testConfig.mdbPath;
    const program = testConfig.testSubject('helloworld');

    let session: vscode.DebugSession | undefined;
    let startSubscription: vscode.Disposable | undefined;
    let resolveSession: (value: vscode.DebugSession) => void = () => undefined;
    const sessionStarted = new Promise<vscode.DebugSession>((resolve) => { resolveSession = resolve; });
    startSubscription = vscode.debug.onDidStartDebugSession((started) => {
      if (started.type === 'mdb' && started.name === 'mdb Extension Smoke Test') {
        session = started;
        resolveSession(started);
      }
    });
    const stackItem = waitForActiveStackItem(15000);
    void stackItem.promise.catch(() => undefined);
    try {
      const started = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], {
        type: 'mdb',
        request: 'launch',
        name: 'mdb Extension Smoke Test',
        program,
        mdbPath: mdb,
        stopOnEntry: true,
      });
      assert.strictEqual(started, true, 'VS Code should start the mdb debug session');
      session = await sessionStarted;
      await stackItem.promise;
    } finally {
      stackItem.cancel();
      startSubscription?.dispose();
      if (session) {
        await vscode.debug.stopDebugging(session);
      }
    }
  });
});
