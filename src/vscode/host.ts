import * as vscode from 'vscode';
import { Host } from '../core/host';
import { Logger } from '../core/logger';
import { MdbSessionAdapter } from '../core/sessionAdapter';
import { SessionRegistry } from './sessionRegistry';

export class VsCodeHost implements Host {
	readonly logger: Logger;

	constructor(
		output: vscode.LogOutputChannel,
		private readonly registry: SessionRegistry,
		readonly trace: boolean,
	) {
		// DAP traffic is only traced when mdb.trace is on, so log it at info level: LogOutputChannel.trace would
		// hide it unless the user also changed the channel's log level.
		this.logger = {
			trace: (msg) => output.info(msg),
			info: (msg) => output.info(msg),
			warn: (msg) => output.warn(msg),
			error: (msg) => output.error(msg),
		};
	}

	startChildSession(parent: MdbSessionAdapter, childPid: number, name: string): void {
		const parentRecord = [...this.registry.values()].find((record) => record.adapter === parent);
		if (!parentRecord) {
			this.logger.warn(`Cannot start fork child ${childPid}: parent debug session is no longer registered`);
			return;
		}
		void vscode.debug.startDebugging(
			parentRecord.session.workspaceFolder,
			{
				type: 'mdb',
				request: 'attach',
				name,
				processId: childPid,
				__mdbChildOf: parentRecord.session.id,
			},
			{
				parentSession: parentRecord.session,
				lifecycleManagedByParent: true,
				consoleMode: vscode.DebugConsoleMode.MergeWithParent,
				compact: true,
			},
		).then((started) => {
			if (!started) {
				this.logger.warn(`VS Code declined to start fork child session ${childPid}`);
			}
		}, (error: unknown) => {
			this.showError(`Could not start fork child session ${childPid}: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	showError(message: string): void {
		void vscode.window.showErrorMessage(message);
	}
}
