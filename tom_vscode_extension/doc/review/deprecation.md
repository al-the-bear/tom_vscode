# Deprecation & Backwards-Compatibility Audit

**Scope:** `tom_vscode_extension` (single-installation context — no external consumers, so anything
marked `@deprecated` or labelled as a back-compat shim can be removed or migrated outright).

**Date:** 2026-04-19
**Quest:** `vscode_extension`

This document inventories every deprecated API, back-compat shim, legacy-shape deserialiser, and
type-cast workaround currently carried in the extension sources. Findings are grouped by removal
risk so they can be addressed in focused commits.

---

## 1. Safe to remove immediately

These are trivially dead or have a single obvious replacement already in use.

### 1.1 `compaction.enabledTools`
- **Location:** `src/utils/sendToChatConfig.ts:218-219`
- **Status:** Marked `@deprecated`.
- **Action:** Delete the field from the schema. No readers remain.

### 1.2 `bridge.profiles[].command`
- **Location:** `src/utils/sendToChatConfig.ts:309-310`
- **Status:** Comment reads "deprecated - use `executable` instead".
- **Action:** Remove the field and any fallback `command ?? executable` readers. All profiles in
  `_ai/local/*.yaml` already use `executable`.

### 1.3 `ToolTrail` constructor params `keepRounds` / `previewChars`
- **Location:** `src/services/tool-trail.ts:58-60`
- **Status:** `@deprecated` — retained only for old callers.
- **Action:** Drop the params and update constructor call sites (grep for `new ToolTrail(`).

### 1.4 `ToolTrail.evictOldRounds()`
- **Location:** `src/services/tool-trail.ts:91-99`
- **Status:** No-op alias kept for older callers.
- **Action:** Remove the method; remove any remaining callers.

### 1.5 `expandPlaceholders()` wrapper in handler_shared
- **Location:** `src/handlers/handler_shared.ts:933-937`
- **Status:** `@deprecated` — forwards to the canonical implementation.
- **Action:** Update callers to the canonical import, then delete the wrapper.
- **Known callers:**
  - `src/handlers/queueEditor-handler.ts:221`
  - `src/handlers/queueEditor-handler.ts:231`
  - `src/handlers/timedRequestsEditor-handler.ts:151`
  - `src/handlers/timedRequestsEditor-handler.ts:157`
  - `src/handlers/sidebarNotes-handler.ts:32`

### 1.6 `PLACEHOLDER_HELP` re-export
- **Location:** `src/handlers/handler_shared.ts:1008-1010`
- **Status:** `@deprecated` re-export from the canonical module.
- **Action:** Point ~7 callers at the canonical import, then delete the re-export.

### 1.7 `buildBuiltinValues()`
- **Location:** `src/handlers/promptTemplate.ts:103-118`
- **Status:** `@deprecated`.
- **Action:** Delete; no remaining callers in-tree.

### 1.8 `registerQuestTodoPanel()` stub
- **Location:** `src/handlers/questTodoPanel-handler.ts:4029-4036`
- **Status:** No-op stub kept for compatibility.
- **Action:** Remove the export and the (non-)registration call site in extension activation.

### 1.9 Claude 3.x context-window fallback
- **Location:** `src/services/history-compaction.ts:159-160`
- **Status:** Legacy branch returning the old 200 000-token default for model names that no longer
  appear in settings.
- **Action:** Drop the fallback; rely on the current model-window table.

---

## 2. Typing gap — add interface field, drop casts

### 2.1 `compaction.disabled` is untyped
- **Location:** `src/utils/sendToChatConfig.ts:213-264` — `compaction` interface definition.
- **Problem:** Runtime reads `stcConfig.compaction.disabled` but the interface does not declare it.
- **Action:**
  1. Add `disabled?: boolean;` to the `compaction` interface.
  2. Remove the cast at `src/handlers/statusPage-handler.ts:996` (`as { disabled?: boolean }`).
  3. Remove the mutation-casts at `src/handlers/statusPage-handler.ts:1003-1006`.
  4. Simplify the read at `src/handlers/anthropic-handler.ts:612`.

---

## 3. Safe after a one-shot migration

Remove once a boot-time migration runs on every dev machine using the extension.

### 3.1 Legacy trail paths in `normalizeOne()`
- **Location:** `src/utils/tomAiConfiguration.ts:258-275`
- **Status:** Back-compat normaliser mapping old trail path layouts to the new shape.
- **Action:** Run a one-shot migration on activation (rewrite the YAML once), then delete the
  normaliser branch. Verify `_ai/local/*.yaml` across all known workspaces first.

### 3.2 Trail file rename `${workspaceName}_prompts.md` → `${workspaceName}.prompts.md`
- **Location:** `src/handlers/chatPanel-handler.ts:272-289`
- **Status:** Rename-on-activate shim.
- **Action:** Keep the shim for one release cycle after a rename pass has run everywhere, then
  delete the block.

---

## 4. Risky — requires data audit before removal

These deserialise old persisted shapes from `history.json` / memory stores. Removing them without
first confirming every workspace has been re-saved in the new shape will silently drop history.

### 4.1 Legacy flat `ConversationMessage[]` deserialisation
- **Location:** `src/handlers/anthropic-handler.ts:508-511`
- **Comment:** "Legacy shape: flat ConversationMessage[]".
- **Action:** Grep every workspace's `_ai/local/**/history.json`; if none are still flat, delete
  this branch. Otherwise, load + resave each affected file, then delete.

### 4.2 Flat-array history rendering in memory service
- **Location:** `src/services/memory-service.ts:586-599`
- **Status:** Pairs with 4.1 — renders the legacy shape when it is encountered.
- **Action:** Remove together with 4.1.

---

## 5. Already done (context — do not redo)

Commits that have already cleaned up back-compat surfaces. Listed so future work does not re-open
these discussions:

| Commit    | Change |
|-----------|--------|
| `805ee3f` | Collapsed `toolApprovalMode` to the boolean-ish `'always' \| 'never'` pair; removed intermediate modes. |
| `6753ee9` | Removed legacy template-store array variant in Tom AI Chat panel config. |
| `86b9a6a` | Dropped old `bridge.profiles` single-profile fallback. |
| `d7c8172` | Consolidated placeholder expansion on the canonical module (opened the path for §1.5 / §1.6). |
| `c0921b2` | Removed an older compaction-override key; `compactionOverride` is now the only name. |

---

## 6. Suggested commit split

To keep each change reviewable and bisectable:

1. **Commit A — Typed compaction settings.** Add `disabled?: boolean` to the `compaction`
   interface; delete the three cast workarounds (§2.1). Compile-only change.
2. **Commit B — Drop trivially dead APIs.** §1.1, §1.2, §1.3, §1.4, §1.7, §1.8, §1.9. No call-site
   edits outside the removed modules.
3. **Commit C — Replace `expandPlaceholders` / `PLACEHOLDER_HELP` re-exports.** §1.5 + §1.6.
   Touches handler files — isolate so reviewer can verify each call-site.
4. **Commit D — Migrate trail/YAML paths.** §3.1 + §3.2 behind a one-shot activation migration;
   keep the shim another release before deletion.
5. **Commit E — History shape cleanup.** §4.1 + §4.2 only after an explicit
   `history.json` audit across every known workspace confirms the new shape is universal.

Run `dart analyze` (where relevant) and the extension test suite after each commit.
