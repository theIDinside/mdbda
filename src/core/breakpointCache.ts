import { Breakpoint, Event } from './protocol';

type AnyRecord = Record<string, any>;

export const CACHED_BREAKPOINT_COMMANDS: ReadonlySet<string> = new Set([
  'setBreakpoints', 'setFunctionBreakpoints', 'setInstructionBreakpoints',
]);

export interface CachedBreakpointRequest {
	command: string;
	args: AnyRecord;
	/** Adapter ids VS Code last received for this request, by requested index. */
	ids: number[];
}

function requestedBreakpoints(command: string, args: AnyRecord): AnyRecord[] {
  if (Array.isArray(args.breakpoints)) {
    return args.breakpoints;
  }
  if (command === 'setBreakpoints' && Array.isArray(args.lines)) {
    return args.lines.map((line: number) => ({ line }));
  }
  return [];
}

/**
 * Remembers the latest breakpoint requests so they can be replayed to every process that a session attaches to
 * in turn, and owns the breakpoint ids VS Code sees: mdb assigns new ids for every process, VS Code keeps the
 * ids it got when it set the breakpoints.
 */
export class BreakpointCache {
  private readonly requests = new Map<string, CachedBreakpointRequest>();
  private readonly mdbToAdapter = new Map<number, number>();
  private nextId = 1;

  static key(command: string, args: AnyRecord): string {
    return command === 'setBreakpoints' ? `${command}:${args.source?.path ?? args.source?.name ?? ''}` : command;
  }

  /** Stores `args` as the latest request of its kind and returns fresh adapter ids for its breakpoints. */
  record(command: string, args: AnyRecord): number[] {
    const ids = requestedBreakpoints(command, args).map(() => this.nextId++);
    this.requests.set(BreakpointCache.key(command, args), { command, args, ids });
    return ids;
  }

  cached(): CachedBreakpointRequest[] {
    return [...this.requests.values()];
  }

  /** Breakpoints to report for `ids` while no process is attached. */
  unverified(command: string, args: AnyRecord, ids: number[]): Breakpoint[] {
    const requested = requestedBreakpoints(command, args);
    return ids.map((id, index) => ({
      id,
      verified: false,
      ...(requested[index]?.line !== undefined ? { line: requested[index].line } : {}),
      message: 'Waiting for a process to attach to',
    }));
  }

  /** Maps mdb's response breakpoints (aligned with the request) to adapter ids. */
  bind(ids: number[], mdbBreakpoints: Breakpoint[]): Breakpoint[] {
    return ids.map((id, index) => {
      const breakpoint = mdbBreakpoints[index] ?? { verified: false, message: 'mdb did not report this breakpoint' };
      if (breakpoint.id !== undefined) {
        this.mdbToAdapter.set(breakpoint.id, id);
      }
      return { ...breakpoint, id };
    });
  }

  /** Forgets mdb's ids; called when the attached process exits. */
  resetRun(): void {
    this.mdbToAdapter.clear();
  }

  translateEvent(event: Event): Event {
    if (event.event === 'stopped' && Array.isArray(event.body?.hitBreakpointIds)) {
      const hitBreakpointIds = (event.body.hitBreakpointIds as number[]).map((id) => this.mdbToAdapter.get(id) ?? id);
      return { ...event, body: { ...event.body, hitBreakpointIds } };
    }
    if (event.event === 'breakpoint' && event.body?.breakpoint) {
      const breakpoint = event.body.breakpoint as Breakpoint;
      const id = breakpoint.id !== undefined ? this.mdbToAdapter.get(breakpoint.id) : undefined;
      if (id !== undefined) {
        return { ...event, body: { ...event.body, breakpoint: { ...breakpoint, id } } };
      }
    }
    return event;
  }
}
