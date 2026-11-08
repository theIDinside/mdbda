import * as assert from 'assert';
import { EventEmitter } from 'events';
import { MdbConnection } from '../../core/connection';
import { Host } from '../../core/host';
import { nullLogger } from '../../core/logger';
import { MdbSessionAdapter } from '../../core/sessionAdapter';

class FakeMdbProcess extends EventEmitter {
  readonly sent: Record<string, any>[] = [];

  start(): void {}

  send(message: unknown): void {
    this.sent.push(message as Record<string, any>);
  }

  async kill(): Promise<void> {}

  respond(request: Record<string, any>, body?: Record<string, unknown>): void {
    this.emit('message', {
      seq: 0, type: 'response', request_seq: request.seq, command: request.command, success: true,
      ...(body ? { body } : {}),
    });
  }
}

const host: Host = {
  logger: nullLogger,
  trace: false,
  showError: () => undefined,
  startChildSession: () => undefined,
  runInTerminal: () => { throw new Error('runInTerminal is not used by this test'); },
};

suite('session adapter attach', () => {
  test('holds requests sent before the attach response until the pid is bound', () => {
    const process = new FakeMdbProcess();
    const connection = new MdbConnection(process, '/tmp/mdb-attach-logs');
    const adapter = new MdbSessionAdapter(connection, host, {
      sessionType: 'ptrace',
      isChild: true,
      childPid: 4242,
      config: { name: 'fork', sessionType: 'ptrace' },
    });
    const placeholder = adapter.pid;

    adapter.handleMessage({ seq: 1, type: 'request', command: 'initialize' });
    process.respond(process.sent[0], {});

    adapter.handleMessage({ seq: 2, type: 'request', command: 'attach' });
    assert.strictEqual(process.sent[1].processId, placeholder);

    // VS Code configures the session on the initialized event, without waiting for the attach response.
    adapter.handleMessage({
      seq: 3, type: 'request', command: 'setBreakpoints',
      arguments: { source: { path: '/src/a.cpp' }, breakpoints: [{ line: 10 }] },
    });
    adapter.handleMessage({ seq: 4, type: 'request', command: 'setFunctionBreakpoints', arguments: { breakpoints: [] } });
    assert.strictEqual(process.sent.length, 2);

    process.respond(process.sent[1], { processId: 4242 });
    assert.deepStrictEqual(process.sent.slice(2).map((request) => [request.command, request.processId]), [
      ['setBreakpoints', 4242],
      ['setFunctionBreakpoints', 4242],
    ]);

    adapter.handleMessage({ seq: 5, type: 'request', command: 'configurationDone' });
    assert.strictEqual(process.sent[4].processId, 4242);
    adapter.dispose();
  });
});
