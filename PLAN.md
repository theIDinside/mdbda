# mdbda implementation plan

Goal: turn this `yo code` scaffold into a VS Code extension that debugs C/C++ programs with **mdb**, the debugger in
`/home/sfarre/dev/dbm`. mdb is already a DAP server, so this extension doesn't implement debugging itself. It is a
**protocol proxy**: it spawns mdb, rewrites messages in both directions, hides mdb's non-standard parts from VS Code, and
blocks requests that would crash mdb.

All `dbm/...` references are relative to `/home/sfarre/dev/dbm`. Read the cited code before relying on a detail; the
line numbers were correct on 2026-10-29 (branch `squash-scripting-engine`).

Prior art: `/home/sfarre/dev/midas` (the `midas-native` debugger type, `modules/dap/mdb.js` and
`modules/providers/midas-native.js`) already drives mdb. Use it as a reference for *what* mdb needs. **Don't copy its
code.** Its framing counts UTF-16 characters instead of bytes, it never reads stderr, and its config schema is stale.

---

## 1. How mdb speaks DAP: the facts the design rests on

### 1.1 Process and transport

- Command: `mdb [-t N] [-l LOGDIR] [-i stdio|unix:/tmp/x] [-w MS]` (`dbm/src/configuration/config.cpp:20-145`).
  - Use **stdio** (the default).
  - `-l` is a log **directory** that must already exist, otherwise mdb exits (`config.cpp:36-49`). If it isn't given,
    mdb writes `*.log` files into its cwd. The extension must create the directory and always pass `-l`.
  - Argument parse errors are printed to **stdout**, and then mdb exits with -1.
- Framing: `Content-Length: N\r\n\r\n<json>`, where N is in **bytes**.
  - mdb accepts only the `Content-Length` header (`dbm/src/interface/dap/parse_buffer.cpp:6`).
  - mdb's read buffer is 64 KB, so a request larger than that will trip a VERIFY in mdb.
- `TODO()` and `PANIC` print plain text to **stdout** just before they abort (`dbm/src/utils/todo.h:23-32`). The parser
  must survive junk on stdout: skip ahead to the next `Content-Length:`, and log the junk.
- The tracee's stdout goes over a pty. mdb forwards it as `output` events with `category:"stdout"`, so it never mixes
  into the DAP stream.
- **stderr must be drained**, otherwise the pipe fills and mdb stalls. Send it to the output channel.
- mdb shuts itself down when the last traced process exits or disconnects (`dbm/src/tracer.cpp:107-118`).

### 1.2 Protocol extensions mdb requires (the proxy must add these)

| What | Where | Notes |
|---|---|---|
| Top-level `processId: number` on **every** request | `dbm/src/interface/dap/commands.cpp:2531-2549` | Without it the parse returns `nullptr`, which is then dereferenced, so mdb crashes. `arguments` must also always be present (`{}` if empty). |
| `arguments.configToken: string` | `initialize`, `launch`, `attach`, `configurationDone`, `setBreakpoints`, `setFunctionBreakpoints`, `setInstructionBreakpoints` | Use one UUID per session. A missing token on `initialize` is an assert failure, and on a pre-launch `setBreakpoints` it is a `TODO` crash (`commands.cpp:846-855, 1317`). |
| `initialize.arguments.RRSession: bool` | `commands.cpp:1313` | Switches `supportsStepBack` and `supportsSingleThreadExecutionRequests`. |
| `launch.arguments.type` must be `"ptrace"` or `"rr"` | `commands.cpp:1465` | VS Code puts `type: "<debugger type>"` into the launch args, so **overwrite it** with the session type. |
| `attach.arguments.sessionType` and `processId` | `commands.cpp:1755-1854` | Only works for a process mdb **already traces**, such as a fork child. Any other pid is a `TODO` crash (`dbm/src/tracer.cpp:294-307`). |

