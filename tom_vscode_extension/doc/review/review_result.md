# Review Result

Scope reviewed:

- doc/review/filestructure.md
- doc/review/extension_elements.md
- doc/review/code_structure.md
- doc/review/configuration_structure.md
- doc/review/file_storage.md
- doc/review/placeholders.md

Method:

- Primary evidence from the six review documents above.
- Clarifications validated against source files where needed.

## Findings (Ordered by Severity)

### High 1: Notepad/Panel provider duplication is very high and should be consolidated

Evidence:

- Todo/Notes component has many provider classes in one area (doc/review/code_structure.md:390, doc/review/code_structure.md:404, doc/review/code_structure.md:413).
- source confirms multiple parallel implementations in one handler:
  - src/handlers/sidebarNotes-handler.ts:626
  - src/handlers/sidebarNotes-handler.ts:874
  - src/handlers/sidebarNotes-handler.ts:1102
  - src/handlers/sidebarNotes-handler.ts:1469
  - src/handlers/sidebarNotes-handler.ts:1834
  - src/handlers/sidebarNotes-handler.ts:2155
  - src/handlers/sidebarNotes-handler.ts:2455
  - src/handlers/sidebarNotes-handler.ts:2746

Impact:

- High maintenance cost and drift risk (behavior/parity bugs across near-identical providers).
- Harder testing and slower feature rollout.

Recommendation:

- Introduce one configurable `GenericNotepadProvider` with declarative profile config:
  - storage backend (file/workspaceState/queue),
  - default template,
  - send target (copilot/localLlm/conversation/tomAiChat),
  - toolbar actions and permissions.
- Keep only thin wrappers for registration metadata if needed.

### High 2: Placeholder engine fragmentation is causing behavioral inconsistency

Evidence:

- Explicitly documented as multiple incompatible engines (doc/review/placeholders.md:286, doc/review/placeholders.md:291).
- Runtime reminder replacement uses mustache tokens (`{{...}}`): src/managers/reminderSystem.ts:222.
- Editor help for reminders is duplicated and presented in `${...}` style:
  - src/handlers/queueEditor-handler.ts:422
  - src/handlers/timedRequestsEditor-handler.ts:244
- Two separate trail token resolvers exist:
  - src/services/trailService.ts:277
  - src/handlers/trailViewer-handler.ts:521

Impact:

- Same placeholder can work in one context and fail silently in another.
- User-facing confusion and support burden.

Recommendation:

- Define a single placeholder contract with typed capability levels:
  - `full-template`, `path-limited`, `trail-limited`, `reminder-limited`.
- Use one shared parser/resolver core and context-specific allow-lists.
- Generate help text from capability metadata to avoid drift.

### High 3: Configuration/state model is split across too many stores without clear ownership boundaries

Evidence:

- 27 contributed settings plus heavy workspaceState usage (doc/review/configuration_structure.md:28, doc/review/configuration_structure.md:68).
- Legacy compatibility keys still in active read model (doc/review/configuration_structure.md:99, doc/review/configuration_structure.md:100, doc/review/configuration_structure.md:233).
- `tomAi.windowId` is documented as read without writer (doc/review/configuration_structure.md:101).
- `globalState` and `secrets` are unused (doc/review/configuration_structure.md:64, doc/review/configuration_structure.md:65).

Impact:

- Higher risk of stale/migrated state bugs and hard-to-debug behavior differences.
- Sensitive or user-global values may live in workspace files by accident.

Recommendation:

- Adopt explicit storage taxonomy:
  - Workspace-shared project state: `.tom/tom_vscode_extension.workspace.yaml`
  - User-global preferences: `~/.tom/vscode/tom_vscode_extension.user.yaml`
  - Session/window volatile state: workspaceState + per-window runtime files
  - Secrets: VS Code `secrets` API
- Add a versioned migration framework and remove legacy keys after one stable migration cycle.

### Medium 1: Action/command surface is oversized and duplicates intent

Evidence:

- 75 contributed commands (doc/review/extension_elements.md:8).
- Multiple command variants for nearly identical actions (doc/review/extension_elements.md:132 to doc/review/extension_elements.md:151).

Impact:

- Command palette clutter and discoverability reduction.
- More wiring to maintain for equivalent behavior.

Recommendation:

- Collapse variant commands into parameterized command handlers.
- Keep only high-frequency actions as top-level commands; move variants to quick-pick flows.

### Medium 2: Duplicate reminder help constants should be centralized

Evidence:

- Same `REMINDER_TEMPLATE_HELP` constant appears in two editors:
  - src/handlers/queueEditor-handler.ts:422
  - src/handlers/timedRequestsEditor-handler.ts:244

Impact:

- Documentation drift risk (already visible with syntax mismatch).

Recommendation:

- Move reminder placeholder help generation into a single shared helper (for example in promptTemplate or a dedicated reminder template module).

### Medium 3: Panel/view duplication suggests reusable shell opportunities

Evidence:

- 12 views across containers (doc/review/extension_elements.md:11).
- Similar functional views exist in sidebar and explorer for TODO log/window status (doc/review/extension_elements.md view inventory section).

Impact:

