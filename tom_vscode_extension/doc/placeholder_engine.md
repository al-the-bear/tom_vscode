# Placeholder Engine — Maintainer Reference

Single source of truth for **which placeholder syntax resolves where**. Companion to [file_and_prompt_placeholders.md](file_and_prompt_placeholders.md) — that doc is for template authors; this one is for contributors touching resolver code.

Resolves a finding from the code review: the extension used to ship **five parallel resolvers** with subtly different token sets, and user help text advertised `${…}` syntax while some runtimes accepted only `{{…}}`. Wave 1.2 and 1.3 of the refactoring plan collapsed the trail resolvers and reminder help; this document captures the resulting contract so it doesn't drift again.

## 1. Engines

| Engine | Source | Entry point | Syntax accepted |
| --- | --- | --- | --- |
| **Canonical** | [utils/variableResolver.ts](../src/utils/variableResolver.ts) | `resolveVariables()`, `resolveVariablesAsync()` | `${name}`, `${ns.key}`, `${{js}}` |
| **Template** | [handlers/promptTemplate.ts](../src/handlers/promptTemplate.ts) | `expandTemplate()` | `${name}`, `${{js}}`, **plus** `{{name}}` (mustache alias) |
| **Exec config** | [utils/executableResolver.ts](../src/utils/executableResolver.ts) | `expandConfigPlaceholders()` | `${binaryPath}`, `${home}`, `${workspaceFolder}`, `${env:VAR}`, `~` |
| **Trail paths** | [services/trailPathResolver.ts](../src/services/trailPathResolver.ts) | `resolveTrailPath()` | delegates to canonical + `{quest, subsystem}` overrides |
| **Reminders** | [managers/reminderSystem.ts](../src/managers/reminderSystem.ts) | internal `.replace()` chain in `checkAndGenerateReminder()` | `{{name}}` (mustache only) |

**Rule of thumb:** if your call site sends text to a user-facing AI channel, reach for `expandTemplate`. If it's a path or filesystem string, reach for `resolveVariables` (with `includeEditor: false`, `enableJsExpressions: false`). Don't introduce a new engine.

## 2. Capability levels

Every placeholder context falls into one of four levels. Adding a new context means **picking a level**, not writing a new resolver.

### 2.1 `full-template` (broadest)

**Used by:** prompt bodies, user-message templates, system prompts, template wrappers, tool arguments (Copilot / Local LLM / AI Conversation / Tom AI Chat / Anthropic).

**Engine:** `expandTemplate()`.

**Accepts:** the entire canonical token catalog ([`PLACEHOLDER_HELP`](../src/utils/variableResolver.ts)) — workspace, editor, chat variables, namespaces (`env.*`, `config.*`, `git.*`, `chat.*`, `vscode.*`, `date.*`, `time.*`), JS expressions, file-injection placeholders (`${memory}`, `${role-description}`, `${quest-*}`, `${guidelines-*}`, `${file-*}`, `${claude.md}`), and the `{{…}}` mustache alias for ergonomics.

### 2.2 `path-limited`

**Used by:** commandline cwd fields, bridge profile cwd, queue affixes, trail root configuration.

**Engine:** `resolveVariables()` via `handler_shared.resolvePathVariables()`, or `resolveTrailPath()` for trail-specific patterns.

**Accepts:** canonical tokens minus editor context (`includeEditor: false`) and minus JS expressions (`enableJsExpressions: false`). `{{…}}` mustache is **not** accepted.

### 2.3 `trail-limited`

**Used by:** trail raw path patterns, summary file patterns, trail root discovery in the viewer.

**Engine:** `resolveTrailPath(pattern, { quest, subsystem }, { mode: 'fill' | 'strip' })`.

**Accepts:** everything `path-limited` accepts, **plus** `${quest}` and `${subsystem}` (filled with caller-provided values or stripped in walk-up-to-root mode). Also accepts the legacy `${ai}` token as an alias for `${aiPath}` so pre-existing user config files keep working.

### 2.4 `reminder-limited` (narrowest)

**Used by:** reminder template bodies.

**Engine:** direct `.replace()` chain — the canonical resolver is **not** invoked.

**Accepts:** only the 16 mustache tokens listed in [`REMINDER_PLACEHOLDER_HELP`](../src/managers/reminderSystem.ts) (`{{timeoutMinutes}}`, `{{waitingMinutes}}`, `{{originalPrompt}}`, …). `${…}` tokens are **ignored**. This is the only context that diverges from the canonical surface, and it's documented prominently so reminder authors don't expect `${memory}` to work.

## 3. Single source of truth per help surface

| Help surface | Comes from | Consumers |
| --- | --- | --- |
| Global placeholder list | `PLACEHOLDER_HELP` in [variableResolver.ts](../src/utils/variableResolver.ts) | Template editors, tooltips, doc/file_and_prompt_placeholders.md |
| Reminder-template list | `REMINDER_PLACEHOLDER_HELP` in [reminderSystem.ts](../src/managers/reminderSystem.ts) | Queue editor, timed requests editor |
| Trail path tokens | inline in [trailPathResolver.ts](../src/services/trailPathResolver.ts) jsdoc | — |

**Rule:** if you need help text about a placeholder context, import from one of the sources above. Do not author a second copy. Wave 1.2 removed two duplicate reminder help constants from `queueEditor-handler.ts` and `timedRequestsEditor-handler.ts`; don't re-introduce that pattern.

## 4. Adding a new placeholder

1. If it belongs in the canonical catalog (available everywhere the global resolver runs): add it to `buildVariableMap()` in [variableResolver.ts](../src/utils/variableResolver.ts) and update `PLACEHOLDER_HELP` in the same commit.
2. If it's context-specific (only valid inside a reminder / only inside a trail pattern / …): thread it in as a caller-provided `values` override and document it in the engine table above.
3. Don't add a new engine. If you think you need one, ping the architecture doc first — the review found five accumulated engines and we just collapsed them to four.

## 5. Future work (tracked by the refactoring plan)

- Programmatic help-text generation from a structured `PlaceholderDef[]` table so the prose help for the four levels is derived from the same data. Tracked as a Wave 2 follow-up; out of scope for the Wave 1 unification.

## 6. Related

- [file_and_prompt_placeholders.md](file_and_prompt_placeholders.md) — template-author reference for every placeholder, with examples.
- [review/placeholders.md](review/placeholders.md) — the review document that surfaced the fragmentation.
- [review/review_refactoring_plan.md](review/review_refactoring_plan.md) — Wave 1.2 / 1.3 / 1.5.
- [../_copilot_guidelines/vscode_extension_overview.md](../_copilot_guidelines/vscode_extension_overview.md) — where this doc fits in the broader guideline map.