Every response and event mdb emits carries a top-level `processId`, which is the task-leader pid. `seq` is always 0.
Responses echo `request_seq`. Exceptions:
- `initialize` responses always have `processId: 0`.
- The `customRequest` responses (`continueAll`, `pauseAll`, `getProcesses`) have **no** `processId`
  (`dbm/src/interface/dap/custom_commands.cpp:58,83,139`).

So responses are routed by **`request_seq`** and events by **`processId`**.

### 1.3 Session lifecycle

1. The client sends `initialize {configToken, RRSession}`. mdb returns the capabilities and then an `initialized` event.
   That event's top-level `processId` is the one the request carried.
2. VS Code sends breakpoints. Before a process exists, mdb queues them and returns `breakpoints: []`. Later it sends
   `breakpoint` events with `reason:"new"`.
3. `launch` and `configurationDone` can arrive in either order; mdb starts the process when the second one arrives
   (`dbm/src/interface/dap/interface.cpp:434-486`). The `launch` response is `body:{processId}`, and rr adds
   `processes:[...]`. The `configurationDone` response is `body:{postponed}`.
4. From then on, every request must carry `processId = launch.body.processId`.
   - Before that, use a placeholder id. The test client uses a counter starting at 1 (`dbm/test/driver/client.js:18-27`).
   - Events for the real pid can arrive **before** the launch response, for example `module` and `breakpoint`.
     Buffer events whose pid is unknown, and flush them once a launch/attach response binds that pid.

### 1.4 Fork / multi-process

- **ptrace fork.** mdb parks the child and emits an event named `process`. It is **not** the DAP `process` event:
  `{processId:<parentPid>, event:"process", body:{name:"forked", isLocalProcess:true, startMethod:"attach", processId:<childPid>}}`
  (`dbm/src/interface/dap/events.cpp:139-148`, `dbm/src/interface/tracee_command/ptrace/ptrace_session.cpp:810-853`).
  mdb never sends `startDebugging`. For each fork, the client must start a new session on the **same mdb process**:
  `initialize` (new token), then `attach {sessionType:"ptrace", processId:child, configToken}`, then breakpoints,
  then `configurationDone`. The child is released when `configurationDone` arrives.
- **exec.** mdb sends the custom event `setProcessName {name, processId}`.
- **rr replay.** There is only one session.
  - Every `stopped` event carries `body.processes:[pids]`, and there is no fork event.
  - Switching process means sending later requests with a different `processId`.
  - `attach` with `sessionType:"rr"` is a `TODO` crash.

### 1.5 Requests: what is safe to send

**Forward unchanged (works):** `threads`, `scopes`, `variables`, `evaluate` (repl/watch), `pause`, `continue`, `stepIn`,
`stepOut`, `setInstructionBreakpoints`, `disconnect`, `terminate`.

**Forward with rewrite:**
- `next`: `granularity:"statement"` is a TODO crash (`commands.cpp:474`). Map it to `"line"`.
- `disassemble`: `offset` and `instructionOffset` are read unconditionally, so default both to 0.
- `readMemory`/`writeMemory`: `offset` is ignored. Fold it into `memoryReference` (BigInt hex add) and drop it.
- `stackTrace`: `startFrame` and `levels` are ignored and the full stack is always returned. Slice it locally and set
  `totalFrames`.
- `setBreakpoints`:
  - Drop `logMessage` entries before forwarding. Hitting a logpoint is a `TODO` crash (`dbm/src/bp.cpp:523`). Answer
    those entries as `verified:false, message:"Log points are not supported by mdb yet"`.
  - Drop `hitCondition`; mdb ignores it.
  - The response lists **every** breakpoint in the file, possibly several per line. It does not follow the request's
    index order, which VS Code relies on. Rebuild the response so it has exactly one entry per requested breakpoint,
    matched by line. Check the real shape against `dbm/test/driver/breakpointsRequests.js` first.