- UI logic duplication and inconsistent UX over time.

Recommendation:

- Build a shared panel shell (`BaseWebviewProvider`-driven) with configurable data adapters and action maps.
- Keep one implementation per domain, expose it in multiple containers through wiring only.

### Medium 4: Structural concentration in handlers weakens modularity

Evidence:

- 65 of 107 TS files are under handlers (doc/review/filestructure.md source snapshot).
- Review explicitly flags handlers as structural hotspot (doc/review/filestructure.md:141).

Impact:

- Feature coupling and low cohesion in handlers.
- Harder unit test isolation and ownership boundaries.

Recommendation:

- Move domain logic from handlers into feature services/use-cases.
- Keep handlers as adapter/controller layers only.

### Low 1: Comment quality is generally strong, but some comments are stale or misleading

Evidence:

- Good top-level explanatory comments exist in core modules (for example variable resolver and prompt template modules).
- Reminder template interface comment says `Template text with ${variables}` while runtime replacement is mustache-based:
  - src/managers/reminderSystem.ts:23
  - src/managers/reminderSystem.ts:222

Impact:

- Misleading comments increase implementation and usage mistakes.

Recommendation:

- Treat comments as executable docs:
  - update stale comments as part of behavioral changes,
  - forbid duplicate free-text help blocks in code review.

## Coverage Check Against Requested Verification Scope

1. Code duplication and consolidation candidates

- Covered in High 1 and Medium 2.
- Concrete consolidation targets are listed, including GenericNotepadProvider and shared reminder help generation.

1. Unlucky patterns and room for improvement

- Covered in High 2 and Medium 4.
- Placeholder-engine fragmentation, mixed replacement behavior, and handler concentration are documented with refactoring directions.

1. Duplicate actions, panels, editors for shared-component redesign

- Covered in Medium 1, Medium 3, and the dedicated Actions/Panels/Editors consolidation section.
- Includes command-surface reduction and shared panel-shell recommendations.

1. Duplicate configuration

- Covered in High 3 and Duplicate Configuration Assessment.
- Legacy/new key overlap and multi-store ownership duplication are explicitly identified.

1. Configuration placement and possible global shared config

- Covered in Configuration Location Recommendations.
- Recommends introducing a user-global config file for cross-workspace defaults and a workspace-local config for project-scoped behavior.

## Duplicate Configuration Assessment

Observed duplicates and overlaps:

- Legacy + new chat variable state (`chatVar_*` and `chatVariablesStore`).
- Multiple path/token replacement subsystems for related path concerns.
- Settings + config file + workspaceState + panel YAML storing adjacent concerns.

Advice:

- Define a single source of truth per domain:
  - chat context: `ChatVariablesStore` only,
  - queue/timed operational state: file-backed schema only,
  - UI ephemeral state: workspaceState only,
  - persistent user preference defaults: global user config.

## Configuration Location Recommendations

Current model is workable but can be improved by a formal two-file strategy:

1. Add a global user config file

- Proposed: `~/.tom/vscode/tom_vscode_extension.user.yaml`
- Store likely cross-workspace/shared values here:
  - user identity defaults,
  - preferred model/profile defaults,
  - bridge binary/executable defaults,
  - favorites and reusable personal templates.

1. Keep workspace/project config local

- Continue with `.tom/tom_vscode_extension.workspace.yaml` (or existing json name if migration postponed).
- Keep quest/workspace paths, project conventions, queue/todo file patterns local.

1. Keep secrets out of both files

- Store tokens/credentials in VS Code `secrets`.

1. Add deterministic merge order

- `defaults < user-global < workspace-local < runtime overrides`

## Actions, Panels, Editors Consolidation Opportunities

Recommended shared components:

- `GenericNotepadProvider` for all notepad-like providers.
- `TemplateAwareEditorShell` for queue/timed/template editors.
- `UnifiedPlaceholderHelpProvider` generated from resolver capability metadata.
- `UnifiedTrailPathResolver` reused by trail service and trail viewer.

## Code Structure Assessment

Strengths:

- Existing layering (`handlers`, `managers`, `services`, `storage`, `utils`) is a strong foundation.
- Several central utilities already exist (FsUtils, TomAiConfiguration, variable resolver).

Weaknesses:

- Handlers remain overgrown and contain both orchestration and business logic.
- Domain-specific duplication in UI-provider and template/help concerns.

Overall:

- Structure is directionally good but currently in a "scaling strain" phase; targeted consolidation will likely provide large maintenance wins.

## Clean Code Guidance and Prioritized Refactoring Plan

1. First wave (high ROI, low risk)

- Consolidate reminder help text and syntax handling.
- Create one trail path resolver and remove parallel token logic.
- Add migration to retire `chatVar_quest` and `chatVar_role`.

1. Second wave (medium ROI)

- Introduce generic notepad provider and migrate two to three providers first.
- Parameterize duplicated command variants.

1. Third wave (architecture)

- Introduce user-global config file and explicit merge pipeline.
- Move sensitive values to `secrets` and document storage policy.

Expected outcome:

- Lower drift risk, fewer behavior mismatches, reduced command/UI clutter, and clearer long-term maintainability.
