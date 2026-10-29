import * as path from 'path';
import * as vscode from 'vscode';
import { SessionRegistry } from './sessionRegistry';

export function registerCommands(context: vscode.ExtensionContext, registry: SessionRegistry): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('mdb.continueAll', () => sendCustomRequest(registry, 'continueAll')),
		vscode.commands.registerCommand('mdb.pauseAll', () => sendCustomRequest(registry, 'pauseAll')),
		vscode.commands.registerCommand('mdb.loadViews', () => loadViews(registry)),
		vscode.commands.registerCommand('mdb.selectReplayProcess', () => selectReplayProcess(registry)),
		vscode.commands.registerCommand('mdb.reverseContinue', () => reverseContinue(registry)),
	);
}

async function sendCustomRequest(registry: SessionRegistry, command: string): Promise<void> {
	const record = activeMdbSession(registry);
	if (!record) {
		return;
	}
	try {
		await record.session.customRequest(command);
	} catch (error) {
		showCommandError(error);
	}
}

async function loadViews(registry: SessionRegistry): Promise<void> {
	const record = activeMdbSession(registry);
	if (!record) {
		return;
	}
	const selected = await vscode.window.showOpenDialog({
		canSelectMany: false,
		openLabel: 'Load Views',
		filters: { 'mdb view files': ['mdbv'] },
	});
	if (!selected || selected.length === 0) {
		return;
	}
	const expression = `loadViews(${JSON.stringify(path.resolve(selected[0].fsPath))})`;
	try {
		const result = await record.session.customRequest('evaluate', { context: 'repl', expression });
		const diagnostics = result?.result ?? result?.body?.result ?? result;
		const output = typeof diagnostics === 'string' ? diagnostics : JSON.stringify(diagnostics) ?? String(diagnostics);
		vscode.debug.activeDebugConsole.appendLine(output);
	} catch (error) {
		showCommandError(error);
	}
}

async function selectReplayProcess(registry: SessionRegistry): Promise<void> {
	const record = activeMdbSession(registry);
	if (!record || record.adapter.sessionType !== 'rr') {
		return;
	}
	const choices = record.adapter.processes.map((pid) => ({ label: String(pid), pid }));
	if (choices.length === 0) {
		void vscode.window.showInformationMessage('mdb has not reported any replay processes yet.');
		return;
	}
	const selected = await vscode.window.showQuickPick(choices, { placeHolder: 'Select an rr replay process' });
	if (selected) {
		record.adapter.selectProcess(selected.pid);
	}
}

async function reverseContinue(registry: SessionRegistry): Promise<void> {
	const record = activeMdbSession(registry);
	if (!record || record.adapter.sessionType !== 'rr') {
		return;
	}
	const activeStackItem = vscode.debug.activeStackItem;
	if (!activeStackItem || activeStackItem.session.id !== record.session.id) {
		void vscode.window.showWarningMessage('Select a thread in the active rr session before reversing.');
		return;
	}
	try {
		await record.session.customRequest('reverseContinue', { threadId: activeStackItem.threadId });
	} catch (error) {
		showCommandError(error);
	}
}

function activeMdbSession(registry: SessionRegistry) {
	const session = vscode.debug.activeDebugSession;
	if (!session || session.type !== 'mdb') {
		return undefined;
	}
	return registry.get(session.id);
}

function showCommandError(error: unknown): void {
	void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
}