- `setFunctionBreakpoints`: pass it through. mdb also supports an extra `regex: bool` per breakpoint
  (`commands.cpp:1017-1028`). Expose it through a `functionBreakpointRegex` launch option, or a `/regex/` name syntax.
- `launch`: see section 3.3.
- `initialize` **response**: patch the capabilities (section 3.4).

**Answer locally (never forward):**
- `setExceptionBreakpoints`: mdb only has a stub. Reply `success, breakpoints: []`.
- `evaluate` with context `hover`, `clipboard` or `variables`: mdb returns an error, which is fine. Answering locally
  with "not supported" is cleaner.
- Everything below **crashes mdb** (`commands.cpp:2589-2834`). Reply with `success:false`,
  `message:"<cmd> is not supported by mdb"`: `breakpointLocations`, `completions`, `dataBreakpointInfo`,
  `exceptionInfo`, `goto`, `gotoTargets`, `loadedSources`, `modules`, `restart`, `restartFrame`, `setDataBreakpoints`,
  `setExpression`, `setVariable`, `source`, `stepBack`, `stepInTargets`, `terminateThreads`, `cancel`, `importScript`,
  and **any command not on the allowlist**.

### 1.6 Events

- Forward these, with `processId` stripped and `seq` set: `stopped`, `thread`, `module`, `output`, `exited`,
  `terminated`, `breakpoint`, `initialized`.
  - `module.addressRange` is already a string, which matches the DAP spec.
  - `stopped.reason` may be `"function breakpoint"`, `"instruction breakpoint"` or `"data breakpoint"`. These match the
    DAP spec.
- Consume these, never forward:
  - `process`: the fork notification (section 1.4).
  - `setProcessName`: log it, and update the session's process label if one is shown in UI.
  - `stopped.body.processes`: rr process tracking. Strip it before forwarding.
- `continued` is never sent. VS Code already marks threads running when a `continue` or step response arrives. For
  `continueAll`, which is sent through `customRequest`, emit a synthetic `continued {allThreadsContinued:true}`.

### 1.7 Semantics worth surfacing to users (docs, not code)

- Breakpoint **conditions are JavaScript function bodies** that run as `function(bpstat, task) { ... }`
  (`dbm/src/mdbjs/bpjs.cpp:42`). The default is to *resume*; the condition stops by calling `bpstat.stop()`. Pass
  conditions through untouched and document this (see open question Q2).
- The debug console is a **JavaScript REPL** (QuickJS). It provides `loadViews(path)`, `loadScript(path)`, `threads()`,
  `getThread(id)`, and so on (`dbm/src/mdbjs/mdbjs.cpp:441-466`).
- **Views** (`.mdbv`) can be loaded three ways: through the launch arg `views: string[]`, with
  `loadViews("/abs/path")` in the REPL (calling it again reloads the file), or by auto-loading from `$MDB_VIEWS_DIR`
  or `~/.config/mdb/views`.
- `launch.cwd` and `launch.env` are parsed but **ignored** by mdb (`commands.cpp:1549-1565`). Each `launch.args` item
  reaches the tracee **wrapped in literal quotes** (`commands.cpp:1542-1546`). See section 6.

---

## 2. Architecture

```
VS Code session (root)  ──┐                    ┌── stdin ──▶ mdb (one per root session tree)
VS Code session (fork1) ──┼─▶ MdbConnection ───┤
VS Code session (fork2) ──┘   (mux / demux)    └── stdout ◀─ (stderr ─▶ output channel)
     ▲ each is an MdbSessionAdapter (implements vscode.DebugAdapter)
```

- **Use `vscode.DebugAdapterInlineImplementation`**, and implement the `vscode.DebugAdapter` interface (`handleMessage`
  plus the `onDidSendMessage` emitter) directly. Don't subclass `@vscode/debugadapter`'s `DebugSession`. Nearly
  everything is pass-through with rewrites, and a raw-message proxy is simpler. Only add `@vscode/debugprotocol` as a
  dependency, for its types.
