# Code Review — Refactoring / Implementation Plan

**Input:** the six review documents under `doc/review/` plus the deprecation audit.
**Baseline date:** 2026-04-20. Re-validated against the current `main` tip; line numbers cited below match the code as of that date.
**Scope note:** single-installation codebase, no external consumers — so back-compat shims listed in [deprecation.md](deprecation.md) can be removed outright.

---

## 1. Evaluation of the review findings

I re-walked each claim against the current source. Verdicts and any necessary amendments below.

### 1.1 High 1 — Notepad/Panel provider duplication (VALID, slightly understated)

**Review:** 8 provider classes in [sidebarNotes-handler.ts](../../src/handlers/sidebarNotes-handler.ts).

**Verified against current code:**

- `TomNotepadProvider` — [sidebarNotes-handler.ts:626](../../src/handlers/sidebarNotes-handler.ts#L626)
- `CopilotNotepadProvider` — [sidebarNotes-handler.ts:874](../../src/handlers/sidebarNotes-handler.ts#L874)
- `LocalLlmNotepadProvider` — [sidebarNotes-handler.ts:1102](../../src/handlers/sidebarNotes-handler.ts#L1102)
- `ConversationNotepadProvider` — [sidebarNotes-handler.ts:1469](../../src/handlers/sidebarNotes-handler.ts#L1469)
- `TomAiChatNotepadProvider` — [sidebarNotes-handler.ts:1834](../../src/handlers/sidebarNotes-handler.ts#L1834)
- `NotesNotepadProvider` — [sidebarNotes-handler.ts:2155](../../src/handlers/sidebarNotes-handler.ts#L2155)
- `GuidelinesNotepadProvider` — [sidebarNotes-handler.ts:2455](../../src/handlers/sidebarNotes-handler.ts#L2455)
- `WorkspaceNotepadProvider` — [sidebarNotes-handler.ts:2746](../../src/handlers/sidebarNotes-handler.ts#L2746)
- `QuestNotesProvider` — [sidebarNotes-handler.ts:3138](../../src/handlers/sidebarNotes-handler.ts#L3138) (missed by review)
- `SessionTodosProvider` — [sidebarNotes-handler.ts:3259](../../src/handlers/sidebarNotes-handler.ts#L3259) (missed by review)

**Total: 10 providers in a 3,375-line file.** The review's severity assessment holds.

### 1.2 High 2 — Placeholder engine fragmentation (VALID)

**Review:** multiple engines with incompatible syntax surfaces; reminder help text displays `${…}` while runtime expects `{{…}}`.

**Verified:**

- Mustache syntax at runtime: [reminderSystem.ts:40](../../src/managers/reminderSystem.ts#L40) — `'{{timeoutMinutes}} minutes without a response'`.
- `REMINDER_TEMPLATE_HELP` duplicated verbatim in:
  - [queueEditor-handler.ts:587](../../src/handlers/queueEditor-handler.ts#L587)
  - [timedRequestsEditor-handler.ts:246](../../src/handlers/timedRequestsEditor-handler.ts#L246)
- Two separate trail path token resolvers:
  - [trailService.ts](../../src/services/trailService.ts) `resolvePathTokens()` — still present, line numbers shifted slightly (file is 440 lines vs. 277 in review; method still there).
  - [trailViewer-handler.ts](../../src/handlers/trailViewer-handler.ts) `resolveTrailPathTokens()` — still present.
- Canonical resolver: [variableResolver.ts](../../src/utils/variableResolver.ts) + [promptTemplate.ts](../../src/handlers/promptTemplate.ts) `expandTemplate()` — already supports both `${…}` and `{{…}}`.

All four manual-replacement islands named in [placeholders.md](placeholders.md) still exist. Finding stands.

### 1.3 High 3 — Configuration/state fragmentation (VALID)

Verified from [configuration_structure.md](configuration_structure.md) and current code:

- 27 contributed settings in `package.json` — confirmed.
- Legacy compat keys `chatVar_quest` / `chatVar_role` still read alongside the current `chatVariablesStore`.
- `tomAi.windowId` still read with no writer (the chat-variables file writes the session id; nothing writes this workspaceState key).
- `globalState` and `secrets` APIs unused.

### 1.4 Medium 1 — Oversized command surface (VALID but targeted)

Current `package.json` contributes 76 commands (extension_elements.md reports 76, `filestructure.md` reports 75 — minor snapshot drift, same order of magnitude). The clear duplicates are the Copilot template variants (`addToTodo`, `codeReview`, `explain`, `fixMarkdown`, `todoExecution`, `trailReminder`) and the Local LLM variants (`expand`, `rewrite`, `detailed`, `annotated`). These 10 commands could all collapse to a single parameterised pair.

### 1.5 Medium 2 — Duplicate reminder help constant (VALID)

Confirmed — see §1.2 above.

### 1.6 Medium 3 — Panel/view reusable shell opportunity (VALID)

Current code ships [BaseWebviewProvider](../../src/utils/baseWebviewProvider.ts) but it has **zero in-tree callers** ([code_structure.md:93](code_structure.md#L93) module_structure row shows `baseWebviewProvider — Uses 0, Used By 0`). The infrastructure exists and is unused; we can consolidate onto it.

### 1.7 Medium 4 — Handlers overgrown (VALID)

65 of 107 TS files sit in `handlers/` ([filestructure.md](filestructure.md) source snapshot). Major hotspots by size (current values): [chatPanel-handler.ts](../../src/handlers/chatPanel-handler.ts) 5,194 lines, [sidebarNotes-handler.ts](../../src/handlers/sidebarNotes-handler.ts) 3,375 lines, [anthropic-handler.ts](../../src/handlers/anthropic-handler.ts) 2,276 lines, [questTodoPanel-handler.ts](../../src/handlers/questTodoPanel-handler.ts) ~4,000 lines.

### 1.8 Deferred Anthropic items ([review_result.md §1–4](review_result.md))

- **§1 `loadSendToChatConfig()` vs `TomAiConfiguration.getSection()`** — still mixed in [statusPage-handler.ts](../../src/handlers/statusPage-handler.ts). Valid.
- **§2 `resolvePathTokens` in TrailService** — still duplicates `resolveVariables` logic. Valid; folds naturally into §1.2 unification.
- **§3 `section === 'anthropic'` special cases in chatPanel-handler.ts** — still there; not a blocker today, becomes one when a third generic LLM panel lands.
- **§4 `ANTHROPIC_SUBSYSTEM` layering violation** — confirmed: `services/history-compaction.ts` imports a constant from `handlers/anthropic-handler.ts`. Quick fix; should be part of the first wave.

### 1.9 Deprecations inventory ([deprecation.md](deprecation.md))

All 11 items in Sections 1–4 of the deprecation doc remain unmerged as of 2026-04-20 and are consistent with the review's placeholder-engine and typing findings. The suggested commit split in [deprecation.md §6](deprecation.md#6-suggested-commit-split) is sound; this plan merges those commits into its own wave structure.

---

## 2. Overall evaluation

The review is **well-founded and internally consistent**. The code shows textbook "scaling-strain phase" symptoms: a directionally correct layering (handlers / managers / services / utils / tools), but over a year of feature additions piled into the handlers layer without proportional extraction. Three patterns dominate:

1. **Copy-and-adapt instead of abstract-and-parameterise.** Ten notepad providers, nine profile variants of the same Copilot send, two identical reminder help constants.
2. **Local convenience over shared contract.** Five placeholder engines, each solving one consumer's problem; two trail path resolvers, one per caller.
3. **"Add without removing."** Legacy `chatVar_*` keys + back-compat trail layouts + `@deprecated` markers accumulate because deletion was never scheduled.

None of these are bugs. They are accumulated complexity that taxes every future change. The ROI of consolidation is real but capped — this codebase works. The goal of the plan below is to remove the tax *without* a disruptive rewrite.

**Recommended posture:**

- Do the deprecation sweep first — it's low-risk, shrinks the surface area, and makes every subsequent refactor smaller.
- Do placeholder unification next — it's the single highest-drift-risk area right now, and the fix is localised.
- Only then tackle the big structural work (notepad consolidation, command surface reduction, config split). Those are larger and benefit from the earlier cleanup.

---

## 3. Refactoring plan

Ordered by wave. Each item lists: **owning document(s)**, **files touched**, **concrete steps**, **risk**, **rollback**. Waves are independent — you can pause between waves without leaving the tree in a broken state.

### Wave 0 — Deprecation sweep (prerequisite)

Owns: [deprecation.md](deprecation.md) §1–4. Low risk, high clarity win. Execute in the five-commit sequence from [deprecation.md §6](deprecation.md#6-suggested-commit-split).

**Commit 0.A — Typed `compaction.disabled`**

- Add `disabled?: boolean` to the `compaction` interface in [sendToChatConfig.ts:213-264](../../src/utils/sendToChatConfig.ts#L213).
- Remove the `as { disabled?: boolean }` cast at [statusPage-handler.ts:996](../../src/handlers/statusPage-handler.ts#L996).
- Remove the mutation casts at [statusPage-handler.ts:1003-1006](../../src/handlers/statusPage-handler.ts#L1003).
- Simplify the read at [anthropic-handler.ts:612](../../src/handlers/anthropic-handler.ts#L612).
- **Verification:** `npx tsc --noEmit`.

**Commit 0.B — Drop trivially dead APIs**

- `compaction.enabledTools`: delete field at [sendToChatConfig.ts:218-219](../../src/utils/sendToChatConfig.ts#L218).
- `bridge.profiles[].command`: delete fallback reader at [sendToChatConfig.ts:309-310](../../src/utils/sendToChatConfig.ts#L309); grep for `.command ??` to catch incidental reads.
- `ToolTrail` constructor deprecated params: remove from [tool-trail.ts:58-60](../../src/services/tool-trail.ts#L58); update all `new ToolTrail(` call sites.
- `ToolTrail.evictOldRounds()`: remove from [tool-trail.ts:91-99](../../src/services/tool-trail.ts#L91); remove callers.
- `buildBuiltinValues()`: delete at [promptTemplate.ts:103-118](../../src/handlers/promptTemplate.ts#L103).
- `registerQuestTodoPanel()` stub: remove at [questTodoPanel-handler.ts](../../src/handlers/questTodoPanel-handler.ts) plus activation call in `extension.ts`.
- Claude 3.x context-window fallback: delete at [history-compaction.ts:159-160](../../src/services/history-compaction.ts#L159).
- **Verification:** `npx tsc --noEmit` and run [src/utils/__tests__/queueLogger.test.ts](../../src/utils/__tests__/queueLogger.test.ts), [src/managers/__tests__/](../../src/managers/__tests__/) manually via the testkit workflow.

**Commit 0.C — Replace `expandPlaceholders` / `PLACEHOLDER_HELP` re-exports**

- Update callers listed in [deprecation.md §1.5](deprecation.md#15-expandplaceholders-wrapper-in-handler_shared) and §1.6 to import from the canonical modules.
- Delete the re-exports at [handler_shared.ts:933-937](../../src/handlers/handler_shared.ts#L933) and [handler_shared.ts:1008-1010](../../src/handlers/handler_shared.ts#L1008).
- This commit prepares for **Wave 1 — Placeholder unification**.

**Commit 0.D — Trail path migration + filename shim**

- One-shot on-activation migration for legacy trail path shapes ([tomAiConfiguration.ts:258-275](../../src/utils/tomAiConfiguration.ts#L258)).
- Keep the `${workspaceName}_prompts.md` → `${workspaceName}.prompts.md` rename shim at [chatPanel-handler.ts:272-289](../../src/handlers/chatPanel-handler.ts#L272) for one more cycle.

**Commit 0.E — History-shape cleanup (OPTIONAL, risky)**

- Only after auditing every workspace's `_ai/local/**/history.json` for the legacy flat shape ([anthropic-handler.ts:508-511](../../src/handlers/anthropic-handler.ts#L508), [memory-service.ts:586-599](../../src/services/memory-service.ts#L586)).
- If any workspace still has flat-shape history, load-and-resave each before deletion.

**Rollback for Wave 0:** git revert per-commit; none of these changes cross API boundaries.

---

### Wave 1 — Quick wins (high ROI, low risk)

#### 1.1 Fix `ANTHROPIC_SUBSYSTEM` layering violation

**Owner:** [review_result.md §4 Deferred Items](review_result.md#4-anthropic_subsystem-import-direction-violates-handlerservice-layering).
**Risk:** trivial — pure import direction fix.

**Steps:**

1. Create `src/services/trailSubsystems.ts` exporting:
   ```ts
   export const ANTHROPIC_SUBSYSTEM = { type: 'anthropic' } as const;
   export const LOCALLLM_SUBSYSTEM  = { type: 'localLlm' }  as const;
   export const COPILOT_SUBSYSTEM   = { type: 'copilot' }   as const;
   // plus future subsystems
   ```
2. Move the existing declarations out of [anthropic-handler.ts](../../src/handlers/anthropic-handler.ts) into that new file.
3. Update imports in:
   - [anthropic-handler.ts](../../src/handlers/anthropic-handler.ts)
   - [agent-sdk-transport.ts](../../src/handlers/agent-sdk-transport.ts)
   - [history-compaction.ts](../../src/services/history-compaction.ts)
   - [trailService.ts](../../src/services/trailService.ts) (if it references the constant)
4. `npx tsc --noEmit`.

**Done when:** no `services/*.ts` imports from `handlers/*`.

#### 1.2 Unify reminder help constant

**Owner:** [review_result.md Medium 2](review_result.md#medium-2-duplicate-reminder-help-constants-should-be-centralized), [placeholders.md finding §1](placeholders.md#review-findings-and-risks).
**Risk:** low — single constant, two readers.

**Steps:**

1. Move the `REMINDER_TEMPLATE_HELP` body into a new exported constant in [src/managers/reminderSystem.ts](../../src/managers/reminderSystem.ts) (close to the actual placeholder list — the single source of truth for which mustache tokens are replaced).
2. Delete the duplicates at:
   - [queueEditor-handler.ts:587](../../src/handlers/queueEditor-handler.ts#L587)
   - [timedRequestsEditor-handler.ts:246](../../src/handlers/timedRequestsEditor-handler.ts#L246)
3. Import from the new location in both editors.
4. **Fix the syntax mismatch** at the same time: the help text must use `{{...}}` because that's what `reminderSystem.generateReminder()` actually replaces. Search for hardcoded examples in webview HTML that still use `${...}` for reminder tokens and correct them.

**Done when:** the string literal of the help appears exactly once; running a reminder with a `{{timeoutMinutes}}`-authored template produces the expected substitution.

#### 1.3 Unify trail path token resolution

**Owner:** [review_result.md §2 Deferred Items](review_result.md#2-resolvepathtokens-in-trailservice-duplicates-variable-resolver-logic), [placeholders.md §9](placeholders.md#9-trail-and-markdown-views).
**Risk:** medium — `resolvePathTokens` reads live VS Code state; regression surface is trail file paths across all subsystems.

**Steps:**

1. Extend [variableResolver.ts](../../src/utils/variableResolver.ts) to accept explicit `{ quest, subsystem }` overrides via the existing `values` parameter.
2. Replace [trailService.ts](../../src/services/trailService.ts) `resolvePathTokens()` with `resolveVariables(path, { values: { quest, subsystem } })`. Keep path-specific post-processing (absolute-path guard, `path.join`) in `trailService` as a tiny wrapper.
3. Replace [trailViewer-handler.ts](../../src/handlers/trailViewer-handler.ts) `resolveTrailPathTokens()` the same way. The "strip `${quest}` / `${subsystem}`" behavior becomes "call without those keys in `values`" — the resolver returns empty string for missing keys.
4. Smoke-test: open the Raw Trail Viewer on an existing quest; verify files still discovered at the same paths.

**Done when:** `grep -rn 'resolvePathTokens\|resolveTrailPathTokens' src/` returns zero.

#### 1.4 Retire `chatVar_quest` / `chatVar_role` legacy keys

**Owner:** [review_result.md High 3](review_result.md#high-3-configurationstate-model-is-split-across-too-many-stores-without-clear-ownership-boundaries), [configuration_structure.md:99-100](configuration_structure.md#L99).
**Risk:** low — single-installation codebase; one migration sweep clears it.

**Steps:**

1. Add a one-shot migration on activation in `extension.ts`: read `workspaceState.chatVar_quest` / `chatVar_role`; if present and `chatVariablesStore` is empty, seed the store from those keys; delete the legacy keys.
2. Remove compat reads in [chatVariablesStore.ts](../../src/managers/chatVariablesStore.ts) and anywhere else grep finds them.
3. Remove the workspace-state read for `tomAi.windowId` ([configuration_structure.md:101](configuration_structure.md#L101)) — it has no writer, so it's dead.

**Done when:** only `chatVariablesStore` reads chat-variable state; `tomAi.windowId` is gone.

#### 1.5 Unify placeholder engine surface (documentation)

**Owner:** [review_result.md High 2](review_result.md#high-2-placeholder-engine-fragmentation-is-causing-behavioral-inconsistency), [placeholders.md](placeholders.md).
**Risk:** documentation-only; code follow-up in Wave 2.

**Steps:**

1. Write a single source-of-truth doc at [doc/placeholder_engine.md](../placeholder_engine.md) describing:
   - the canonical resolver ([variableResolver.ts](../../src/utils/variableResolver.ts));
   - the `expandTemplate` layer;
   - each context's allow-list (full-template / path-limited / trail-limited / reminder-limited).
2. Generate help text programmatically from a central capability table — pull the existing `PLACEHOLDER_HELP` into a structured object and derive the prose help from it. Keeps the three help surfaces in sync by construction.
3. Link it from [_copilot_guidelines/vscode_extension_overview.md](../../_copilot_guidelines/vscode_extension_overview.md) and [doc/file_and_prompt_placeholders.md](../file_and_prompt_placeholders.md).

**Done when:** no placeholder help string is written by hand in more than one place.

**Wave 1 expected duration:** 2–3 focused days. Each item above commits independently.

---

### Wave 2 — Consolidation (medium ROI)

#### 2.1 De-duplicate the notepad providers via shared helpers + thin wrappers

**Owner:** [review_result.md High 1](review_result.md#high-1-notepadpanel-provider-duplication-is-very-high-and-should-be-consolidated), [review_result.md Consolidation §](review_result.md#actions-panels-editors-consolidation-opportunities).
**Risk:** medium — ten providers, ten flavours of HTML / message handling / external-data glue. Migrate in small steps so regressions stay small.

**Strategy (refined):** do not try to fold all ten providers into one monolithic `GenericNotepadProvider`. The providers differ too much in their *data* behavior (Copilot watches answer files, Local LLM talks to Ollama, Quest Notes reads quest markdown, Tom AI Chat owns a model loop). Instead:

- **Extract the duplicated pieces into shared helpers / mixins** — HTML shell + CSS, message envelope, draft persistence, toolbar rendering, storage adapters, template picker glue.
- **Keep one thin `*NotepadProvider` wrapper per data domain** that composes the shared pieces and contributes its own data-specific adapter.

After this, each wrapper should be a few hundred lines of glue, not a copy of the same 300-line shell.

**Steps:**

1. **Inventory duplication.** Walk the 10 providers and tag shared blocks. Candidates observed from code structure:
   - HTML head + CSS + codicon linkage.
   - Toolbar rendering (Send / Queue / Clear / Copy / template picker).
   - `onDidReceiveMessage` routing skeleton (types: `ready`, `save`, `send`, `pickTemplate`, `selectSlot`, …).
   - Draft persistence (`workspaceState` or per-window YAML).
   - Template expansion before send.
   - Copy-to-clipboard + open-external behavior.
2. **Extract into `src/handlers/notepad/` module:**
   - `notepadHtmlShell.ts` — `renderNotepadHtml({ id, title, icon, toolbar, initialContent })`.
   - `notepadMessageRouter.ts` — common message handling skeleton with extension points.
   - `notepadStorage.ts` — draft get/set for the three storage backends (`file`, `workspaceState`, `queue`).
   - `notepadToolbar.ts` — declarative toolbar action rendering.
   - `notepadTemplatePicker.ts` — shared template picker and expansion call.
   - Domain-specific pieces stay where they are (Copilot answer-file watcher, Ollama client, etc.).
3. **Migrate in pairs**, verifying each with a manual smoke test before the next:
   - Pass A: `TomNotepadProvider` + `NotesNotepadProvider` (simplest; pure draft storage).
   - Pass B: `WorkspaceNotepadProvider` + `GuidelinesNotepadProvider` (read external files).
   - Pass C: `QuestNotesProvider` + `SessionTodosProvider` (quest/session scoped).
   - Pass D: `CopilotNotepadProvider` + `LocalLlmNotepadProvider` (send targets).
   - Pass E: `ConversationNotepadProvider` + `TomAiChatNotepadProvider` (model-owning).
4. **Do NOT merge classes that don't have equivalent behavior.** If a provider needs genuinely unique UI (Copilot's 4 answer slots; TomAiChat's inline model picker), keep it local to that provider — compose, don't unify.
5. Once all ten wrappers use the shared helpers, split [sidebarNotes-handler.ts](../../src/handlers/sidebarNotes-handler.ts) into per-domain files under `src/handlers/notepad/` so no single file owns all ten. Target: each wrapper in its own 200–400-line file; the shared helpers in 4–5 tight modules.

**Done when:**

- The shared helper modules exist and carry the HTML/message/storage/template code.
- `grep "class.*NotepadProvider\|class.*NotesProvider\|class.*TodosProvider" src/handlers/` returns exactly 10 matches, each in its own file, each under ~400 lines.
- The combined line count across `src/handlers/notepad/*.ts` is substantially under the current 3,375 lines of [sidebarNotes-handler.ts](../../src/handlers/sidebarNotes-handler.ts) (target: ≤ 2,000 lines total).

**Rollback strategy:** commit per migrated provider; if a regression appears, revert just that provider's commit. The shared helpers land in their own commit *before* the first migration, so the helpers themselves never need to be reverted alongside a provider.

#### 2.2 Parameterise Copilot + Local LLM command variants

**Owner:** [review_result.md Medium 1](review_result.md#medium-1-actioncommand-surface-is-oversized-and-duplicates-intent), [extension_elements.md §Command Catalog](extension_elements.md#command-catalog).
**Risk:** low — all keybindings are extension defaults, so removing the old command IDs is safe. Update `package.json` keybindings in the same commit and users lose nothing.

**Current:** 6 `tomAi.sendToCopilot.*` variants + 4 `tomAi.sendToLocalLlm.*` prompt-expansion variants = 10 nearly identical commands.

**Proposed:** keep two top-level commands (`tomAi.sendToCopilot`, `tomAi.sendToLocalLlm`) and a single pair of pickers:

- `tomAi.sendToCopilot.withTemplate` — opens a quick-pick of the 6 template variants, then sends.
- `tomAi.sendToLocalLlm.withProfile` — opens a quick-pick of the 4 expansion profiles, then sends.

**Steps:**

1. Add the two quick-pick commands to [copilotTemplates-handler.ts](../../src/handlers/copilotTemplates-handler.ts) and the Local LLM handler.
2. Delete the 10 `tomAi.sendToCopilot.<variant>` / `tomAi.sendToLocalLlm.<variant>` command IDs from `package.json` `contributes.commands`.
3. Remove the matching entries from `package.json` `contributes.menus.editor/context` submenus (`tomAi.sendToCopilotSubmenu` / `tomAi.sendToLocalLlmSubmenu`). Keep the submenus themselves only if they house anything else — otherwise drop the submenu entries too.
4. Update `package.json` `contributes.keybindings` to re-point any binding that still references a removed ID at the new quick-pick command.
5. Remove the handler registrations in [copilotTemplates-handler.ts](../../src/handlers/copilotTemplates-handler.ts) and the Local LLM handler.
6. Update [doc/quick_reference.md](../quick_reference.md) and [doc/user_guide.md](../user_guide.md) to describe the new picker flow.

**Done when:** the editor context menu shows two entries ("Send to Copilot…", "Send to Local LLM…") instead of twelve, and `package.json` `contributes.commands` is shorter by 10 entries.

#### 2.3 `TemplateAwareEditorShell` for queue / timed / template editors

**Owner:** [review_result.md Consolidation §](review_result.md#actions-panels-editors-consolidation-opportunities).
**Risk:** medium — three large editors with overlapping UI but distinct data models.

**Steps:**

1. Audit shared patterns across [queueEditor-handler.ts](../../src/handlers/queueEditor-handler.ts), [timedRequestsEditor-handler.ts](../../src/handlers/timedRequestsEditor-handler.ts), [globalTemplateEditor-handler.ts](../../src/handlers/globalTemplateEditor-handler.ts). Start a table — column-form fields, toolbar buttons, pre-save validation hooks.
2. Extract common patterns into `src/handlers/editorShell/templateAwareEditorShell.ts`. Drive from config similar to `NotepadProfile`.
3. Migrate `globalTemplateEditor-handler` first (smallest of the three).

**Defer if Wave 2.1 runs long.** The queue / timed editors work today; this is maintainability, not a blocker.

#### 2.4 Wire `BaseWebviewProvider` into existing panels

**Owner:** [review_result.md Medium 3](review_result.md#medium-3-panelview-duplication-suggests-reusable-shell-opportunities).
**Risk:** low — [BaseWebviewProvider](../../src/utils/baseWebviewProvider.ts) exists but has zero callers. Pick one panel, prove the pattern, then migrate.

**Steps:**

1. Pick [minimalMode-handler.ts](../../src/handlers/minimalMode-handler.ts) (smallest provider) as the pilot.
2. Inherit from `BaseWebviewProvider`; remove the duplicated boilerplate.
3. Once proven, migrate [windowStatusPanel-handler.ts](../../src/handlers/windowStatusPanel-handler.ts), [todoLogPanel-handler.ts](../../src/handlers/todoLogPanel-handler.ts), and the smaller notepads.

**Done when:** `BaseWebviewProvider` has ≥ 3 subclasses in-tree.

#### 2.5 Statuspage: migrate to `TomAiConfiguration.getSection`

**Owner:** [review_result.md §1 Deferred Items](review_result.md#1-loadsendtochatconfig-vs-tomaiconfigurationinstancegetsection).
**Risk:** low — localised to one handler.

**Steps:**

1. Grep [statusPage-handler.ts](../../src/handlers/statusPage-handler.ts) for `loadSendToChatConfig()`.
2. Replace each site that touches the `anthropic` section with `TomAiConfiguration.instance.getSection<AnthropicSection>('anthropic')`.
3. Verify the status page's Anthropic section still renders current profile / model / memory settings.

**Done when:** `statusPage-handler.ts` accesses `anthropic` config exclusively through `TomAiConfiguration`.

**Wave 2 expected duration:** 1–2 weeks, bulk of it on 2.1. Items 2.2 / 2.4 / 2.5 are small and can run in parallel.

---

### Wave 3 — Architecture (lowest ROI, highest impact — schedule deliberately)

#### 3.1 Two-file config strategy

**Owner:** [review_result.md Configuration Location Recommendations](review_result.md#configuration-location-recommendations), [configuration_structure.md](configuration_structure.md).
**Risk:** medium — config layout changes touch every consumer.

**Proposed layout:**

```text
<user-config-root>/.tom/vscode/tom_vscode_extension.user.yaml   user-global preferences
<workspace>/.tom/tom_vscode_extension.workspace.yaml            workspace-local config
VS Code workspaceState                                           UI ephemeral only
Environment variables                                            secrets (token values)
```

Where `<user-config-root>` resolves via `os.homedir()`:

- **Linux / macOS:** `$HOME` → `~/.tom/vscode/tom_vscode_extension.user.yaml`.
- **Windows:** `%USERPROFILE%` (e.g. `C:\Users\<name>`) → `C:\Users\<name>\.tom\vscode\tom_vscode_extension.user.yaml`.

`os.homedir()` already returns the correct value on both platforms, so the code path is uniform — but path joins must use `path.join`, never a hard-coded `/` separator, and any docs example showing `~/.tom/` must be accompanied by the Windows form.

**Merge order:** `defaults < user-global < workspace-local < runtime overrides`.

**Steps:**

1. Add `TomAiConfiguration.loadUserGlobal()` reading `<homedir>/.tom/vscode/tom_vscode_extension.user.yaml`. Build the path with `path.join(os.homedir(), '.tom', 'vscode', 'tom_vscode_extension.user.yaml')`. Create the file lazily with sensible defaults.
2. Classify every contributed setting ([configuration_structure.md §A](configuration_structure.md#a-contributed-vs-code-settings-27)):
   - **User-global** candidates: `userName`, Ollama URL, bridge binary paths, favorites, preferred profile defaults.
   - **Workspace-local**: `aiFolder`, queue/trail/notes/todo patterns, quest IDs, context approach.
   - **Settings-only (keep as-is)**: the VS Code settings that are truly preferences (`autoRunOnSave`, `trail.enabled`, `copilot.showNotifications`, etc.).
3. Update [tomAiConfiguration.ts](../../src/utils/tomAiConfiguration.ts) to layer the reads and expose the merged view through `getSection()`.
4. Add a versioned migration hook — on activation, if the user's config lacks a `schema_version`, run the one-shot migration that moves the user-global keys from workspace config to the new file.
5. Document in [_copilot_guidelines/implementation.md](../../_copilot_guidelines/implementation.md), including the Windows path form.

**Secrets stay where they are.** The Telegram token is not stored in any config file — the config only holds the *name* of the environment variable, and the token is read from `process.env` at runtime. This is already the right model and does not need to change.

**Risk mitigation:** stage this across two releases — release N introduces the user-global file and reads from both; release N+1 removes the workspace fallback for user-global keys.

#### 3.2 Extract domain logic from handlers into services / use-cases

**Owner:** [review_result.md Medium 4](review_result.md#medium-4-structural-concentration-in-handlers-weakens-modularity).
**Risk:** medium per extraction; overall contained by ordering (smallest handler first).

**Targets, by likely impact:**

1. [chatPanel-handler.ts](../../src/handlers/chatPanel-handler.ts) (5,194 lines) — extract Copilot answer-file handling (lines ~43-380) into `src/services/copilotAnswerService.ts`. Extract Anthropic-specific draft-save logic (lines ~2389, ~3973) into an AnthropicPanelService.
2. [anthropic-handler.ts](../../src/handlers/anthropic-handler.ts) (2,276 lines) — already mostly services; main remaining handler concerns are webview + approval UI. Should shrink to ~1,200 lines after extracting history / memory / profile code into services.
3. [questTodoPanel-handler.ts](../../src/handlers/questTodoPanel-handler.ts) (~4,000 lines) — extract todo-mutation logic into a `QuestTodoService`, leaving the handler as pure UI + command wiring.
4. [statusPage-handler.ts](../../src/handlers/statusPage-handler.ts) (~3,000 lines) — extract settings-write logic into service-per-section modules.

**Approach per target:**

- Pick one handler. Inventory its public API. Draw a line between "what the webview needs" (keep in handler) and "what computes state" (move to service).
- Create `src/services/<domain>Service.ts`. Move the computation. Handler becomes thin.
- Run typecheck + manual smoke test on each turn.

**Defer if Waves 0-2 have already substantially reduced these files.** Wave 2.1 alone drops sidebarNotes from 3,375 to ~400 lines; Wave 2.3 will shrink the template editors; statusPage may shrink enough from Wave 2.5 alone.

#### 3.3 Shared chat-provider registry in `chatPanel-handler.ts`

**Owner:** [review_result.md §3 Deferred Items](review_result.md#3-remaining-section--anthropic-special-cases-in-chatpanel-handlerts).
**Risk:** low once 3.2 progresses.

Convert the remaining `section === 'anthropic'` branches (trail-viewer routing, save-drafts extra fields) into a provider-map lookup. Natural follow-up to 3.2's chatPanel extraction; not urgent until a third generic LLM panel appears.

**Wave 3 expected duration:** 4–6 weeks across a couple of releases. Schedule when no other structural work is in flight.

---

## 4. Summary table

| Wave | Item | Owns review section | Files | Risk | Effort |
| --- | --- | --- | --- | --- | --- |
| 0.A | Typed `compaction.disabled` | deprecation §2.1 | 2 | Low | < 1 h |
| 0.B | Drop trivially dead APIs | deprecation §1.1–1.9 | 6 | Low | 2 h |
| 0.C | Replace `expandPlaceholders` re-exports | deprecation §1.5, 1.6 | 6 | Low | 2 h |
| 0.D | Trail path migration | deprecation §3.1, 3.2 | 2 | Low | 2 h |
| 0.E | History-shape cleanup | deprecation §4.1, 4.2 | 2 | High | audit-gated |
| 1.1 | Fix `ANTHROPIC_SUBSYSTEM` layering | result §4 deferred | 4 | Trivial | 30 min |
| 1.2 | Unify reminder help constant | result Medium 2 | 3 | Low | 1 h |
| 1.3 | Unify trail path token resolution | result §2 deferred | 3 | Medium | 3 h |
| 1.4 | Retire `chatVar_*` + `tomAi.windowId` | result High 3, config_structure §233 | 3 | Low | 2 h |
| 1.5 | Placeholder engine doc | result High 2 | 2 new + refs | Low | 3 h |
| 2.1 | `GenericNotepadProvider` | result High 1 | 1 (3.4k lines) | Medium | 3–5 days |
| 2.2 | Parameterise command variants | result Medium 1 | 3 | Low | 1 day |
| 2.3 | `TemplateAwareEditorShell` | result Consolidation | 3 | Medium | 2–3 days |
| 2.4 | Wire `BaseWebviewProvider` | result Medium 3 | 4+ | Low | 1 day |
| 2.5 | Statuspage → `TomAiConfiguration` | result §1 deferred | 1 | Low | 3 h |
| 3.1 | Two-file config | result config recs, config_structure | many | Medium | 1–2 weeks |
| 3.2 | Extract domain logic from handlers | result Medium 4 | 4 big handlers | Medium | 3–4 weeks |
| 3.3 | Chat-provider registry | result §3 deferred | 1 | Low | follow-up |

---

## 5. Decisions (resolved)

Answers to the open questions from the initial plan:

1. **Commit strategy — keep per-item granularity.** Each numbered item above commits independently (Wave 0 keeps the five-commit split from [deprecation.md §6](deprecation.md#6-suggested-commit-split); Waves 1–3 commit per row in the summary table). Makes revert surgical and keeps history bisectable.
2. **User-global config location — `<homedir>/.tom/vscode/tom_vscode_extension.user.yaml`, cross-platform.** See Wave 3.1 for the resolved Windows / Linux / macOS form. All path joins use `path.join(os.homedir(), ...)` — never a hard-coded `/` separator. Docs must show both forms.
3. **Notepad consolidation scope — shared helpers + thin wrappers, not a monolithic provider.** See revised Wave 2.1. Extract the duplicated HTML / message / storage / toolbar / template code into shared modules; keep one wrapper per data domain so Copilot's answer-file logic, Ollama's client, quest-note readers, etc. stay local to their provider. Goal is less duplication, not fewer classes.
4. **Command-variant keybindings — extension defaults only, safe to remove.** All 10 command IDs in Wave 2.2 are bound to extension-default keybindings. Update `package.json` `contributes.keybindings` in the same commit that deletes the commands; no user-binding breakage possible. No aliasing window needed.
5. **Telegram token — stays in an environment variable.** The config file holds only the env-var name; the token value is read from `process.env` at runtime. Already the correct model. No migration, no `vscode.secrets` move, nothing for users to re-enter. (Plan previously over-scoped this; corrected in Wave 3.1.)

## 6. References

- [review_result.md](review_result.md)
- [filestructure.md](filestructure.md)
- [extension_elements.md](extension_elements.md)
- [code_structure.md](code_structure.md)
- [configuration_structure.md](configuration_structure.md)
- [file_storage.md](file_storage.md)
- [placeholders.md](placeholders.md)
- [module_structure_and_relationships.md](module_structure_and_relationships.md)
- [deprecation.md](deprecation.md)
- [../../_copilot_guidelines/vscode_extension_overview.md](../../_copilot_guidelines/vscode_extension_overview.md)
- [../../_copilot_guidelines/architecture.md](../../_copilot_guidelines/architecture.md)
- [../../_copilot_guidelines/implementation.md](../../_copilot_guidelines/implementation.md)
