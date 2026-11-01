import * as assert from 'assert';
import { EventEmitter } from 'events';
import { MdbConnection } from '../../core/connection';
import { Host } from '../../core/host';
import { MdbSessionAdapter } from '../../core/sessionAdapter';
import { nullLogger } from '../../core/logger';

class FakeMdbProcess extends EventEmitter {
  readonly sent: Record<string, any>[] = [];
  started = false;
  killed = false;

  start(): void {
    this.started = true;
  }

  send(message: unknown): void {
    this.sent.push(message as Record<string, any>);
  }

  async kill(): Promise<void> {
    this.killed = true;
  }

  respond(request: Record<string, any>, body?: Record<string, unknown>, command = request.command): void {
    this.emit('message', {
      seq: 0, type: 'response', request_seq: request.seq, command, success: true,
      ...(body ? { body } : {}),
    });
  }
}

function createHost(): Host {
  return { logger: nullLogger, trace: false, showError: () => undefined, startChildSession: () => undefined };
}

function createAdapter(connection: MdbConnection, host = createHost(), opts: Partial<ConstructorParameters<typeof MdbSessionAdapter>[2]> = {}): MdbSessionAdapter {
  return new MdbSessionAdapter(connection, host, {
    sessionType: 'ptrace', isChild: false, config: { name: 'test', program: '/tmp/test-program' }, ...opts,
  });
}

function collect(adapter: MdbSessionAdapter): Record<string, any>[] {
  const messages: Record<string, any>[] = [];
  adapter.onDidSendMessage((message) => messages.push(message as Record<string, any>));
  return messages;
}

