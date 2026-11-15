import { randomBytes } from 'node:crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { SessionRegistry } from './sessionRegistry';

export const PROCESSES_VIEW = 'mdb.processes';

/** One row of the Processes panel. This is the whole contract with media/processPanel.js. */
export interface PanelProcess {
	/** VS Code debug session id; the key the panel sends back with actions. */
	id: string;
	/** Short name, P1, P2, …, in the order the processes started. */
	name: string;
	pid: number;
	/** Session id of the process that forked this one. */
	parentId?: string;
	argv: string[];
	state: 'running' | 'stopped' | 'exited';
}

interface RunState {
	state: PanelProcess['state'];
	/** Thread that last stopped; continuing it continues the process. */
	threadId?: number;
}

/**
 * The "mdb: Processes" view in the Run and Debug sidebar. It lists the process of every mdb session and lets the
 * user pause or continue each one. Run state comes from the DAP messages the sessions send VS Code.
 */
export class ProcessPanel implements vscode.WebviewViewProvider, vscode.DebugAdapterTrackerFactory {
  private view: vscode.WebviewView | undefined;
  private readonly names = new Map<string, string>();
  private readonly runState = new Map<string, RunState>();
  private nextName = 1;
  private postScheduled = false;

  constructor(private readonly context: vscode.ExtensionContext, private readonly registry: SessionRegistry) {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(PROCESSES_VIEW, this),
      vscode.debug.registerDebugAdapterTrackerFactory('mdb', this),
      vscode.debug.onDidStartDebugSession(() => this.refresh()),
      vscode.debug.onDidTerminateDebugSession((session) => {
        this.runState.delete(session.id);
        this.names.delete(session.id);
        if (this.names.size === 0) {
          this.nextName = 1;
        }
        this.refresh();
      }),
    );
  }

  createDebugAdapterTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker {
    return {
      onDidSendMessage: (message) => {
        if(message.type === 'event') {
          if(message.event === 'stopped') {
            this.runState.set(session.id, { state: 'stopped', threadId: message.body?.threadId });
          } else if(message.event === 'continued') {
            this.runState.set(session.id, { state: 'running' });
          } else if(message.event === 'exited' || message.event === 'terminated') {
            this.runState.set(session.id, { state: 'exited' });
          }
        } else if(message.type !== 'response' || (message.command !== 'launch' && message.command !== 'attach')) {
          return;
        }

        // A launch or attach response means the session now knows its pid.
        this.refresh();
      },
    };
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((message) => {
      void this.handle(message).catch((error: unknown) => {
        void vscode.window.showErrorMessage(`mdb: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
    view.onDidChangeVisibility(() => this.refresh());
    view.onDidDispose(() => { this.view = undefined; });
  }

  /** Sends the process list to the panel; several calls in a row send it once. */
  refresh(): void {
    if (this.postScheduled) {
      return;
    }
    this.postScheduled = true;
    setTimeout(() => {
      this.postScheduled = false;
      if (this.view?.visible) {
        void this.view.webview.postMessage({ type: 'processes', processes: this.processes() });
      }
    }, 20);
  }

  postUpdate(data: any): void {

  }

  private processes(): PanelProcess[] {
    const result: PanelProcess[] = [];
    for (const [id, record] of this.registry) {
      if (!record.adapter.isAttached) {
        continue;
      }
      if (!this.names.has(id)) {
        this.names.set(id, `P${this.nextName++}`);
      }
      const parentId = record.session.configuration.__mdbChildOf;
      result.push({
        id,
        name: this.names.get(id)!,
        pid: record.adapter.pid,
        parentId: typeof parentId === 'string' ? parentId : undefined,
        argv: readArgv(record.adapter.pid),
        state: this.runState.get(id)?.state ?? 'running',
      });
    }
    return result;
  }

  private async handle(message: { type: string; id?: string; action?: string }): Promise<void> {
    if (message.type === 'ready') {
      this.refresh();
      return;
    }
    const record = message.id !== undefined ? this.registry.get(message.id) : undefined;
    if (!record) {
      return;
    }
    switch (message.type) {
    case 'pause':
      await record.session.customRequest('pause', { threadId: record.adapter.pid });
      return;
    case 'continue':
      await record.adapter.continueProcess(this.runState.get(message.id!)?.threadId);
      return;
    case 'menu':
      return this.menuAction(record.session, record.adapter.pid, String(message.action));
    }
  }

  /** The actions of the row's "…" menu; media/processPanel.js lists them. */
  private async menuAction(session: vscode.DebugSession, pid: number, action: string): Promise<void> {
    switch (action) {
    case 'copyPid':
      await vscode.env.clipboard.writeText(String(pid));
      return;
    case 'copyCommandLine':
      await vscode.env.clipboard.writeText(readArgv(pid).join(' '));
      return;
    case 'stop':
      await vscode.debug.stopDebugging(session);
      return;
    }
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const uri = (...parts: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(media, ...parts)).toString();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('codicons', 'codicon.css')}">
<link rel="stylesheet" href="${uri('processPanel.css')}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${uri('processPanel.js')}"></script>
</body>
</html>`;
  }
}

/** A process's command line, from /proc; empty if the process is gone. */
function readArgv(pid: number): string[] {
  try {
    const parts = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    if (parts[parts.length - 1] === '') {
      parts.pop();
    }
    return parts;
  } catch {
    return [];
  }
}