- **One mdb process per root session tree**, not one global singleton like Midas. A root `launch` spawns its own mdb.
  Fork children find their parent's `MdbConnection` through the parent `vscode.DebugSession`, keyed by `session.id`, in
  a registry. If one mdb crashes, it only kills its own tree.
- **Keep the core independent of VS Code.** `framing.ts`, `connection.ts`, `sessionAdapter.ts` and `rewrites.ts` must not
  import `vscode`. They depend on a small `Host` interface instead:
  `startChildSession(parent, childPid, name)`, `log(...)`, `showError(...)`. The VS Code layer implements `Host`. This
  lets mocha unit tests run in plain Node, and lets integration tests drive a real mdb without an Extension Host.

### Source layout

```
src/
  extension.ts            activate(): register provider, factory, tracker, commands
  vscode/
    configProvider.ts     DebugConfigurationProvider: defaults, validation, ${} resolution, mdb path
    adapterFactory.ts     DebugAdapterDescriptorFactory -> inline MdbSessionAdapter; root vs child
    host.ts               Host impl: vscode.debug.startDebugging for forks, output channel, notifications
    commands.ts           mdb.continueAll, mdb.pauseAll, mdb.loadViews, mdb.selectReplayProcess
  core/
    framing.ts            byte-correct Content-Length reader/writer, garbage resync
    mdbProcess.ts         spawn, stderr drain, exit handling, kill-after-timeout
    connection.ts         MdbConnection: seq remap, response routing, event routing, pid binding, buffering
    sessionAdapter.ts     MdbSessionAdapter: per-session state, request/response/event rewrite pipeline
    rewrites.ts           pure functions: one per request/response/event transformation (unit-testable)
    capabilities.ts       initialize-response patch
    protocol.ts           allowlist, mdb-specific types
  test/
    unit/*.test.ts        mocha, plain node
    integration/*.test.ts drive real mdb via core (no VS Code)
    extension.test.ts     smoke test in Extension Host (@vscode/test-cli, already configured)
```

### Core behaviour

**`MdbConnection`**
- Owns the `MdbProcess` and one framing reader.
- Assigns its own monotonically increasing `seq` to every request it sends to mdb, and keeps a map
  `mdbSeq → {adapter, originalSeq, command}`. On a response, it looks up `request_seq`, restores the original seq, and
  hands the response to that adapter. This also routes the `customRequest` responses that lack `processId`.
- Keeps an event routing table `pid → adapter`:
  - Bind each placeholder id to its adapter at `initialize`.
  - Bind the real pid when a `launch`/`attach` response arrives, then flush any buffered events for it.
  - Buffer events for unknown pids, with a cap and a log warning.
  - rr: map every pid in `stopped.body.processes` to the root adapter.
- On mdb exit or crash: send `output` (category `important`, with the exit code/signal and the log directory path),
  then `terminated`, to every attached adapter. Reject all pending requests with error responses.
- `dispose()`: kill mdb with SIGTERM, then SIGKILL after 1.5 s. Do this once the root adapter has disconnected and no
  children remain.

**`MdbSessionAdapter`**
- Holds:
  - `configToken` (a `crypto.randomUUID()`)
  - `sessionType` (`ptrace` | `rr`)
  - `pid` (placeholder, then the real pid)
  - `selectedPid` (rr)
  - `outSeq` (the seq for messages sent to VS Code)
- Request pipeline: allowlist check (answer locally if blocked), then rewrite, then inject `processId` (`selectedPid`
  for rr) and `configToken`, then `connection.send`.
- Response and event pipeline: rewrite, strip the top-level `processId`, set `seq = ++outSeq`, then emit.
- Handles `process` events by calling `host.startChildSession(...)`.
- A `customRequest` from VS Code (`session.customRequest("continueAll")`) is re-wrapped as mdb's envelope:
  `{command:"customRequest", arguments:{command:"continueAll", arguments:{}}}` (`commands.cpp:2607-2613`).

---

## 3. VS Code contributions

