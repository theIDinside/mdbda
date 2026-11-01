import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Host, TerminalRun } from './host';
import { substituteChildDebuggerArgs } from './rewrites';
import { ShimConnection, ShimHello, ShimListener } from './shimListener';

export interface ShimRunsOptions {
	name: string;
	program: string;
	args: string[];
	cwd?: string;
	env?: Record<string, string>;
	childDebuggerArgs: string[];
	shimPath: string;
	mdbPid: number;
}

/** The session that attaches mdb to each shim, one at a time. */
export interface ShimRunsTarget {
	/** Attaches mdb to the shim and configures it; the shim is told to exec once this resolves. */
	attachShim(hello: ShimHello): Promise<void>;
	runnerExited(exitCode: number | undefined): void;
	output(text: string): void;
}

type ShimRunState = 'waiting' | 'attaching' | 'running' | 'stopped';

/**
 * Runs a command (a test harness) that starts its debuggee through mdb_shim, and hands each shim that connects
 * to the session: waiting → attaching → running → waiting for the next one. Only one shim is debugged at a
 * time; others are refused.
 */
export class ShimRuns {
  private state: ShimRunState = 'waiting';
  private readonly listener = new ShimListener();
  private readonly connections = new Set<ShimConnection>();
  private socketDirectory: string | undefined;
  private runner: TerminalRun | undefined;

  constructor(
		private readonly host: Host,
		private readonly target: ShimRunsTarget,
		private readonly options: ShimRunsOptions,
  ) {
    this.listener.on('connection', (connection: ShimConnection) => this.onConnection(connection));
  }

  /** Starts listening for shims, then starts the command. */
  async start(): Promise<void> {
    this.socketDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mdbda-shim-'));
    const socketPath = path.join(this.socketDirectory, 'handoff.sock');
    await this.listener.listen(socketPath);
    // Runners append the program and its arguments after the debugger arguments, hence the trailing --.
    const debuggerArgs = substituteChildDebuggerArgs(this.options.childDebuggerArgs, this.options.shimPath,
      ['--tracer-pid', String(this.options.mdbPid), '--socket', socketPath, '--']);
    this.runner = this.host.runInTerminal({
      name: this.options.name,
      program: this.options.program,
      args: [...this.options.args, ...debuggerArgs],
      cwd: this.options.cwd,
      env: this.options.env,
    });
    this.runner.onExit((exitCode) => {
      this.runner = undefined;
      if (this.state !== 'stopped') {
        this.target.runnerExited(exitCode);
      }
    });
  }

  /** The debugged process exited; accept the next shim. */
  runEnded(): void {
    if (this.state === 'running') {
      this.state = 'waiting';
    }
  }

  async dispose(): Promise<void> {
    if (this.state === 'stopped') {
      return;
    }
    this.state = 'stopped';
    for (const connection of this.connections) {
      connection.error('The mdb debug session has ended');
      connection.destroy();
    }
    this.connections.clear();
    this.runner?.kill();
    this.runner = undefined;
    await this.listener.close();
    if (this.socketDirectory) {
      fs.rmSync(this.socketDirectory, { recursive: true, force: true });
      this.socketDirectory = undefined;
    }
  }

  private onConnection(connection: ShimConnection): void {
    if (this.state === 'stopped') {
      connection.destroy();
      return;
    }
    this.connections.add(connection);
    connection.on('closed', () => this.connections.delete(connection));
    connection.on('invalid', (message: string) => this.target.output(`mdb_shim: ${message}\n`));
    connection.once('hello', (hello: ShimHello) => void this.onHello(connection, hello));
  }

  private async onHello(connection: ShimConnection, hello: ShimHello): Promise<void> {
    if (this.state !== 'waiting') {
      connection.error(this.state === 'stopped'
        ? 'The mdb debug session has ended'
        : 'mdb is already debugging another process; only one process is debugged at a time');
      this.target.output(`Refused ${hello.argv[0]} (pid ${hello.pid}): another process is being debugged\n`);
      return;
    }
    this.state = 'attaching';
    try {
      await this.target.attachShim(hello);
    } catch (error) {
      const message = `mdb could not attach to ${hello.argv[0]} (pid ${hello.pid}): ${errorMessage(error)}`;
      connection.error(message);
      this.target.output(`${message}\n`);
      if (this.state === 'attaching') {
        this.state = 'waiting';
      }
      return;
    }
    if (this.state !== 'attaching') {
      connection.error('The mdb debug session has ended');
      return;
    }
    // A shim that disconnected exits without exec; mdb reports that exit like any other, which ends the run.
    if (connection.closed) {
      this.target.output(`mdb_shim ${hello.pid} disconnected before it was allowed to run\n`);
    }
    connection.go();
    this.state = 'running';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
