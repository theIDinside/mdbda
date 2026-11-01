import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

interface TraceChoice {
	label: string;
	description: string;
	path: string;
}

export class MdbConfigurationProvider implements vscode.DebugConfigurationProvider {
  constructor(private readonly defaultLogDirectory: () => string) {}

  async resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    configuration: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | undefined> {
    if (configuration.request === 'attach' && !configuration.__mdbChildOf) {
      void vscode.window.showErrorMessage('Attaching to an arbitrary process is not supported by mdb yet.');
      return undefined;
    }
    if (configuration.request === 'attach') {
      return configuration;
    }
    if (Object.keys(configuration).length > 0) {
      return configuration;
    }
    const program = await vscode.window.showInputBox({
      prompt: 'Executable to debug with mdb',
      placeHolder: 'Path to an executable',
    });
    if (!program) {
      return undefined;
    }
    return {
      type: 'mdb',
      request: 'launch',
      name: 'mdb: Launch',
      sessionType: 'ptrace',
      program: path.isAbsolute(program) ? program : path.resolve(folder?.uri.fsPath ?? process.cwd(), program),
    };
  }

  async resolveDebugConfigurationWithSubstitutedVariables(
    folder: vscode.WorkspaceFolder | undefined,
    configuration: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | undefined> {
    if (configuration.request === 'attach') {
      if (!configuration.__mdbChildOf) {
        void vscode.window.showErrorMessage('Attaching to an arbitrary process is not supported by mdb yet.');
        return undefined;
      }
      configuration.sessionType = 'ptrace';
      return configuration;
    }

    const sessionType = configuration.sessionType ?? 'ptrace';
    if (sessionType !== 'ptrace' && sessionType !== 'rr') {
      void vscode.window.showErrorMessage(`Unsupported mdb session type: ${String(sessionType)}`);
      return undefined;
    }
    configuration.sessionType = sessionType;
    const workspacePath = folder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const basePath = typeof configuration.cwd === 'string' && configuration.cwd.length > 0
      ? path.resolve(workspacePath, configuration.cwd)
      : workspacePath;

    if (sessionType === 'ptrace') {
      if (typeof configuration.program !== 'string' || configuration.program.length === 0) {
        void vscode.window.showErrorMessage('A program executable is required for an mdb ptrace launch.');
        return undefined;
      }
      configuration.program = path.resolve(basePath, configuration.program);
      try {
        fs.accessSync(configuration.program, fs.constants.X_OK);
      } catch {
        void vscode.window.showErrorMessage(`Program does not exist or is not executable: ${configuration.program}`);
        return undefined;
      }
    }

    if (Array.isArray(configuration.views)) {
      configuration.views = configuration.views.map((view: string) => path.resolve(basePath, view));
    }

    const warnings: string[] = [];
    if (Array.isArray(configuration.args) && configuration.args.length > 0) {
      warnings.push('mdb currently passes each argument wrapped in literal quote characters, so program arguments may be mangled');
    }
    if (typeof configuration.cwd === 'string' && configuration.cwd.length > 0) {
      warnings.push('mdb currently ignores cwd');
    }
    if (configuration.env && typeof configuration.env === 'object' && Object.keys(configuration.env).length > 0) {
      warnings.push('mdb currently ignores env');
    }
    if (warnings.length > 0) {
      void vscode.window.showWarningMessage(`mdb launch limitations: ${warnings.join('; ')}.`);
    }

    if (sessionType === 'rr') {
      if (typeof configuration.traceDir !== 'string' || configuration.traceDir.length === 0) {
        const traceDir = await this.chooseTraceDirectory();
        if (!traceDir) {
          return undefined;
        }
        configuration.traceDir = traceDir;
      } else {
        configuration.traceDir = path.resolve(basePath, configuration.traceDir);
      }
    }

    const settings = vscode.workspace.getConfiguration('mdb', folder?.uri);
    const requestedMdbPath = typeof configuration.mdbPath === 'string' && configuration.mdbPath.length > 0
      ? configuration.mdbPath
      : settings.get<string>('path', 'mdb');
    const settingName = configuration.mdbPath ? 'launch mdbPath' : 'mdb.path';
    const resolvedMdbPath = this.resolveExecutable(requestedMdbPath, workspacePath);
    if (!resolvedMdbPath) {
      void vscode.window.showErrorMessage(`Could not find an executable for ${settingName}: ${requestedMdbPath}`);
      return undefined;
    }

    const configuredLogDirectory = typeof configuration.logDirectory === 'string' && configuration.logDirectory.length > 0
      ? configuration.logDirectory
      : settings.get<string>('logDirectory', '');
    const logDirectory = configuredLogDirectory.length > 0
      ? path.resolve(workspacePath, configuredLogDirectory)
      : this.defaultLogDirectory();
    const configuredArgs = Array.isArray(configuration.mdbArgs)
      ? configuration.mdbArgs
      : settings.get<string[]>('extraArgs', []);
    const configuredThreads = settings.get<number | null>('threads', null);
    const transport = configuration.transport ?? settings.get<string>('transport', 'stdio');
    if (transport !== 'stdio' && transport !== 'socket') {
      void vscode.window.showErrorMessage(`Unsupported mdb transport: ${String(transport)}`);
      return undefined;
    }
    configuration.__mdb = {
      path: resolvedMdbPath,
      args: configuredArgs,
      logDirectory,
      transport,
      ...(typeof configuredThreads === 'number' && configuredThreads > 0 ? { threads: configuredThreads } : {}),
    };
    return configuration;
  }

  private resolveExecutable(requested: string, workspacePath: string): string | undefined {
    const isExecutable = (candidate: string): boolean => {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    };
    if (path.isAbsolute(requested)) {
      return isExecutable(requested) ? requested : undefined;
    }
    if (requested.includes(path.sep)) {
      const workspaceCandidate = path.resolve(workspacePath, requested);
      return isExecutable(workspaceCandidate) ? workspaceCandidate : undefined;
    }
    for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
      const candidate = path.join(directory, requested);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
    const workspaceCandidate = path.resolve(workspacePath, requested);
    return isExecutable(workspaceCandidate) ? workspaceCandidate : undefined;
  }

  private async chooseTraceDirectory(): Promise<string | undefined> {
    const rrDirectory = path.join(os.homedir(), '.local', 'share', 'rr');
    let entries: string[];
    try {
      entries = fs.readdirSync(rrDirectory);
    } catch {
      void vscode.window.showErrorMessage(`No rr trace directory was found at ${rrDirectory}`);
      return undefined;
    }
    const isDirectory = (candidate: string): boolean => {
      try {
        return fs.statSync(candidate).isDirectory();
      } catch {
        return false;
      }
    };
    const latest = path.join(rrDirectory, 'latest-trace');
    const candidates = [
      ...(entries.includes('latest-trace') && isDirectory(latest) ? [latest] : []),
      ...entries.filter((name) => name !== 'latest-trace')
        .map((name) => path.join(rrDirectory, name))
        .filter(isDirectory),
    ];
    if (candidates.length === 0) {
      void vscode.window.showErrorMessage(`No rr traces were found under ${rrDirectory}`);
      return undefined;
    }
    const choices: TraceChoice[] = candidates.map((candidate) => ({
      label: path.basename(candidate),
      description: candidate,
      path: candidate,
    }));
    const selected = await vscode.window.showQuickPick(choices, { placeHolder: 'Select an rr trace to replay' });
    return selected?.path;
  }
}
