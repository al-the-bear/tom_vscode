# Tool Testing & Timing Report

How the per-tool test infrastructure under `src/tools/__tests__/` is wired,
what the timing report looks like, and how the CI gate decides whether the
audit passes.

Every tool is held to a four-part checklist, which the test file of its
family records in its header comment:

- **a) Description** — the tool's description says what it does, its inputs,
  its answer and its refusals, and matches the implementation.
- **b) Ambiguities** — the inputs a caller gets wrong (a directory where a
  file is expected, a relative path, an empty list, a stale revision) each
  have a decided behaviour and a test.
- **c) Tests** — the implementation is driven directly with fakes or a real
  on-disk fixture, one happy path per tool plus the b) cases.
- **d) Timing** — a typical call is wrapped in `withTiming('<tool>:typical', …)`
  and stays under the 5 s ceiling.

The tool inventory is not kept by hand: the audit (§ CI gate) reads the
registry, `ALL_SHARED_TOOLS`, and fails for a tool without a timing entry, and
`_ai/quests/vscode_extension/tool_timings.md` is the per-tool record it reads.

---

## TL;DR for adding a new tool

1. **Write the implementation** as a `XxxImpl(deps, input)` pure function plus
   a thin `executeXxx` wrapper that injects the deps. (See
   `guideline-tools.ts` and `prompt-history-tools.ts` for the canonical
   pattern.)
2. **Write the test** under `src/tools/__tests__/<family>.test.ts`. Drive
   `XxxImpl` directly — no `vscode` runtime needed. If your impl pulls
   transitively from a module that imports `vscode`, install the shared
   stub at the very top of the file:
   ```ts
   import { installVscodeStub } from './_vscode-stub.js';
   installVscodeStub({ /* moduleOverrides, methodOverrides */ });
   ```
3. **Wrap the typical-call assertion** in `withTiming`:
   ```ts
   import { withTiming } from './_timing.js';

   test('xxx typical call', async () => {
       const out = await withTiming('tomAi_xxx:typical', () =>
           xxxImpl(deps, { /* input */ }));
       assert.equal(out.kind, 'ok');
   });
   ```
4. **Run** `npm test`. The test phase generates the report; the audit phase
   verifies coverage and the 5-second ceiling.

---

## The three shared helpers

All three live under `src/tools/__tests__/` (with leading underscore so the
test runner glob `*.test.js` skips them).

### `_vscode-stub.ts`

`installVscodeStub(options)` intercepts `Module._resolveFilename` to make
`require('vscode')` resolve to a fake. Returns a handle:

```ts
const h = installVscodeStub({
    workspaceFolders: ['/tmp/example'],         // populates vscode.workspace.workspaceFolders
    moduleOverrides: {                           // remap arbitrary require() targets
        '../managers/chatVariablesStore': { ChatVariablesStore: { instance: { quest: 'demo' } } },
    },
    methodOverrides: {                           // override individual vscode.* methods
        showInformationMessage: () => Promise.resolve('custom'),
    },
});
try {
    // ... test body ...
    const calls = h.spies.byMethod('window.');   // inspect recorded vscode.* calls
    h.spies.clear();
    h.setWorkspaceFolders(['/another']);
} finally {
    h.restore();
}
```

Covered surface: `workspace` (workspaceFolders, textDocuments, getConfiguration, fs,
findFiles — a real search with Node's glob under the pattern's base, exclude applied —, asRelativePath,
openTextDocument — the open fake document, else the file read from disk —, applyEdit, onDidChangeConfiguration, createFileSystemWatcher), `window`
(showInformationMessage / WarningMessage / ErrorMessage, createOutputChannel,
showInputBox, showQuickPick, createQuickPick, showTextDocument, createStatusBarItem, activeTextEditor, visibleTextEditors,
tabGroups, createWebviewPanel — a panel whose `dispose()` fires `onDidDispose` —, registerWebviewViewProvider, withProgress),
`commands` (executeCommand, registerCommand, getCommands), `languages`
(getDiagnostics, registerCodeActionsProvider, registerDocumentSymbolProvider),
`lm` (selectChatModels, tools, invokeTool), `Uri.file/parse/joinPath`,
`EventEmitter`, `CancellationTokenSource`, `ProgressLocation`,
`LanguageModelTextPart` / `ToolCallPart` / `ToolResultPart`,
`RelativePattern`, `Disposable`, `LanguageModelChatMessage.User/Assistant`,
`Position`, `Range`, `WorkspaceEdit`, `StatusBarAlignment`, `ViewColumn`.

