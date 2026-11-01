import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { encodeMessage, MessageReader } from './framing';
import { Logger, nullLogger } from './logger';
import { LineBuffer } from './lineBuffer';
import { ProcessControl } from './processControl';

export interface MdbProcessOptions {
	path: string;
	args: string[];
	logDirectory: string;
	threads?: number;
	env?: NodeJS.ProcessEnv;
}

export class MdbProcess extends EventEmitter {
  private child?: ChildProcess;
  private readonly control = new ProcessControl();
  private readonly stderrBuffer = new LineBuffer();

  constructor(private readonly opts: MdbProcessOptions, private readonly logger: Logger = nullLogger) {
    super();
    fs.mkdirSync(opts.logDirectory, { recursive: true });
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): void {
    if (this.child) {
      throw new Error('mdb process has already been started');
    }
    const args = ['-l', this.opts.logDirectory];
    if (this.opts.threads) {
      args.push('-t', String(this.opts.threads));
    }
    args.push(...this.opts.args);
    const child = spawn(this.opts.path, args, {
      stdio: 'pipe',
      env: this.opts.env,
    });
    this.child = child;
    const reader = new MessageReader();
    reader.on('message', (message) => this.emit('message', message));
    reader.on('garbage', (text: string) => this.emit('garbage', text));
    reader.on('error', (payload: string) => this.logger.error(`Invalid JSON from mdb: ${payload}`));
    child.stdout?.on('data', (chunk: Buffer) => reader.push(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => this.consumeStderr(chunk));
    // Writing after mdb died raises EPIPE on stdin; without a listener that is an uncaught exception.
    child.stdin?.on('error', (err) => this.logger.warn(`mdb stdin: ${err.message}`));
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'EACCES') {
        this.emit('spawnError', err);
      } else {
        this.logger.error(`Failed to spawn mdb: ${err.message}`);
      }
      this.finish(null, null);
    });
    // 'close' rather than 'exit': it fires after stdout is drained, so mdb's final events are delivered first.
    child.on('close', (code, signal) => this.finish(code, signal));
  }

  send(obj: unknown): void {
    if (this.control.isExited || !this.child?.stdin || this.child.stdin.destroyed) {
      this.logger.warn('Ignoring message sent to mdb after exit');
      return;
    }
    this.child.stdin.write(encodeMessage(obj));
  }

  kill(graceMs = 1500): Promise<void> {
    if (this.control.isExited || !this.child) {
      return Promise.resolve();
    }
    return this.control.kill(this.child, graceMs);
  }

  private consumeStderr(chunk: string): void {
    this.stderrBuffer.push(chunk, (line) => this.emit('stderr', line));
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (!this.control.finish()) {
      return;
    }
    this.stderrBuffer.flush((line) => this.emit('stderr', line));
    this.emit('exit', { code, signal });
  }
}
