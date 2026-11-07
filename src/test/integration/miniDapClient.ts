import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as assert from 'assert';
import { MdbConnection } from '../../core/connection';
import { Host } from '../../core/host';
import { nullLogger } from '../../core/logger';
import { MdbProcess } from '../../core/mdbProcess';
import { MdbSocketProcess } from '../../core/mdbSocketProcess';
import { MdbSessionAdapter } from '../../core/sessionAdapter';
import { ProtocolMessage } from '../../core/protocol';
import { PrepareStacktrace } from './testUtils';
import { consoleLogger } from '../../core/logger';
import { TestConfig } from '../testPaths';

export function createMiniDapSession(
  testConfig: TestConfig,
  config: ConstructorParameters<typeof MdbSessionAdapter>[2]['config'],
  options: { transport?: 'stdio' | 'socket'; timeoutMs?: number; host?: Host } = {},
) {
  const log = new Log(testConfig);
  const processOptions = { path: testConfig.mdbPath, args: [], logDirectory: log.directory() };
  const mdbProcess = options.transport === 'socket'
    ? new MdbSocketProcess(processOptions)
    : new MdbProcess(processOptions);
  const connection = new MdbConnection(mdbProcess, log.directory());
  const adapter = new MdbSessionAdapter(connection, options.host ?? {
    logger: nullLogger,
    trace: false,
    showError: (message) => { throw new Error(message); },
    startChildSession: () => undefined,
    runInTerminal: () => { throw new Error('runInTerminal is not used by this test'); },
  }, {
    sessionType: 'ptrace',
    isChild: false,
    config,
  });
  const client = new MiniDapClient(adapter, log, options.timeoutMs);

  return {
    client,
    adapter,
    process: mdbProcess,
    log,
    async dispose() {
      adapter.dispose();
      await mdbProcess.kill(100);
      log.dispose();
    },
  };
}

export class Log {
  private logDirectory: string;
  constructor(testConfig: TestConfig, private persist: boolean = false) {
    const dir = testConfig.logDirectory ?? path.join(os.tmpdir(), 'mdbda-fork-');
    this.logDirectory = fs.mkdtempSync(dir);
  }

  persistLogs() {
    this.persist = true;
  }

  directory() {
    return this.logDirectory;
  }

  dispose() {
    if(!this.persist) {
      fs.rmSync(this.logDirectory, { recursive: true, force: true });
    } else {
      consoleLogger.warn(`log directory persisted=${this.logDirectory}`);
    }
  }
}

export interface RequestedVariableData {
	name: string;
	value: string;
	variablesReference: number;
	type?: string;
	evaluateName?: string;
	namedVariables?: number;
	indexedVariables?: number;
	memoryReference?: string;
}

export interface ThreadData {
	id: number;
	name: string;
}

export interface StackFrameData {
	id: number;
	name: string;
	source?: Record<string, unknown>;
	line?: number;
	column?: number;
	endLine?: number;
	endColumn?: number;
	presentationHint?: string;
	moduleId?: string | number;
}

export interface ScopeData {
	name: string;
	variablesReference: number;
	expensive: boolean;
	presentationHint?: string;
	namedVariables?: number;
	indexedVariables?: number;
	source?: Record<string, unknown>;
	line?: number;
	column?: number;
}

export class Thread {
  constructor(private readonly client: MiniDapClient, readonly data: ThreadData) {}

  get id() {
    return this.data.id;
  }

  get name() {
    return this.data.name;
  }

  stackTrace(args: { startFrame?: number; levels?: number } = {}): Promise<StackFrame[]> {
    return this.client.stackTrace(this.id, args);
  }
}

export class StackFrame {
  constructor(private readonly client: MiniDapClient, readonly data: StackFrameData) {}

  get id() {
    return this.data.id;
  }

  get name() {
    return this.data.name;
  }

  get source() {
    return this.data.source;
  }

  get line() {
    return this.data.line;
  }

  get column() {
    return this.data.column;
  }

  get endLine() {
    return this.data.endLine;
  }

  get endColumn() {
    return this.data.endColumn;
  }

  get presentationHint() {
    return this.data.presentationHint;
  }

  get moduleId() {
    return this.data.moduleId;
  }

  scopes(): Promise<Scope[]> {

    return this.client.scopes(this.id);
  }
}

export class RequestedVariable {

  constructor(private readonly client: MiniDapClient, readonly data: RequestedVariableData) {}

  get name() {
    return this.data.name;
  }

  get value() {
    return this.data.value;
  }

  get variablesReference() {
    return this.data.variablesReference;
  }

  get type() {
    return this.data.type;
  }

  get evaluateName() {
    return this.data.evaluateName;
  }
  get namedVariables() {
    return this.data.namedVariables;
  }
  get indexedVariables() {
    return this.data.indexedVariables;
  }
  get memoryReference() {
    return this.data.memoryReference;
  }