**A QuickPick nobody sees.** `createQuickPick()` returns a widget whose
`show()` lists it in `window.__quickPicks`; a test answers it as a person
would — `qp.__accept()` selects the first item (or the items passed) and
fires `onDidAccept`, `qp.hide()` dismisses it.

Install is idempotent — re-calling it merges new overrides into the existing
stub (lets a test file extend the family's default stub).

**Open documents and edits.** Code that writes through an open editor is
tested against fake documents instead of a local patch of the stub:
`fakeTextDocument(fsPath, text, { isDirty, saveResult })` builds one (offsets
and positions convert across lines, `getText(range)`, `save()` counts and
clears `isDirty`), and the `textDocuments` option or `h.setTextDocuments([...])`
opens it. `WorkspaceEdit` records `replace` / `insert` / `delete` as `ops`
and `createFile` / `deleteFile` / `renameFile` as `fileOps`;
`workspace.applyEdit` carries the file operations out on disk (refusing, as
VS Code does, a create over an existing file without `overwrite` /
`ignoreIfExists`), then applies the text operations to the open fake documents
(which become dirty) and to files nobody has open (written back to disk), records every call as a spy and every applied edit in
`h.appliedEdits()`, and refuses everything after `h.setApplyEditResult(false)`
(or the `applyEditResult` option). `som-document-io-vscode.test.ts` is the
worked example; `vscode-stub.test.ts` holds the stub to it.

**File watchers never fire on their own.** `createFileSystemWatcher` hands back
a recorded watcher; `stubFileWatchers()` returns them in creation order (the
registry spans the whole process, so the *newest* entry belongs to the object
currently under test) and each exposes `fireChange` / `fireCreate` /
`fireDelete`. Silence is therefore the default, which is what makes "the native
watcher never fired" — the real behaviour on symlinked or out-of-workspace
paths — the case a test gets for free rather than the one it has to contrive.

### `_timing.ts`

```ts
withTiming<T>(name: string, fn: () => Promise<T> | T, options?: {
    expectMaxMs?: number;     // override the 5 s default for this entry
    category?: string;        // 'network', 'kernel', 'fixture-heavy', …
    note?: string;            // free-form explanation surfaced in the report
}): Promise<T>;
```

Runs `fn`, measures wall-clock with `process.hrtime.bigint`, asserts
`ms < expectMaxMs ?? 5000`, records `{ name, ms, ceilingMs, category, note }`
to a process-level accumulator, and returns whatever `fn` returned.

A `process.on('exit')` hook flushes the accumulator to
`_ai/quests/vscode_extension/tool_timings.md`. Because `node --test` runs
each test file in a separate process, the flush **merges with the existing
on-disk report** before writing back — the in-process accumulator wins for
name collisions, on-disk entries from sibling test files are preserved.
That's how a single `node --test out/tools/__tests__/*.test.js` invocation
produces a single combined report.

To clear stale rows (e.g., after renaming a tool), delete the report file
before running the tests. `withTiming` also exports `resetTimings()` and
`getTimings()` for tests of the helper itself.

**Why `npm run test:tools` passes `--test-concurrency=1`**: when `node --test`
runs files in parallel, each process does a read-then-write on the shared
`tool_timings.md` — under contention the last writer wins and earlier
entries can be lost. Forcing sequential execution eliminates the race at
the cost of ~2-3× longer total runtime (acceptable until the suite gets
much bigger). The proper fix is append-only logging + a final consolidator;
deferred for now since the sequential workaround is one flag.

### `_fixtures.ts`

Four builders, all return `{ root, cleanup() }` (and `mkQuestFolder` also
returns `wsRoot`, `questFolder`, `questId`):

| Builder | ~ size | Use for |
| --- | --- | --- |
| `mkSmallWorkspace()` | 100 files | Correctness checks, default timing assertions |
| `mkMediumWorkspace()` | 1 000 files | Pagination + sort-stability tests |
| `mkLargeWorkspace()` | 10 000 files (mixed `.ts` / `.md`) | Walker stress — `findFiles`, `findTextInFiles`. Uses synchronous I/O because async fs is *slower* at this scale (libuv thread-pool overhead dominates). |
| `mkQuestFolder(questId, options)` | per-subsystem trail files | Prompt-history tests. `options.subsystems` defaults to `['anthropic']`; `options.exchangesPerSubsystem` defaults to 5. |

Always pair with `after(() => fixture.cleanup())`. `cleanup()` is
idempotent — second call is a no-op.

---

## Timing report format

Written to `_ai/quests/vscode_extension/tool_timings.md` (workspace root,
not under `src/`). One file per workspace; regenerated on every `node --test`
run that touches `withTiming`.

```markdown
# Tool Timing Report

Generated by `withTiming()` from `src/tools/__tests__/_timing.ts` on <ISO timestamp>.

Default ceiling: **5000 ms** (checked by `npm run audit:tools`).

## ⚠️ Entries exceeding the default 5 s ceiling
| Name | ms | Ceiling | Category | Note |
|---|---:|---:|---|---|
| tomAi_findFiles:large-fixture | 6234.1 | 8000 | fixture-heavy | 10k-file walk |

## All recorded timings
| Name | ms | Ceiling | Category | Note |
|---|---:|---:|---|---|
| tomAi_findFiles:large-fixture | 6234.1 | 8000 | fixture-heavy | 10k-file walk |
| tomAi_listPromptPairs:typical | 12.3 | 5000 |  |  |
| ...
```

**Naming convention**: `<toolName>:<case>`. The `<case>` suffix lets one
tool record several call shapes (`:typical`, `:large-fixture`, `:error-path`).
For coverage purposes only the part before `:` matters.

**Ordering**: rows sorted by `ms` descending so the slowest tools surface
at the top.

**Override semantics**: an entry with `expectMaxMs > 5000` raises the
**in-test assertion**, not the CI gate. The audit script treats any entry
over 5 000 ms as a failure regardless of `expectMaxMs`. If a tool genuinely
needs more (network-bound, kernel start), the right move is to time a fast
"typical" case separately and let the slow case be a non-timing assertion.

---

## CI gate — `scripts/audit-tool-coverage.cjs`

Invoked via `npm run audit:tools` or as the last stage of `npm test`.

```bash
npm test              # = scripts/run-test-stages.cjs: lint:media, every test:<area>, audit:tools — all of them
npm run test:tools    # node --test out/tools/__tests__/*.test.js  (writes the report)
npm run audit:tools   # node scripts/audit-tool-coverage.cjs       (reads the compiled registry + the report, gates)
```

One `test:<area>` script per source folder that has a `__tests__/` sibling —
`test:tools`, `test:services`, `test:utils`, `test:managers`, `test:handlers`.
The globs are one level deep (`out/<area>/__tests__/*.test.js`), so a test in a
new folder needs its own `test:<area>` script or it never runs. Adding the script
is enough: `scripts/run-test-stages.cjs` runs every `test:*` script of
`package.json` in the order it lists them, between `lint:media` and
`audit:tools`.

**Every stage runs.** The runner does not stop at a failing stage: the output
of each streams as it runs, and a summary at the end lists every stage with
`ok` / `FAILED`, its time and node:test's counts, then names the failed stages;
the exit code is 1 if any failed. (A `&&` chain used to stop at the first
failure, so a failing `test:tools` silently skipped everything after it.)
`run-test-stages.test.ts` (RS-1 … RS-5) holds the runner to that.

**What it checks** (each is an independent failure mode):

1. **Coverage** — every tool in the registry, `ALL_SHARED_TOOLS`, must have
   at least one timing entry whose name starts with `<toolName>:`. The
   registry is read from the compiled extension (`out/tools/tool-executors.js`)
   under the shared vscode test stub, as `tool-registry-parity.test.ts` reads
   it — so a tool built by a factory, kept in a subfolder or named in double
   quotes is counted like any other. (A grep of the source used to be the
   inventory and missed such tools while reporting full coverage.)
2. **Ceiling** — no entry's `ms` may exceed 5 000.
3. **Defined but not registered** — a `name: 'tomAi_…'` literal in
   `src/tools/*.ts` that is not in the registry is a tool nobody can call, and
   fails. A deliberate one is listed in `KNOWN_UNREGISTERED` in the script with
   its reason; an entry there that no longer applies (registered now, or gone)
   fails too.
4. **Orphan entries** (informational only — does **not** fail the build) —
   timing rows for names that are not registered. Surfaced so the next test
   author can delete the report and re-run cleanly.

**Exit codes**:

| Code | Meaning |
| --- | --- |
| 0 | Every registered tool covered, no entry over ceiling, nothing defined but unregistered. |
| 1 | Coverage, ceiling or registration failure. |
| 2 | Audit could not run (report missing, no compiled extension — run `npm run compile` — or an empty registry). |

The audit logic is `auditToolCoverage(...)`, exported by the script and
tested in `src/tools/__tests__/audit-tool-coverage.test.ts` (AU-1 – AU-5),
including a factory-defined tool. `npm test` compiles and runs the tests
before it, so `out/` is current.

---

## Every tool over MCP — `mcp-all-tools.test.ts`

The family tests drive each `xxxImpl` with fakes. `mcp-all-tools.test.ts`
drives every tool the other way round: through the standalone MCP server
(`buildToolMcpServer` over the authenticated tool set, i.e. all of
`ALL_SHARED_TOOLS`), called by a real MCP `Client` over an in-memory transport,
with the live executors and the extension's stores started on a fake context
(chat variables, process state, session todos, trail, reminders, timer, queue)
— the code a chat panel or an external client runs.

Its test mode is a **sandbox**: the workspace is a fresh copy of a small
fixture (a git repository with no remote, quest `demo` with todos, process
`flow`, a DocSpecs note, a copy of the Meridian spec, guidelines), `HOME`
points into the sandbox, `http`/`https`/`fetch` refuse every request, and every
path written through `fs` is recorded. Writes are real; MA-3 holds them to the
sandbox, the extension repository's `git status` and HEAD to what they were,
and checks what the write tools wrote. The ask tools are answered as a person
would answer them (the ask through `AskUserRegistry`, the picker through the
stub's QuickPick).

A tool needs no entry to be covered: MA-1 and MA-2 walk `ALL_SHARED_TOOLS`,
and a tool with no entry in `inputs()` is called with an input built from its
schema's required fields. An entry is worth adding when the tool should do real
work on the fixture — `inputs()` may take a function of the earlier answers, so
an update or remove can use the id a create returned (remove/delete tools run
last). Run it alone with
`node --test out/tools/__tests__/mcp-all-tools.test.js`; with
`MCP_ALL_TOOLS_REPORT=1` it prints one line per tool (ok / error, time, the
start of the answer). It runs in about two seconds.

## Adding a new tool — full checklist

1. **Source** — `src/tools/<family>-tools.ts`:
   - Define `XxxInput` interface, `executeXxx` wrapper, `XXX_TOOL` const.
   - Extract `xxxImpl(deps, input)` if the executor touches `vscode`,
     `wsRoot`, or any other hard-to-fake dependency. Define a
     `XxxDeps` interface for the impl when the dep set is non-trivial.
2. **Registration** — add `XXX_TOOL` to `ALL_SHARED_TOOLS` in
   `tool-executors.ts`.
3. **Test** — `src/tools/__tests__/<family>-tools.test.ts`:
   - Install the stub if needed.
   - Build a fixture (`mkSmallWorkspace` etc.).
   - Drive `xxxImpl` directly.
   - Wrap the typical-call assertion in `withTiming('tomAi_xxx:typical', …)`.
   - Add a case for each ambiguity of checklist b) (mistaken inputs, edge
     cases), and note a)–d) in the test file's header comment.
4. **Selectable** — add the name to `AVAILABLE_LLM_TOOLS`
   (`src/utils/constants.ts`) and to its picker category
   (`src/utils/toolCategories.ts`); `tool-registry-parity.test.ts` fails
   for a registered tool that is not selectable.
5. **Verify** — `npm test` (it ends with `audit:tools`). It passes when:
   - `test:tools` — your new test is green and the timing report regenerated,
     and `mcp-all-tools.test.ts` calls the new tool over MCP without a hang
     (give it an `inputs()` entry if it should do real work on the fixture);
   - `audit:tools` — the covered count went up by one and no entry is over
     the ceiling (`Tool timing coverage : N/N`).

---

## Why this lives in the local guidelines

The infrastructure is TypeScript-specific to the VS Code extension. The
workspace-level `_copilot_guidelines/dart/test_tracking.md` is the Dart
sibling (testkit baselines), but coupling the Node/TS audit to that doc
would mix two unrelated test ecosystems. Local guideline wins.
