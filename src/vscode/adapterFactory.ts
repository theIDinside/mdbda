import * as vscode from 'vscode';
import { MdbConnection } from '../core/connection';
import { MdbProcess } from '../core/mdbProcess';
import { MdbSocketProcess } from '../core/mdbSocketProcess';
import { MdbSessionAdapter } from '../core/sessionAdapter';
import { Host } from '../core/host';
import { SessionRegistry } from './sessionRegistry';

export class MdbAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  constructor(
    context: vscode.ExtensionContext,
		private readonly host: Host,
		readonly registry: SessionRegistry,
  ) {
    context.subscriptions.push(
      vscode.debug.onDidTerminateDebugSession((session) => {
        const record = this.registry.get(session.id);
        if (!record) {
          return;
        }
        this.registry.delete(session.id);
        record.adapter.dispose();
        if (!record.adapter.root) {
          // The root adapter stops its children itself; this catches any VS Code still shows after it is gone.
          for (const child of this.registry.values()) {
            if (child.adapter.root === record.adapter) {
              void vscode.debug.stopDebugging(child.session);
            }
          }
        }
      }),
      vscode.debug.onDidChangeActiveDebugSession((session) => {
        const record = session ? this.registry.get(session.id) : undefined;
        const isReplay = Boolean(session?.type === 'mdb' && record?.adapter.sessionType === 'rr');
        const singleThreadControl = Boolean(session?.type === 'mdb' && record?.adapter.sessionType === 'ptrace');
        void vscode.commands.executeCommand('setContext', 'mdb.isReplay', isReplay);
        void vscode.commands.executeCommand('setContext', 'mdb.singleThreadControl', singleThreadControl);
      }),
    );
  }

  createDebugAdapterDescriptor(session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    const existing = this.registry.get(session.id);
    if (existing) {
      return new vscode.DebugAdapterInlineImplementation(existing.adapter);
    }

    const configuration = session.configuration;
    let connection: MdbConnection;
    let adapter: MdbSessionAdapter;
    if (configuration.request === 'attach') {
      const rootId = configuration.__mdbRoot;
      const root = typeof rootId === 'string' ? this.registry.get(rootId) : undefined;
      if (!root) {
        throw new Error(`Cannot attach fork child: root debug session ${String(rootId)} is no longer active.`);
      }
      connection = root.connection;
      adapter = new MdbSessionAdapter(connection, this.host, {
        sessionType: 'ptrace',
        isChild: true,
        childPid: Number(configuration.processId),
        root: root.adapter,
        config: configuration,
      });
    } else {
      const processConfig = configuration.__mdb;
      if (!processConfig || typeof processConfig.path !== 'string' || typeof processConfig.logDirectory !== 'string') {
        throw new Error('The resolved mdb configuration is missing. Reopen the launch configuration and try again.');
      }
      const mdbProcessOptions = {
        path: processConfig.path,
        args: Array.isArray(processConfig.args) ? processConfig.args : [],
        logDirectory: processConfig.logDirectory,
        threads: typeof processConfig.threads === 'number' ? processConfig.threads : undefined,
      };
      const mdbProcess = processConfig.transport === 'socket'
        ? new MdbSocketProcess(mdbProcessOptions)
        : new MdbProcess(mdbProcessOptions);
      connection = new MdbConnection(
        mdbProcess,
        processConfig.logDirectory,
        this.host.logger,
        undefined,
        this.host.trace,
      );
      adapter = new MdbSessionAdapter(connection, this.host, {
        sessionType: configuration.sessionType === 'rr' ? 'rr' : 'ptrace',
        isChild: false,
        config: configuration,
        shimRuns: Array.isArray(configuration.childDebuggerArgs) && typeof processConfig.shimPath === 'string'
          ? {
            name: configuration.name ?? 'mdb',
            program: configuration.program,
            args: Array.isArray(configuration.args) ? configuration.args : [],
            cwd: configuration.cwd,
            env: configuration.env,
            childDebuggerArgs: configuration.childDebuggerArgs,
            shimPath: processConfig.shimPath,
          }
          : undefined,
      });
    }

    this.registry.set(session.id, { connection, adapter, session });
    return new vscode.DebugAdapterInlineImplementation(adapter);
  }
}
