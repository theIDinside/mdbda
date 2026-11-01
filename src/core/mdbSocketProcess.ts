import { spawn, ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { encodeMessage, MessageReader } from './framing';
import { LineBuffer } from './lineBuffer';
import { Logger, nullLogger } from './logger';
import type { MdbProcessLike } from './connection';
import { ProcessControl } from './processControl';

export interface MdbSocketProcessOptions {
	path: string;
	args: string[];
	logDirectory: string;
	threads?: number;
	env?: NodeJS.ProcessEnv;
	connectTimeoutMs?: number;
}

export class MdbSocketProcess extends EventEmitter implements MdbProcessLike {
  private child?: ChildProcess;
  private socket?: net.Socket;
  private socketPath?: string;
  private readonly control = new ProcessControl();
  private processClosed = false;
  private socketClosed = true;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private readonly stdoutBuffer = new LineBuffer();
  private readonly stderrBuffer = new LineBuffer();
  private readonly pending: Buffer[] = [];
  private stdoutText = '';
  private stderrText = '';
  private connectTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private connecting = false;
  private connected = false;
  private connectionFailed = false;

  constructor(private readonly opts: MdbSocketProcessOptions, private readonly logger: Logger = nullLogger) {
    super();
    fs.mkdirSync(opts.logDirectory, { recursive: true });
  }

  start(): void {
    if (this.child) {
      throw new Error('mdb process has already been started');
    }
    const socketPath = path.join(os.tmpdir(), `mdb-${crypto.randomUUID()}.sock`);
    this.socketPath = socketPath;
    this.socketClosed = false;
    const args = ['-l', this.opts.logDirectory];
    if (this.opts.threads) {
      args.push('-t', String(this.opts.threads));
    }
    args.push(...this.opts.args, `-i`, `unix:${socketPath}`, '-w', String(this.opts.connectTimeoutMs ?? 10000));
    const child = spawn(this.opts.path, args, { stdio: ['ignore', 'pipe', 'pipe'], env: this.opts.env });
    this.child = child;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (!this.connected) {
        this.stdoutText = `${this.stdoutText}${chunk}`.slice(-8192);
      }
      this.stdoutBuffer.push(chunk, (line) => this.emit('stdout', line));
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (!this.connected) {
        this.stderrText = `${this.stderrText}${chunk}`.slice(-8192);
      }
      this.stderrBuffer.push(chunk, (line) => this.emit('stderr', line));
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'EACCES') {
        this.emit('spawnError', err);
        this.connectionFailed = true;
        this.socketClosed = true;
      } else {
        this.logger.error(`Failed to spawn mdb: ${err.message}`);
      }
    });
    child.on('close', (code, signal) => {
      this.processClosed = true;
      this.exitCode = code;
      this.exitSignal = signal;
      if (!this.connected && !this.connectionFailed) {
        this.failConnection();
      }
      this.finishIfClosed();
    });
    this.connectTimer = setTimeout(() => this.failConnection(), this.opts.connectTimeoutMs ?? 10000);
    this.tryConnect();
  }

  send(obj: unknown): void {
    if (this.control.isExited || this.connectionFailed) {
      this.logger.warn('Ignoring message sent to mdb after exit');
      return;
    }
    const message = encodeMessage(obj);
    if (!this.connected || !this.socket || this.socket.destroyed) {
      this.pending.push(message);
      return;
    }
    this.socket.write(message);
  }

  kill(graceMs = 1500): Promise<void> {
    if (this.control.isExited || !this.child) {
      return Promise.resolve();
    }
    this.socket?.destroy();
    return this.control.kill(this.child, graceMs);
  }

  private tryConnect(): void {
    if (this.control.isExited || this.processClosed || this.connectionFailed || this.connecting || !this.socketPath) {
      return;
    }
    this.connecting = true;
    const socket = net.connect(this.socketPath);
    let settled = false;
    const retry = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      this.connecting = false;
      socket.destroy();
      if (!this.connectionFailed && !this.processClosed) {
        this.retryTimer = setTimeout(() => this.tryConnect(), 50);
      }
    };
    socket.once('connect', () => {
      if (settled || this.connectionFailed) {
        socket.destroy();
        return;
      }
      settled = true;
      this.connecting = false;
      this.connected = true;
      this.socket = socket;
      this.socketClosed = false;
      if (this.connectTimer) {
        clearTimeout(this.connectTimer);
      }
      const reader = new MessageReader();
      reader.on('message', (message) => this.emit('message', message));
      reader.on('garbage', (text: string) => this.emit('garbage', text));
      reader.on('error', (payload: string) => this.logger.error(`Invalid JSON from mdb: ${payload}`));
      socket.on('data', (chunk: Buffer) => reader.push(chunk));
      socket.on('end', () => { this.socketClosed = true; this.finishIfClosed(); });
      socket.on('close', () => { this.socketClosed = true; this.finishIfClosed(); });
      socket.on('error', (err) => this.logger.warn(`mdb socket: ${err.message}`));
      for (const message of this.pending.splice(0)) {
        socket.write(message);
      }
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        retry();
      } else {
        this.failConnection(err);
      }
    });
  }

  private failConnection(cause?: Error): void {
    if (this.connectionFailed || this.connected || this.control.isExited) {
      return;
    }
    this.connectionFailed = true;
    this.socketClosed = true;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
    const details = [this.stderrText, this.stdoutText].filter(Boolean).join('\n');
    const error = new Error(`mdb did not accept a connection on ${this.socketPath}${details ? `\n${details}` : ''}`);
    if (cause) {
      (error as NodeJS.ErrnoException).cause = cause;
    }
    this.emit('spawnError', error);
    if (this.child) {
      void this.control.kill(this.child, 1500);
    }
    this.finishIfClosed();
  }

  private finishIfClosed(): void {
    if (!this.processClosed || !this.socketClosed || !this.control.finish()) {
      return;
    }
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
    this.stdoutBuffer.flush((line) => this.emit('stdout', line));
    this.stderrBuffer.flush((line) => this.emit('stderr', line));
    try {
      if (this.socketPath) {
        fs.unlinkSync(this.socketPath);
      }
    } catch { /* The socket may already have been removed by mdb. */ }
    this.emit('exit', { code: this.exitCode, signal: this.exitSignal });
  }
}