suite('MdbConnection and MdbSessionAdapter', () => {
  test('remaps interleaved requests from two adapters and routes responses by request_seq', () => {
    const process = new FakeMdbProcess();
    const connection = new MdbConnection(process, '/tmp/mdb-logs');
    const first = createAdapter(connection);
    const second = createAdapter(connection);
    const firstMessages = collect(first);
    const secondMessages = collect(second);
    first.handleMessage({ seq: 10, type: 'request', command: 'threads' });
    second.handleMessage({ seq: 20, type: 'request', command: 'threads' });
    assert.deepStrictEqual(process.sent.map(({ seq }) => seq), [1, 2]);
    process.respond(process.sent[1]);
    process.respond(process.sent[0]);
    assert.strictEqual(firstMessages[0].request_seq, 10);
    assert.strictEqual(secondMessages[0].request_seq, 20);
    assert.strictEqual(firstMessages.length, 1);
    assert.strictEqual(secondMessages.length, 1);
  });

  test('routes custom command responses without processId and emits continued for continueAll', () => {
    const process = new FakeMdbProcess();
    const connection = new MdbConnection(process, '/tmp/mdb-logs');
    const adapter = createAdapter(connection);
    const messages = collect(adapter);
    adapter.handleMessage({ seq: 5, type: 'request', command: 'continueAll' });
    assert.strictEqual(process.sent[0].command, 'customRequest');
    assert.deepStrictEqual(process.sent[0].arguments, { command: 'continueAll', arguments: {} });
    process.respond(process.sent[0], undefined, 'continueAll');
    assert.strictEqual(messages[0].command, 'continueAll');
    assert.deepStrictEqual(messages[1], {
      seq: 2, type: 'event', event: 'continued', body: { allThreadsContinued: true },
    });
  });

  test('buffers events for an unknown pid and flushes them when launch binds the pid', () => {
    const process = new FakeMdbProcess();
    const connection = new MdbConnection(process, '/tmp/mdb-logs');
    const adapter = createAdapter(connection);
    const messages = collect(adapter);
    adapter.handleMessage({ seq: 1, type: 'request', command: 'launch', arguments: { program: '/tmp/program' } });
    const launch = process.sent[0];
    process.emit('message', { seq: 0, type: 'event', processId: 88, event: 'output', body: { output: 'early' } });
    process.emit('message', { seq: 0, type: 'event', processId: 88, event: 'thread', body: { reason: 'started' } });
    assert.strictEqual(messages.length, 0);
    process.respond(launch, { processId: 88 });
    assert.strictEqual(messages[0].event, 'output');
    assert.strictEqual(messages[0].body.output, 'early');
    assert.strictEqual(messages[1].event, 'thread');
    assert.strictEqual(messages[2].command, 'launch');
    assert.ok(!('processId' in messages[0]));
  });

  test('answers blocked commands and setExceptionBreakpoints locally', () => {
    const process = new FakeMdbProcess();
    const connection = new MdbConnection(process, '/tmp/mdb-logs');
    const adapter = createAdapter(connection);
    const messages = collect(adapter);
    adapter.handleMessage({ seq: 1, type: 'request', command: 'modules' });
    adapter.handleMessage({ seq: 2, type: 'request', command: 'setExceptionBreakpoints' });
    assert.strictEqual(process.sent.length, 0);
    assert.deepStrictEqual(messages[0], {
      seq: 1, type: 'response', request_seq: 1, command: 'modules', success: false,
      message: 'modules is not supported by mdb',
    });
    assert.deepStrictEqual(messages[1], {
      seq: 2, type: 'response', request_seq: 2, command: 'setExceptionBreakpoints', success: true,
      body: { breakpoints: [] },
    });
  });

  test('unexpected nonzero exit emits crash output and terminated before pending errors', () => {
    const process = new FakeMdbProcess();
    const connection = new MdbConnection(process, '/tmp/mdb-logs');
    const adapter = createAdapter(connection);
    const messages = collect(adapter);
    adapter.handleMessage({ seq: 7, type: 'request', command: 'threads' });
    process.emit('exit', { code: 2, signal: null });
    assert.deepStrictEqual(messages.map(({ type, event, command }) => [type, event ?? command]), [
      ['event', 'output'], ['event', 'terminated'], ['response', 'threads'],
    ]);
    assert.strictEqual(messages[0].body.category, 'important');
    assert.match(messages[0].body.output, /\/tmp\/mdb-logs/);
    assert.strictEqual(messages[2].success, false);
    assert.strictEqual(messages[2].request_seq, 7);
  });

  test('normal exit after mdb terminated does not report a crash or duplicate terminated', () => {
    const process = new FakeMdbProcess();
    const connection = new MdbConnection(process, '/tmp/mdb-logs');
    const adapter = createAdapter(connection);
    const messages = collect(adapter);
    process.emit('message', { seq: 0, type: 'event', processId: adapter.pid, event: 'terminated' });
    process.emit('exit', { code: 0, signal: null });
    assert.strictEqual(messages.filter(({ event }) => event === 'terminated').length, 1);
    assert.strictEqual(messages.some(({ event, body }) => event === 'output' && body?.category === 'important'), false);
  });

  test('exit after a root disconnect was forwarded does not report a crash', () => {
    const process = new FakeMdbProcess();
    const connection = new MdbConnection(process, '/tmp/mdb-logs');
    const adapter = createAdapter(connection);
    const messages = collect(adapter);
    adapter.handleMessage({ seq: 4, type: 'request', command: 'disconnect', arguments: { terminateDebuggee: true } });
    assert.strictEqual(process.sent[0].command, 'disconnect');
    process.respond(process.sent[0]);
    process.emit('exit', { code: 0, signal: null });
    assert.strictEqual(messages.some(({ event, body }) => event === 'output' && body?.category === 'important'), false);
  });

  test('patches initialize capabilities before delivering them to the client', () => {
    const process = new FakeMdbProcess();
    const connection = new MdbConnection(process, '/tmp/mdb-logs');
    const adapter = createAdapter(connection);
    const messages = collect(adapter);
    adapter.handleMessage({ seq: 3, type: 'request', command: 'initialize' });
    process.respond(process.sent[0], {
      completionTriggerCharacters: ['.'], additionalModuleColumns: false, supportedChecksumAlgorithms: false,
      supportsConditionalBreakpoints: true,
    });
    assert.strictEqual(messages[0].body.supportsConditionalBreakpoints, false);
    assert.ok(!('completionTriggerCharacters' in messages[0].body));
  });

  test('forwards an empty setBreakpoints request so mdb can clear a file', () => {
    const process = new FakeMdbProcess();
    const connection = new MdbConnection(process, '/tmp/mdb-logs');
    const adapter = createAdapter(connection);
    const messages = collect(adapter);
    adapter.handleMessage({
      seq: 6, type: 'request', command: 'setBreakpoints',
      arguments: { source: { path: '/tmp/example.cpp' }, breakpoints: [] },
    });
    assert.strictEqual(process.sent.length, 1);
    assert.strictEqual(process.sent[0].command, 'setBreakpoints');
    assert.deepStrictEqual(process.sent[0].arguments.breakpoints, []);
    process.respond(process.sent[0], { breakpoints: [] });
    assert.deepStrictEqual(messages[0].body.breakpoints, []);
  });

  test('stops a child by disconnecting only that pid then killing it', async () => {
    const process = new FakeMdbProcess();
    const killed: Array<[number, NodeJS.Signals]> = [];
    const connection = new MdbConnection(process, '/tmp/mdb-logs', nullLogger, (pid, signal) => killed.push([pid, signal]));
    const adapter = createAdapter(connection, createHost(), { isChild: true, childPid: 73 });
    const messages = collect(adapter);
    adapter.handleMessage({ seq: 9, type: 'request', command: 'terminate' });
    assert.strictEqual(process.sent[0].command, 'disconnect');
    assert.deepStrictEqual(process.sent[0].arguments, { terminateDebuggee: false });
    assert.strictEqual(process.sent[0].processId, 73);
    process.respond(process.sent[0]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(killed, [[73, 'SIGKILL']]);
    assert.strictEqual(messages[0].success, true);
    assert.strictEqual(messages[0].command, 'terminate');
    assert.strictEqual(messages[1].event, 'terminated');
  });
});
