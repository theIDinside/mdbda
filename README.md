# mdb for Visual Studio Code

Debug C, C++, and Rust programs with mdb. This extension starts mdb and proxies its Debug Adapter Protocol messages to
Visual Studio Code.

## Requirements

- Linux.
- An mdb executable. Set `mdb.path` to its path or executable name.
- For replay, [rr](https://rr-project.org/) and a trace directory that rr can replay.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `mdb.path` | `mdb` | mdb executable path or name. A relative path is resolved from the workspace; a bare name is searched on `PATH`. |
| `mdb.extraArgs` | `[]` | Additional arguments passed to mdb for every session. |
| `mdb.threads` | unset | Optional mdb worker thread count. |
| `mdb.logDirectory` | timestamped extension log directory | Directory for mdb log files. |
| `mdb.transport` | `stdio` | Transport used to communicate with mdb: `stdio` or `socket` (Unix domain socket). |
| `mdb.trace` | `false` | Log DAP messages sent and received by the proxy to the `mdb` output channel. Takes effect after reloading the window. |

Launch configurations can override the mdb executable with `mdbPath`, add per-session mdb arguments with `mdbArgs`, and
choose a log directory with `logDirectory`. The `transport` launch field overrides `mdb.transport` for that session.

## Launch configurations

### Launch a program with ptrace

```json
{
  "type": "mdb",
  "request": "launch",
  "name": "Launch with mdb",
  "sessionType": "ptrace",
  "program": "${workspaceFolder}/build/my-program",
  "stopOnEntry": false,
  "breakpointBehavior": "Stop all threads",
  "views": ["${workspaceFolder}/views/project.mdbv"]
}
```

`program` must name an executable file. `args` is an optional array of program arguments.
`transport` accepts `stdio` or `socket`; when omitted, the `mdb.transport` setting is used.

### Replay an rr trace

```json
{
  "type": "mdb",
  "request": "launch",
  "name": "Replay with mdb",
  "sessionType": "rr",
  "traceDir": "${workspaceFolder}/traces/my-recording"
}
```

`traceDir` points to an existing rr trace. If omitted, the extension offers traces found under `~/.local/share/rr`, with
`latest-trace` first when available.

## Views

Load `.mdbv` files when a session starts with the `views` launch attribute, or during a session with **mdb: Load Views
File…**. mdb can also load views from `$MDB_VIEWS_DIR` or `~/.config/mdb/views`.

## Debug console

The debug console is mdb's JavaScript REPL, backed by QuickJS. In addition to JavaScript, it provides helpers such as
`loadViews(path)`, `loadScript(path)`, `threads()`, and `getThread(id)`.

## Commands

- **mdb: Continue All Threads** and **mdb: Pause All Threads** control all threads. They are also available on the debug
  toolbar.
- **mdb: Load Views File…** opens a picker for a `.mdbv` file and loads it through the REPL.
- **mdb: Select Replay Process** chooses the process used by subsequent requests during rr replay.
- **mdb: Reverse Continue** continues backwards in an rr replay. It is available when an rr session is active; DAP
  `stepBack` remains unsupported.

## Known limitations

- The extension requires Linux and an mdb executable. rr replay also requires rr and an existing trace.
- mdb currently wraps each program argument in literal quote characters. Configurations with non-empty `args` may pass
  different argument values than intended.
- mdb parses `cwd` and `env` but ignores them. The extension warns when `args`, `cwd`, or `env` are set.
- Breakpoint conditions and hit conditions are unsupported. Persisted conditions are removed before forwarding, and the
  debug console reports when this happens. Logpoints are unsupported and are reported as unverified breakpoints.
- Exception breakpoints have no effect. Data breakpoints and the DAP requests `breakpointLocations`, `completions`,
  `dataBreakpointInfo`, `exceptionInfo`, `goto`, `gotoTargets`, `loadedSources`, `modules`, `restart`, `restartFrame`,
  `setDataBreakpoints`, `setExpression`, `setVariable`, `source`, `stepBack`, `stepInTargets`, `terminateThreads`,
  `cancel`, and `importScript` are not supported. Other requests outside the extension's allowlist are rejected locally
  to protect mdb from commands it does not implement safely.
- Attaching to an arbitrary process is unsupported. Child sessions created for a fork are attached internally.
- Malformed DAP requests may still cause mdb to exit. The extension blocks known unsupported requests and works around
  several mdb protocol issues, including stack slicing, memory offsets, disassembly defaults, and breakpoint response
  ordering.
- mdb does not emit `continued` events. The extension relies on normal DAP responses for step/continue state and emits a
  synthetic `continued` event for Continue All.
- `evaluate` contexts `hover`, `clipboard`, and `variables` are unsupported by mdb. Use the debug console REPL or watch
  expressions.