### 3.1 `package.json`

- `activationEvents`: `onDebugResolve:mdb`, `onDebugDynamicConfigurations:mdb`. Commands activate the extension
  implicitly.
- `contributes.debuggers`: a single type, `"mdb"`, with label "mdb". Set `languages: ["c","cpp"]` and
  `breakpoints: [{language:"c"},{language:"cpp"},{language:"rust"}]`.
- `contributes.configuration`:
  - `mdb.path` (string, default `"mdb"`): resolved on PATH, or relative to the workspace.
  - `mdb.extraArgs` (string[])
  - `mdb.threads` (number | null)
  - `mdb.logDirectory` (string). Default: `context.logUri/mdb-<timestamp>`.
  - `mdb.trace` (boolean): log every DAP message to the "mdb" output channel. Do this in the proxy itself, before and
    after the rewrites, so both sides are visible.
- `contributes.commands`, enabled only when `debugType == mdb`: "mdb: Continue All Threads", "mdb: Pause All Threads",
  "mdb: Load Views File…", "mdb: Select Replay Process" (also requires `mdb.isReplay`). Add the first two to the
  `debug/toolBar` menu.
- Remove the `helloWorld` command.

### 3.2 Launch configuration schema (`request: "launch"` only, publicly)

| Attribute | Type | Required | Notes |
|---|---|---|---|
| `sessionType` | `"ptrace"`\|`"rr"` | no (default `ptrace`) | Sent as `launch.type`, and as `RRSession` in `initialize`. |
| `program` | string | ptrace | Resolved to an absolute path. mdb uses `execve` with no PATH search. Validate that it exists and is executable. |
| `args` | string[] | no | |
| `stopOnEntry` | boolean | no | |
| `breakpointBehavior` | `"Stop all threads"`\|`"Stop single thread"` | no | Passed through. |
| `views` | string[] | no | Resolve `${workspaceFolder}`; make paths absolute. |
| `traceDir` | string | rr | The rr trace directory. If it's missing, offer a QuickPick of `~/.local/share/rr/*`. |
| `cwd`, `env` | | no | Passed through. If either is set, show a warning that mdb ignores it (section 6). |
| `mdbPath`, `mdbArgs`, `logDirectory` | | no | Per-config overrides of the settings. |

Also provide `initialConfigurations` and `configurationSnippets` for "mdb: Launch" and "mdb: Replay rr trace".

`request: "attach"` is **internal only**, used for fork children. `startDebugging` is called with
`{type:"mdb", request:"attach", name:"<parent name> [fork <pid>]", __mdbChildOf:<parentSessionId>, processId:<pid>}`.
- In `resolveDebugConfiguration`, reject any `attach` that lacks `__mdbChildOf`, with the message "Attaching to an
  arbitrary process is not supported by mdb yet."
- Options: `{parentSession, lifecycleManagedByParent:true, consoleMode:MergeWithParent, compact:true}`.

### 3.3 `launch` request rewrite

Starting from the resolved VS Code config:
1. `type` becomes `sessionType`.
2. Add `configToken`.
3. Make `program` and `views` absolute.
4. Copy `args`, `stopOnEntry`, `breakpointBehavior` and `traceDir`.
5. Drop VS Code-only keys: `name`, `request`, `__*`, `mdbPath`, `mdbArgs`, `logDirectory`, `presentation`, and the like.
6. The launch response then binds the pid. For rr, also seed the process list from `body.processes`.

### 3.4 Patched `initialize` response capabilities

Start from mdb's response (`commands.cpp:1329-1382`), then:
- Set these to false:
  - `supportsLogPoints` (hitting a logpoint crashes mdb)
  - `supportsHitConditionalBreakpoints` (mdb ignores hit conditions)
  - `supportsTerminateThreadsRequest` (crashes mdb)
  - `supportsStepBack`, because `stepBack` crashes mdb. In VS Code this flag also controls Reverse Continue. Treat this
    as a known gap: keep it false until mdb implements `stepBack`, and offer reverse-continue through the
    "mdb: Reverse Continue" command, which sends `reverseContinue` when `mdb.isReplay` is set.
