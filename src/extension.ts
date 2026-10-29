import * as path from 'path';
import * as vscode from 'vscode';
import { MdbAdapterFactory } from './vscode/adapterFactory';
import { MdbConfigurationProvider } from './vscode/configProvider';
import { registerCommands } from './vscode/commands';
import { VsCodeHost } from './vscode/host';
import { SessionRegistry } from './vscode/sessionRegistry';

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('mdb', { log: true });
	const registry: SessionRegistry = new Map();
	const trace = vscode.workspace.getConfiguration('mdb').get<boolean>('trace', false);
	const host = new VsCodeHost(output, registry, trace);
	const configProvider = new MdbConfigurationProvider(() =>
		path.join(context.logUri.fsPath, `mdb-${Date.now()}`),
	);
	const adapterFactory = new MdbAdapterFactory(context, host, registry);
	registerCommands(context, registry);

	context.subscriptions.push(
		output,
		vscode.debug.registerDebugConfigurationProvider('mdb', configProvider),
		vscode.debug.registerDebugAdapterDescriptorFactory('mdb', adapterFactory),
	);
}

export function deactivate(): void {}
