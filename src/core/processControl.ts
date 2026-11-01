import { ChildProcess } from 'child_process';

export class ProcessControl {
  private exited = false;
  private exitPromise?: Promise<void>;
  private resolveExit?: () => void;

  get isExited(): boolean {
    return this.exited;
  }

  kill(child: ChildProcess, graceMs: number): Promise<void> {
    if (this.exited) {
      return Promise.resolve();
    }
    if (!this.exitPromise) {
      this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
    }
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (!this.exited) {
        child.kill('SIGKILL');
      }
    }, graceMs);
    return this.exitPromise.finally(() => clearTimeout(timer));
  }

  finish(): boolean {
    if (this.exited) {
      return false;
    }
    this.exited = true;
    this.resolveExit?.();
    return true;
  }
}