- Delete `completionTriggerCharacters`, `additionalModuleColumns` and `supportedChecksumAlgorithms`. mdb sends them
  with the wrong types.
- Set `exceptionBreakpointFilters: []`.

Then set the context keys `mdb.isReplay` and `mdb.singleThreadControl` from the session type.

---

## 4. Implementation phases

Finish each phase, with its tests passing, before starting the next.

**Phase 0: scaffold cleanup**
- Remove the hello-world command.
- Add `@vscode/debugprotocol` and a uuid source (`crypto.randomUUID` is fine on Node 22).
- Add mocha unit-test scripts that run in plain Node (`yarn test:unit`), separate from `vscode-test`.
- Keep webpack.

**Phase 1: core transport**
- `framing.ts`: a Buffer-based reader. Support chunked input, multibyte UTF-8 split across chunks, several messages in
  one chunk, and resync after garbage (stdout text from a mdb `TODO`). Writer: byte-length header.
- `mdbProcess.ts`: spawn with `stdio:'pipe'`. Drain stderr line by line to the logger. Emit `exit` with code/signal.
- Unit tests for every case above.

**Phase 2: connection and single-session proxy**
- `MdbConnection` (seq remap, routing, buffering), `MdbSessionAdapter`, `capabilities.ts`, the allowlist, and the
  rewrites from section 1.5. Each rewrite is a pure function with its own unit tests.
- Integration test against real mdb (`/home/sfarre/dev/dbm/obj/debug/bin/mdb`, subjects in the same directory, for
  example `helloworld`, `stackframes`, `next`, `threads_shared`). Skip it if the binary is missing; let `MDB_PATH`
  override the location.
- The test runs initialize, setBreakpoints (pre-launch), launch, configurationDone, waits for stopped, then threads,
  stackTrace, scopes, variables, next, continue, exited, terminated. Assert that no response or event has a top-level
  `processId`, and that seqs are monotonic.

**Phase 3: VS Code wiring**
- `configProvider.ts`: defaults, validation, error messages, mdb binary resolution, and log directory creation.
- `adapterFactory.ts`: root sessions spawn an mdb; children reuse the parent's connection.
- `extension.ts`.
- Use a `DebugAdapterTrackerFactory` only if `mdb.trace` is on, and only as an extra. The proxy does its own logging.
- Manual check from the Extension Development Host (F5): launch `helloworld` with a breakpoint, then step, inspect
  variables, and view disassembly and memory.

**Phase 4: multi-process (fork)**
- Handle the `process` event: `Host.startChildSession` starts an attach session that runs the child lifecycle from
  section 1.4.
- Child `disconnect`: forward it with `terminateDebuggee:false` unless the user explicitly stopped that child. See Q3
  before relying on this.
- Integration test with the `fork` subject (`dbm/test/fork.cpp`), driven through core with a fake `Host`. The test must
  confirm that both processes hit their breakpoints and exit cleanly.

**Phase 5: custom commands and mdb-specific UX**
- `mdb.continueAll` and `mdb.pauseAll`, sent through `customRequest`.
- `mdb.loadViews`: a file picker, then `evaluate {context:"repl", expression:'loadViews("<abs>")'}`. Show the returned
  diagnostics in the debug console.
- Optional: watch the `views` files and reload them on save.
- Document breakpoint conditions and the JS REPL in the README.

**Phase 6: rr replay**
- `sessionType:"rr"` launch, which also sends `RRSession:true` in `initialize`.
- Track `stopped.body.processes`.
- "mdb: Select Replay Process" is a QuickPick that changes `selectedPid` and emits an `invalidated {areas:["all"]}`
  event so VS Code refetches threads and stacks.
