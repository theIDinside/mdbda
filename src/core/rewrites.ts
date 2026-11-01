import * as path from 'path';
import { Breakpoint, Event, SessionType } from './protocol';

type AnyRecord = Record<string, any>;

export interface ConditionWarning {
	message: string;
}

export function rewriteNext<T extends AnyRecord>(args: T): T {
  const rewritten: AnyRecord = { ...args };
  if (rewritten.granularity === 'statement') {
    rewritten.granularity = 'line';
  }
  return rewritten as T;
}

export function rewriteDisassemble<T extends AnyRecord>(args: T): T {
  return {
    ...args,
    offset: args.offset ?? 0,
    instructionOffset: args.instructionOffset ?? 0,
  };
}

export function foldMemoryOffset<T extends AnyRecord>(args: T): T {
  const rewritten: AnyRecord = { ...args };
  if (rewritten.offset !== undefined && rewritten.memoryReference !== undefined) {
    const reference = String(rewritten.memoryReference).replace(/^0[xX]/, '');
    rewritten.memoryReference = `0x${(BigInt(`0x${reference}`) + BigInt(rewritten.offset)).toString(16)}`;
  }
  delete rewritten.offset;
  return rewritten as T;
}

export function sliceStackTrace<T extends AnyRecord>(args: AnyRecord, body: T): T {
  const frames = Array.isArray(body.stackFrames) ? body.stackFrames : [];
  const start = Math.max(0, Math.trunc(Number(args.startFrame ?? 0)));
  const requestedLevels = Number(args.levels ?? 0);
  const end = requestedLevels > 0 ? start + Math.trunc(requestedLevels) : frames.length;
  return { ...body, stackFrames: frames.slice(start, end), totalFrames: frames.length };
}

export interface SetBreakpointsResult {
	forward: AnyRecord;
	local: Map<number, Breakpoint>;
	mapping: Map<number, number>;
	warnings: ConditionWarning[];
}

function hasCondition(breakpoint: AnyRecord): boolean {
  return breakpoint.condition !== undefined || breakpoint.hitCondition !== undefined;
}

function conditionWarning(location: string): ConditionWarning {
  return { message: `mdb: breakpoint conditions are not supported yet; ignoring condition on ${location}` };
}

export function rewriteSetBreakpoints(args: AnyRecord): SetBreakpointsResult {
  const requested: AnyRecord[] = Array.isArray(args.breakpoints)
    ? args.breakpoints
    : Array.isArray(args.lines) ? args.lines.map((line: number) => ({ line })) : [];
  const forwardBreakpoints: AnyRecord[] = [];
  const local = new Map<number, Breakpoint>();
  const mapping = new Map<number, number>();
  const warnings: ConditionWarning[] = [];
  const file = args.source?.path ?? args.source?.name ?? '<unknown>';

  requested.forEach((original, requestedIndex) => {
    const breakpoint = { ...original };
    const requestedLine = breakpoint.line ?? args.lines?.[requestedIndex];
    if (breakpoint.line === undefined && requestedLine !== undefined) {
      breakpoint.line = requestedLine;
    }
    if (hasCondition(breakpoint)) {
      warnings.push(conditionWarning(`${file}:${requestedLine ?? '?'}`));
      delete breakpoint.condition;
      delete breakpoint.hitCondition;
    }
    if (breakpoint.logMessage !== undefined) {
      local.set(requestedIndex, {
        verified: false,
        line: requestedLine,
        message: 'Log points are not supported by mdb yet',
      });
      return;
    }
    mapping.set(requestedIndex, forwardBreakpoints.length);
    forwardBreakpoints.push(breakpoint);
  });

  const forward: AnyRecord = { ...args, breakpoints: forwardBreakpoints };
  if (Array.isArray(args.lines)) {
    forward.lines = requested
      .map((breakpoint, index) => ({ line: breakpoint.line ?? args.lines[index], index }))
      .filter(({ index }) => mapping.has(index))
      .map(({ line }) => line);
  }
  return { forward, local, mapping, warnings };
}

