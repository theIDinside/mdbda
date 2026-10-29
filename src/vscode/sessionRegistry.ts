import * as vscode from 'vscode';
import { MdbConnection } from '../core/connection';
import { MdbSessionAdapter } from '../core/sessionAdapter';

export interface SessionRecord {
	connection: MdbConnection;
	adapter: MdbSessionAdapter;
	session: vscode.DebugSession;
}

export type SessionRegistry = Map<string, SessionRecord>;