- "mdb: Reverse Continue".
- Test manually against an rr trace. If `rr` is installed, `dbm/test/driver/client.js:552-576` shows how the test suite
  records one.

**Phase 7: packaging and docs**
- Rewrite the README (requirements, settings, launch examples, known limitations from sections 1.5 and 1.7).
- Update the CHANGELOG.
- Check that `vsce package` works.

---

## 5. Testing strategy

- **Unit tests (plain Node mocha):** framing; every function in `rewrites.ts`; capability patching; seq remap and
  routing in `MdbConnection` against a fake mdb stream, including events arriving before the launch response, responses
  without `processId`, and mdb crashing mid-request.
- **Integration tests (plain Node, real mdb):** drive `MdbSessionAdapter` with a tiny in-test DAP client. Reuse the
  sequencing in `dbm/test/driver/client.js` as a reference only. That file talks to mdb directly, while these tests go
  through the proxy.
- **Extension Host smoke test:** the existing `vscode-test` setup. Start a debug session on `helloworld` with
  `stopOnEntry`, wait for `onDidChangeActiveStackItem`, then stop. Skip it when mdb isn't present.
- **Regression guard:** a test that sends every command in the deny list through the adapter and asserts each one gets
  a local error response, with mdb never seeing it.

---

## 6. mdb-side bugs found during analysis (separate work in `dbm`, not part of this extension)

The extension works around or documents these. Fixing them in mdb is small, and it would let the workarounds go.
List them in the README as known limitations, and don't block on them.

1. `launch.args` items are formatted as JSON, so each one gets literal quotes (`commands.cpp:1542-1546`). The fix is to
   use the string view. **This affects every launch that passes arguments.** Unless it's fixed first, the extension
   must warn whenever `args` is non-empty.
2. `cwd`/`env` are parsed but not passed to `ForkExec` (`commands.cpp:1549-1565`, `ptrace_session.cpp:499-529`).
3. A malformed request gives a `nullptr` command, which is then dereferenced (`interface.cpp:226-230`). Unknown commands
   and unimplemented requests `PANIC`/`TODO` instead of returning an error response.
4. `stackTrace` ignores `startFrame`/`levels`. `readMemory`/`writeMemory` ignore `offset`. `disassemble` requires
   optional fields.
5. Capabilities advertise features that crash mdb (logpoints, terminateThreads, stepBack via `supportsStepBack`), and
   some capability fields have the wrong types.
6. `setBreakpoints` responses don't match the request one-to-one.
7. `continued` events are never emitted. `customRequest` responses lack `processId`.
8. The test driver is stale: `initializeRequest.js` has no `configToken`, `launchRequest.js` uses `type:'native'`, and
   `attachRequest.js` sends `sessionId`.

---

## 7. Open questions (confirm with the user before or while implementing)

- **Q1.** Should the mdb-side fixes in section 6 (at least #1 and #3) be done first, in `dbm`? That would remove the
  `args` warning and make the deny list a safety net rather than a necessity. *Recommendation: yes, fix #1 first. It's
  a one-line change.*
- **Q2.** Breakpoint conditions: pass the raw JS body through, or add a convenience mode that wraps a plain expression
  as `if (<expr>) bpstat.stop();`? *Recommendation: pass them through, and document it. The JS context can't see C++
  locals by name, so wrapping would mislead users.*
- **Q3.** Verify in mdb: `Disconnect(terminate=true)` pushes `TerminateDebugging`
  (`dbm/src/interface/tracee_command/supervisor_state.cpp:263-271`). Does stopping a *child* session kill the whole mdb
  and every sibling? If it does, the proxy should map a child-session stop to `disconnect {terminateDebuggee:false}`
  plus an explicit kill, or mdb should be fixed.
- **Q4.** Is `rust` in the `breakpoints` contribution wanted?
- **Q5.** Should the managed-toolchain approach from Midas (`midas.get-mdb`, which builds mdb from source) be ported?
  *Recommendation: no. Use `mdb.path` only.*