export function alignSetBreakpointsResponse(
  requested: AnyRecord[],
  mapping: ReadonlyMap<number, number>,
  local: ReadonlyMap<number, Breakpoint>,
  mdbBreakpoints: Breakpoint[],
): Breakpoint[] {
  const usedIds = new Map<number, number>();
  const usedObjects = new Map<Breakpoint, number>();
  const result: Breakpoint[] = [];

  requested.forEach((request, requestedIndex) => {
    const localBreakpoint = local.get(requestedIndex);
    if (localBreakpoint) {
      result.push({ ...localBreakpoint });
      return;
    }
    if (!mapping.has(requestedIndex)) {
      result.push({ verified: false, line: request.line, message: 'No breakpoint location found' });
      return;
    }

    const line = Number(request.line);
    const eligible = (bp: Breakpoint): boolean => {
      const priorLine = bp.id !== undefined ? usedIds.get(bp.id) : usedObjects.get(bp);
      return priorLine === undefined || priorLine === line;
    };
    const candidates = mdbBreakpoints
      .map((breakpoint) => ({ breakpoint }))
      .filter(({ breakpoint }) => eligible(breakpoint));
    const exact = candidates.filter(({ breakpoint }) => breakpoint.line === request.line);
    let selected = exact.find(({ breakpoint }) => breakpoint.verified) ?? exact[0];
    if (!selected) {
      selected = candidates
        .filter(({ breakpoint }) => breakpoint.line !== undefined && breakpoint.line > line)
        .sort((a, b) => (a.breakpoint.line as number) - (b.breakpoint.line as number))[0];
    }
    if (!selected) {
      result.push({ verified: false, line: request.line, message: 'No breakpoint location found' });
      return;
    }
    const selectedBreakpoint = selected.breakpoint;
    if (selectedBreakpoint.id !== undefined) {
      usedIds.set(selectedBreakpoint.id, line);
    } else {
      usedObjects.set(selectedBreakpoint, line);
    }
    result.push({ ...selectedBreakpoint });
  });

  return result;
}

export function rewriteSetFunctionBreakpoints(args: AnyRecord): { forward: AnyRecord; warnings: ConditionWarning[] } {
  const warnings: ConditionWarning[] = [];
  const breakpoints = (Array.isArray(args.breakpoints) ? args.breakpoints : []).map((original: AnyRecord) => {
    const breakpoint = { ...original };
    if (hasCondition(breakpoint)) {
      warnings.push(conditionWarning(`${breakpoint.name ?? '<unknown>'}:?`));
      delete breakpoint.condition;
      delete breakpoint.hitCondition;
    }
    if (typeof breakpoint.name === 'string' && breakpoint.name.startsWith('/') && breakpoint.name.endsWith('/')) {
      breakpoint.name = breakpoint.name.slice(1, -1);
      breakpoint.regex = true;
    }
    return breakpoint;
  });
  return { forward: { ...args, breakpoints }, warnings };
}

export function buildLaunchArgs(config: AnyRecord, configToken: string): AnyRecord {
  const cwd = typeof config.cwd === 'string' ? config.cwd : undefined;
  const launch: AnyRecord = {
    type: (config.sessionType ?? 'ptrace') as SessionType,
    configToken,
  };
  if (config.program !== undefined) {
    launch.program = path.resolve(cwd ?? process.cwd(), config.program);
  }
  for (const key of ['args', 'stopOnEntry', 'breakpointBehavior', 'traceDir'] as const) {
    if (config[key] !== undefined) {
      launch[key] = config[key];
    }
  }
  if (Array.isArray(config.views)) {
    launch.views = config.views.map((view: string) => path.resolve(cwd ?? process.cwd(), view));
  }
  return launch;
}

export function buildChildAttachArgs(childPid: number, configToken: string): AnyRecord {
  return { sessionType: 'ptrace', processId: childPid, configToken };
}

export function wrapCustomRequest(command: string, args?: AnyRecord): AnyRecord {
  return { command: 'customRequest', arguments: { command, arguments: args ?? {} } };
}

export function stripMdbEventFields(event: Event): { event: Event; processes?: number[] } {
  // Copy and delete rather than destructure: Omit<> on a type with an index signature drops the named fields.
  const stripped: Event = { ...event };
  delete stripped.processId;
  let processes: number[] | undefined;
  if (stripped.event === 'stopped' && stripped.body) {
    const body = { ...stripped.body };
    if (Array.isArray(body.processes)) {
      processes = body.processes as number[];
    }
    delete body.processes;
    stripped.body = body;
  }
  return { event: stripped, processes };
}


export function shellQuote(argument: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(argument) ? argument : `'${argument.replace(/'/g, `'\\''`)}'`;
}

/** Substitutes `{shimPath}` and `{shimArgs}` in a runner's debugger argument templates. */
export function substituteChildDebuggerArgs(templates: string[], shimPath: string, shimArgs: string[]): string[] {
  const quotedShimArgs = shimArgs.map(shellQuote).join(' ');
  return templates.map((template) => template.replaceAll('{shimPath}', shimPath).replaceAll('{shimArgs}', quotedShimArgs));
}
