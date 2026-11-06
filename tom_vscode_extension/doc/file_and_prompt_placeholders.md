# File and Prompt Placeholders

This reference documents placeholders used by prompt/template flows in the extension. For the **maintainer-facing view** — which resolver runs where, what each capability level accepts — see the companion doc [placeholder_engine.md](placeholder_engine.md).

## Placeholder sources

Placeholder expansion is applied through template helpers in handler shared logic and prompt template expansion.

Primary categories:

- workspace/context values (`workspace`, `workspaceFolder`, `vs-code-workspace-name`, `vs-code-workspace-folder`, file, selection),
- chat variables (`quest`, `role`, `activeProjects`, `todo`, `workspaceName`),
- file-injection placeholders — active role/quest shortcuts (`role-description`, `quest-description`), workspace instructions (`claude.md`, `copilot-instructions`, `instructions`), named guideline/role/quest files (`guidelines-<name>`, `role-<name>`, `quest-<type>`), arbitrary files (`file-<path>`), and two-tier memory (`memory`, `memory-shared`, `memory-quest`). See [File-injection placeholders](#file-injection-placeholders) below for the full reference.

## VS Code Workspace Placeholders

| Placeholder | Description | Example |
| --- | --- | --- |
| `${vs-code-workspace-name}` | Name derived from the open `.code-workspace` file (without extension). Falls back to `"default"` when no `.code-workspace` file is open. | `vscode_extension` |
| `${vs-code-workspace-folder}` | Absolute path to the workspace root folder. | `/Users/.../tom_agent_container` |
| `${workspaceFolder}` | Same as `vs-code-workspace-folder` (VS Code standard) | `/Users/.../tom_agent_container` |
| `${workspace}` | Workspace display name from VS Code | `vscode_extension` |
| `${userMessage}` | Raw user input. Resolves to the typed text inside the profile's user-message template; empty string in every other template context. See [anthropic_handler.md](anthropic_handler.md). | `Refactor the auth middleware to drop the legacy session shim.` |
| `${wrappedPrompt}` | The user message **after** the profile's user-message template has expanded. Resolves only inside a profile's `userPromptWrapper`; empty elsewhere. Lets a profile add a caching-stable outer envelope (memory, instructions) around a memory-aware inner template without the outer envelope invalidating the prompt cache when memory changes. | (result of user-message template applied to the raw input) |

## Additional Placeholder Categories

- Template-specific values from command/workflow context
- Response values extracted from Copilot answer JSON payloads

## Copilot answer JSON placeholders

When using answer-file workflows, generated JSON follows:

- `requestId`
- `generatedMarkdown`
- optional `comments`
- optional `references`
- optional `requestedAttachments`
- optional `responseValues`

`responseValues` can be reused in later template expansions.

## File-oriented placeholder behavior

For send-to-chat style commands:

- selected text is preferred when available,
- active file path and workspace-root context can be injected,
- fallback behavior uses current editor buffer or prompt text.

## File-injection placeholders

These placeholders read the **contents** of a file at variable-resolution time and inline the result. If the file does not exist (or the referenced chat variable is empty), the placeholder resolves to `""` — never throws — so templates stay valid prompts.

### Eagerly populated (role + quest description)

Two shortcuts for the most common case — the active role / quest from the Chat Variables Editor:

| Placeholder | File read | Depends on |
| --- | --- | --- |
| `${role-description}` | `_ai/roles/${role}/role.md` | `role` chat variable |
| `${quest-description}` | `_ai/quests/${quest}/overview.${quest}.md` | `quest` chat variable |

### Workspace instructions

| Placeholder | File read |
| --- | --- |
| `${claude.md}` | `CLAUDE.md` at the workspace root |
| `${copilot-instructions}` | `.github/copilot-instructions.md` (also accepts `${copilot-instructions.md}`) |
| `${instructions}` | `CLAUDE.md` if present; otherwise `.github/copilot-instructions.md`. Prefer this in templates that should work in either type of workspace. |

### Project guidelines

`${guidelines-<name>}` reads a single file from the workspace guidelines folder:

1. `_copilot_guidelines/<name>.md` (primary — matches the project convention)
2. `_guidelines/<name>.md` (fallback when no `_copilot_` prefix is used)

`<name>` can either include the `.md` extension or omit it. Examples:

| Placeholder | File read |
| --- | --- |
| `${guidelines-index}` or `${guidelines-index.md}` | `_copilot_guidelines/index.md` |
| `${guidelines-project_guidelines}` | `_copilot_guidelines/project_guidelines.md` |
| `${guidelines-dart/coding_guidelines}` | `_copilot_guidelines/dart/coding_guidelines.md` (subfolder paths work too) |

### Specific roles

`${role-<name>}` reads one role file. It tries two layouts in order so either convention works:

1. `_ai/roles/<name>.md` (flat)
2. `_ai/roles/<name>/role.md` (folder — same layout used by `${role-description}`)

```text
${role-reviewer}           → _ai/roles/reviewer.md, else _ai/roles/reviewer/role.md
${role-senior_engineer}    → _ai/roles/senior_engineer.md, …
```

`${role-description}` is reserved for the active-role shortcut (above) and is not overridden by `${role-*}` — it keeps its existing semantics.

### Quest files

`${quest-<type>}` reads the **first file** in `_ai/quests/${quest}/` whose name starts with `<type>.${quest}.` — regardless of extension. This lets you address every quest artefact with a short name:

```text
${quest-overview}       → _ai/quests/<quest>/overview.<quest>.md
${quest-copilot_todos}  → _ai/quests/<quest>/copilot_todos.<quest>.md
${quest-todos}          → _ai/quests/<quest>/todos.<quest>.yaml
${quest-references}     → _ai/quests/<quest>/references.<quest>.md
```

Requires the `quest` chat variable to be set. Like `${role-description}`, `${quest-description}` is reserved for the active-quest shortcut and is not overridden by this pattern.

### Arbitrary files

`${file-<path>}` reads any file by path:

- Absolute when `<path>` starts with `/` (or a Windows drive letter like `C:\`).
- Otherwise resolved relative to the **workspace root**.

```text
${file-README.md}                      → <workspace>/README.md
${file-src/main.ts}                    → <workspace>/src/main.ts
${file-/etc/hosts}                     → /etc/hosts (absolute)
${file-_ai/notes/design-decisions.md}  → <workspace>/_ai/notes/…
```

### Memory

The two-tier memory files (`_ai/memory/shared/*.md`, `_ai/memory/quest/<quest>/*.md`) are exposed as placeholders so you can put them wherever gives you the best prompt-caching behavior:

| Placeholder | Expands to |
| --- | --- |
| `${memory}` | Full block: shared memory (priority), then the current quest's memory newest-first, prefixed by `## Memory`. |
| `${memory-shared}` | Only `_ai/memory/shared/*.md`, prefixed by `## Memory (shared)`. |
| `${memory-quest}` | Only the current quest's memory, prefixed by `## Memory (quest)`. |

Char budget comes from `anthropic.memory.maxInjectedTokens × 4` (default 3000 tokens → 12000 chars). Files that would push the block past budget are dropped.

**Prompt caching note.** Anthropic's prompt cache matches on a byte-identical prefix; any change to the system prompt invalidates the cache for that session. Memory content changes as the extractor runs → drop `${memory}` into a **user-message template** rather than the profile's system prompt, and the system prefix stays stable so the cache keeps hitting.

Quick setups:

- **Caching-friendly** — system prompt has no memory; user-message template is `default-memory-injection` extended with `${memory}` at the top, or a dedicated `with-memory` template that prepends `${memory}\n\n${userMessage}`.
- **Simple** — put `${memory}` at the top of the profile's system prompt. Memory shows up without any user-template changes, but caching misses every turn.
- **Tool-only** — don't use the placeholder at all; enable memory tools in the compaction panel. The agent reads memory via `tomAi_readMemory` / `tomAi_listMemory` on demand; no injection, no cache invalidation.

### Available in every template context

All file-injection placeholders work inside system prompts, user-message templates, compaction and memory-extraction templates, and Copilot prompt templates. They resolve the same way everywhere.

### Conditional injection with expressions

```text
${{ role-description ? "## Your role\n" + role-description + "\n" : "" }}
${{ quest-description ? "## Current quest\n" + quest-description + "\n" : "" }}
${{ instructions ? "## Workspace instructions\n" + instructions + "\n" : "" }}
```

An expression reads a variable the way `${name}` does, the file-injection
placeholders (`role-*`, `quest-*`, `guidelines-*`, `file-*`) included. The
language is described under [Expression placeholders](#expression-placeholders).

---

## Compaction and memory extraction placeholders

The compaction and memory extraction templates (Global Template Editor → **Compaction** / **Memory Extraction** categories) get a small additional placeholder set that is **only** resolved during those LLM calls. Everywhere else they expand to empty strings.

### Compaction template

Runs every turn on the configured local LLM. Produces a new running summary that the Anthropic handler injects into the wire payload between the raw turns and the current user prompt.

| Placeholder | Meaning |
| --- | --- |
| `${existingSummary}` | The compacted summary as it stood at the end of the previous turn. Empty (`"(empty — …)"`) on the first turn or when the Compaction dry-run is invoked in a batch mode. |
| `${lastTurn}` | The new content to integrate. In the normal every-turn flow this is one user/assistant pair; when the dry-run button runs a batch mode (`summary` / `trim_and_summary`) it's the whole history / overflow slice instead. |
| `${lastTurnCharCount}` | Character count of `${lastTurn}` — useful when the template wants to tell the model roughly how much new material it's integrating. |
| `${maxHistoryTokens}` | Target token budget for the summary. Sourced from the Status Page → History Compaction → **Compacted history max tokens** field. |
| `${maxHistorySize}` | The same budget expressed in characters (`maxHistoryTokens × 4`). Use this to steer verbosity — writing "produce a summary of approximately `${maxHistorySize}` characters" gives the model a concrete target. |

### Memory extraction template

Runs every turn on the configured local LLM (controlled by the History Compaction section's **Run memory extraction** toggle). Can call the memory tools to write/update the target file.

| Placeholder | Meaning |
| --- | --- |
| `${lastTurn}` | The exchange that just completed (user/assistant pair). |
| `${compactedSummary}` | The running session summary — the same value that sits in the wire payload between raw turns and the current prompt. Gives the extraction call context on what's already been summarised so it doesn't re-record things that are already in the summary. |
| `${existingMemory}` | Current contents of the Memory Extraction template's Target File in its Scope. Lets the extraction call decide between `tomAi_saveMemory` (new entry) vs `tomAi_updateMemory` (refresh an existing one). |
| `${memoryFilePath}` | Absolute path to that memory file, so the prompt can cite it to the model. |
| `${memoryScope}` | `quest` or `shared`. |

### Legacy placeholders (removed)

Earlier iterations used `${compactionHistory}`, `${recentHistory}`, `${turnCount}`, `${tokenEstimate}`, `${compactionMode}`, `${turnsDropped}`, `${keptTurnCount}` — these no longer resolve. Any template still referencing them will see an empty string where they used to appear.

## Writing a placeholder literally

To show a placeholder instead of filling it — a process description or step
prompt that tells the agent what to queue — write it with a second `$`:
`$${repeatTodoId}` (or `$${{expr}}`). Every resolution leaves it alone, and the
model reads `${repeatTodoId}`; the item the agent queues with that text then
resolves it when it is sent. See placeholder_engine.md §1.2.

## Notes

- Placeholder syntax and available fields are configuration-driven.
- If a placeholder resolves to empty, templates should still remain valid text prompts.

---

## Expression Placeholders

Prompt templates decide what to write with `${{ ... }}` expressions: text that
appears only when a variable is set, a fallback, a comparison. The expression
language is small and runs no JavaScript.

### Syntax

```text
${{ <expression> }}
```

The expression is evaluated and its text inserted in place of the
`${{ ... }}` block.

| Form | Meaning |
| --- | --- |
| `name` | A variable, read the way `${name}` reads it: `role-description`, `git.dirty`, `file.name`, `env.HOME`, `guidelines-coding_guidelines`. Unset reads as `""`. |
| `"text"`, `'text'` | Text; escapes `\n`, `\t`, `\r`, `\"`, `\'`, `\\`. |
| `42`, `1.5`, `true`, `false` | Numbers and the two truth values. |
| `a + b` | Joins the two as text. There is no arithmetic. |
| `a == b`, `a != b` | Equal (not equal) as text. |
| `a < b`, `a <= b`, `a > b`, `a >= b` | Numeric when both are numbers, else text order. |
| `a && b`, `a \|\| b`, `!a` | `a \|\| b` is `a` when it is set, else `b`; `a && b` is `b` when `a` is set, else `a`; `!a` is `true` when `a` is not set. |
| `a ? b : c` | `b` when `a` is set, else `c`. |
| `( a )` | Grouping. |
| `empty(a)`, `notEmpty(a)` | Whether `a` is unset / set. |
| `lower(a)`, `upper(a)` | `a` in lower / upper case. |
| `default(a, b)` | `a` when it is set, else `b`. |

A value is **set** when it is non-empty text, `true` or a non-zero number (the
text `"0"` and `"false"` are set: compare them, `git.dirty == "true"`).

Variable names start with a letter or `_` and hold letters, digits, `_`, `.`
and `-`, so `process-context` is one name; there is no subtraction. Precedence,
tightest first: `!`, `+`, the comparisons, `&&`, `||`, `? :`.

```text
${{ role-description ? "## Role\n" + role-description + "\n" : "" }}
${{ git.branch == "main" ? "production" : "development" }}
${{ default(file.name, "(no file)") }}
${{ rawTurns && rawTurnCount > 0 ? "## Raw turns\n\n" + rawTurns : "" }}
${{ notEmpty(selection) ? "Selection:\n" + selection : "" }}
```

### Evaluation order

Expressions are evaluated **before** `${...}` placeholders in each resolution
pass. The resolver runs up to 10 passes, so a `${...}` value set in pass 1 can
be used by an expression in pass 2.

### Errors and templates still in JavaScript

A syntax error yields `""` and logs the error with its position. The names of
the objects the former JavaScript placeholders offered (`vars`, `editor`,
`vscode`, `os`, `path`, `Number`, …) are refused: `vars["process-context"]`
is written `process-context`. `npm run migrate:ai-formats -- --apply` converts
saved templates (the workspace config, the user overlay, the process
definitions); a template it cannot convert — one that called a function such as
`path.basename` or did arithmetic — is reported and left for you to rewrite.

### Limitations

- `${{ }}` is **not** evaluated when the resolver is called in path-only mode
  (e.g. folder path fields in configuration). It is only active in prompt
  templates.
- `${{ }}` runs before `${...}` in the same pass, so it cannot reference the
  result of a `${...}` replacement made earlier in the same string during the
  same pass.