  variables(args: Record<string, unknown> = {}): Promise<RequestedVariable[]> {
    assert.ok(this.variablesReference > 0, `Variable ${this.name} has no children`);
    return this.client.variables({ ...args, variablesReference: this.variablesReference });
  }
}

export class Scope {
  constructor(private readonly client: MiniDapClient, readonly data: ScopeData) {}

  get name() {
    return this.data.name;
  }
  get variablesReference() {
    return this.data.variablesReference;
  }
  get expensive() {
    return this.data.expensive;
  }
  get presentationHint() {
    return this.data.presentationHint;
  }
  get namedVariables() {
    return this.data.namedVariables;
  }
  get indexedVariables() {
    return this.data.indexedVariables;
  }
  get source() {
    return this.data.source;
  }
  get line() {
    return this.data.line;
  }
  get column() {
    return this.data.column;
  }

  variables(args: Record<string, unknown> = {}): Promise<RequestedVariable[]> {
    return this.client.variables({ ...args, variablesReference: this.variablesReference });
  }
}

export class MiniDapClient {
  private sequence = 0;
  private readonly waiting: ProtocolMessage[] = [];
  private logsPersisted: boolean = false;
  readonly delivered: ProtocolMessage[] = [];
  private readonly notify: Array<() => void> = [];

  constructor(private readonly adapter: MdbSessionAdapter, private log: Log, private readonly timeoutMs = 15000) {
    adapter.onDidSendMessage((message) => {
      this.waiting.push(message);
      this.delivered.push(message);
      for (const wake of this.notify.splice(0)) {
        wake();
      }
    });
  }

  async request(command: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
    const seq = ++this.sequence;
    this.adapter.handleMessage({ seq, type: 'request', command, arguments: args });
    return this.waitFor((message) => message.type === 'response' && message.request_seq === seq) as Promise<Record<string, any>>;
  }

  async variables(args: Record<string, unknown> = {}): Promise<RequestedVariable[]> {
    const response = await this.request('variables', args);
    assert.strictEqual(response.success, true, response.message ?? 'DAP variables request failed');
    assert.ok(Array.isArray(response.body?.variables), 'DAP variables response must contain a variables array');
    return response.body.variables.map((variable: RequestedVariableData) => new RequestedVariable(this, variable));
  }

  async threads(): Promise<Thread[]> {
    const response = await this.request('threads');
    assert.strictEqual(response.success, true, response.message ?? 'DAP threads request failed');
    assert.ok(Array.isArray(response.body?.threads), 'DAP threads response must contain a threads array');
    return response.body.threads.map((thread: ThreadData) => new Thread(this, thread));
  }

  async stackTrace(threadId: number, args: { startFrame?: number; levels?: number } = {}): Promise<StackFrame[]> {
    const response = await this.request('stackTrace', { ...args, threadId });
    assert.strictEqual(response.success, true, response.message ?? 'DAP stackTrace request failed');
    assert.ok(Array.isArray(response.body?.stackFrames), 'DAP stackTrace response must contain a stackFrames array');
    return response.body.stackFrames.map((frame: StackFrameData) => new StackFrame(this, frame));
  }

  async scopes(frameId: number): Promise<Scope[]> {
    const response = await this.request('scopes', { frameId });
    assert.strictEqual(response.success, true, response.message ?? 'DAP scopes request failed');
    assert.ok(Array.isArray(response.body?.scopes), 'DAP scopes response must contain a scopes array');
    return response.body.scopes.map((scope: ScopeData) => new Scope(this, scope));
  }

  persistLogs() {
    this.log.persistLogs();
  }

  async initialize() {
    const initialize = await this.request('initialize', { adapterID: 'mdbda' });
    assert.strictEqual(initialize.success, true);
    await this.waitFor((message) => message.type === 'event' && message.event === 'initialized');
  }

  waitFor(predicate: (message: ProtocolMessage) => boolean): Promise<ProtocolMessage> {
    const err = PrepareStacktrace('Timed out waiting for DAP message', this.waitFor);
    const find = (): ProtocolMessage | undefined => {
      const index = this.waiting.findIndex(predicate);
      return index < 0 ? undefined : this.waiting.splice(index, 1)[0];
    };
    const current = find();
    if (current) {
      return Promise.resolve(current);
    }
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const check = (): void => {
        const next = find();
        if (next) {
          clearTimeout(timer);
          resolve(next);
        } else {
          this.notify.push(check);
        }
      };
      timer = setTimeout(() => {
        const index = this.notify.indexOf(check);
        if (index >= 0) {
          this.notify.splice(index, 1);
        }
        this.persistLogs();
        reject(err);
      }, this.timeoutMs);
      this.notify.push(check);
    });
  }
}
