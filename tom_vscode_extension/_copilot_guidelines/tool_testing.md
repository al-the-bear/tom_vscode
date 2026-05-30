# Tool Testing & Timing Report

How the per-tool test infrastructure under `src/tools/__tests__/` is wired,
what the timing report looks like, and how the CI gate decides whether the
audit passes.

> Companion to `_ai/quests/vscode_extension/tool_test_coverage.md` — the
> coverage doc lists the per-family backlog and the four-box per-family
> checklist (a-description, b-ambiguities, c-tests, d-timing). This file
> documents the **mechanics** the boxes plug into.

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

Covered surface: `workspace` (workspaceFolders, getConfiguration, fs,
findFiles, applyEdit, onDidChangeConfiguration), `window`
(showInformationMessage / WarningMessage / ErrorMessage, createOutputChannel,
showInputBox, showQuickPick, activeTextEditor, visibleTextEditors,
tabGroups, createWebviewPanel, registerWebviewViewProvider, withProgress),
`commands` (executeCommand, registerCommand, getCommands), `languages`
(getDiagnostics, registerCodeActionsProvider, registerDocumentSymbolProvider),
`lm` (selectChatModels, tools, invokeTool), `Uri.file/parse/joinPath`,
`EventEmitter`, `CancellationTokenSource`, `ProgressLocation`,
`LanguageModelTextPart` / `ToolCallPart` / `ToolResultPart`,
`LanguageModelChatMessage.User/Assistant`.

Install is idempotent — re-calling it merges new overrides into the existing
stub (lets a test file extend the family's default stub).

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

Default ceiling: **5000 ms** (per tool_test_coverage.md §0.1).

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

Invoked via `npm run audit:tools` or as the second half of `npm test`.

```bash
npm test              # = test:tools && audit:tools
npm run test:tools    # node --test out/tools/__tests__/*.test.js  (writes the report)
npm run audit:tools   # node scripts/audit-tool-coverage.cjs       (reads the report, gates)
```

**What it checks** (each is an independent failure mode):

1. **Coverage** — every `tomAi_*` name found in `src/tools/*.ts` source
   files (excluding `__tests__/`) must have at least one timing entry
   whose name starts with `<toolName>:`. The inventory is the same grep
   the source-of-truth section of `tool_test_coverage.md` uses, so the
   doc and the audit are inherently in sync.
2. **Ceiling** — no entry's `ms` may exceed 5 000.
3. **Orphan entries** (informational only — does **not** fail the build) —
   timing rows for names no longer present in the source tree. Surfaced
   so the next test author can delete the report and re-run cleanly.

**Exit codes**:

| Code | Meaning |
| --- | --- |
| 0 | All tools covered, no entry over ceiling. |
| 1 | Coverage and/or ceiling failure. |
| 2 | Audit could not run (report file missing, source tree malformed). |

The grep-the-source approach is deliberate: it avoids `require()`-ing
`out/tools/tool-executors.js`, which would transitively pull in `vscode`
and force the audit script to install the test stub. Keeping the audit
free of test plumbing means it works in any CI environment that has
Node and the source tree.

---

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
   - Add cases for the b-row ambiguities from `tool_test_coverage.md`
     (mistaken inputs, edge cases).
4. **Verify** — `npm test`. Both phases must pass:
   - `test:tools` — your new test green, the global timing report regenerated.
   - `audit:tools` — covered count goes up by one, no entry over ceiling.
5. **Cross off** — check the four boxes for the family entry in
   `tool_test_coverage.md` and the "Per-family checklist" up top.

---

## Why this lives in the local guidelines

The infrastructure is TypeScript-specific to the VS Code extension. The
workspace-level `_copilot_guidelines/dart/test_tracking.md` is the Dart
sibling (testkit baselines), but coupling the Node/TS audit to that doc
would mix two unrelated test ecosystems. Local guideline wins.
