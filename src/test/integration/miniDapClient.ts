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
