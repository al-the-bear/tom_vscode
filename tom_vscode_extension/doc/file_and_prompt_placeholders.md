# File and Prompt Placeholders

This reference documents placeholders used by prompt/template flows in the extension. For the **maintainer-facing view** — which resolver runs where, what each capability level accepts — see the companion doc [placeholder_engine.md](placeholder_engine.md).

## Placeholder sources

Placeholder expansion is applied through template helpers in handler shared logic and prompt template expansion.

Primary categories:

- workspace/context values (`workspace`, `workspaceFolder`, `vs-code-workspace-name`, `vs-code-workspace-folder`, file, selection),
- chat variables (`quest`, `role`, `activeProjects`, `todo`, `workspaceName`),
- file-injection placeholders — active role/quest shortcuts (`role-description`, `quest-description`), workspace instructions (`claude.md`, `agents.md`, `instructions`, `agent-instructions`, `claudeMd`; `copilot-instructions` deprecated), named guideline/role/quest files (`guidelines-<name>`, `role-<name>`, `quest-<type>`), arbitrary files (`file-<path>`), and the quest memory (`memory`, `memory-quest`). See [File-injection placeholders](#file-injection-placeholders) below for the full reference.

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
- Response values extracted from an answer's text

## Response values

A queue item's answer text can carry response values in one of these shapes:

- JSON: `"responseValues": { "KEY": "value" }`
- YAML: a `responseValues:` line followed by indented `key: value` lines
- a `variables:` line followed by `- key = value` (or `- key: value`) lines

`responseValues` can be reused in later template expansions as `${chat.KEY}`.

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
| `${claude.md}` | `CLAUDE.md` of the workspace folder |
| `${agents.md}` | `AGENTS.md` of the workspace folder |
| `${instructions}` | `CLAUDE.md` if present; otherwise `AGENTS.md` |
| `${agent-instructions}` | The workspace folder's `CLAUDE.md` with the files it imports (`@…`), expanded as Claude Code does — so the shared `workspace_agents.md` and `AGENTS.md` are included; `AGENTS.md` when there is no `CLAUDE.md`. Prefer this in templates that should carry the workspace's rules. |
| `${copilot-instructions}` | Deprecated: the same as `${agent-instructions}` (also `${copilot-instructions.md}`). `.github/copilot-instructions.md` is no longer read. |
| `${claudeMd}` | Every `CLAUDE.md` as Claude Code loads it (`src/services/claudeMd.ts`): `~/.claude/CLAUDE.md`; then each folder from the farthest ancestor of the workspace root down to the root — its `CLAUDE.md`, then its `CLAUDE.local.md`; after each file the files it imports with `@path` (relative to it, `~/…` or absolute; nested up to five levels, each file once, not from inline code or fenced blocks). Each under `Contents of <path> (user / project / private project instructions, or imported by …):`. For direct, Local LLM and VS Code LM profiles — the Agent SDK loads these files itself. |

### Skills

| Placeholder | Expands to |
| --- | --- |
| `${skills-list}` | The skills of `.claude/skills/` as the system prompt lists them: the `## Skills` heading, the instruction to call `tomAi_loadSkill` first, one line per skill (name and description). It is the text of the aspect guideline `skills` (choice `all`, the default); a send fills it only on the transports with the extension's own tool loop (direct, Local LLM, VS Code LM) when it carries `tomAi_loadSkill` — on the Agent SDK (which loads skills itself) it reads empty. |

### Project guidelines

`${guidelines-<name>}` reads a single file from the workspace guidelines folder:

1. `_agent_guidelines/<name>.md` (primary — matches the project convention)
2. `_guidelines/<name>.md` (fallback when no `_copilot_` prefix is used)

`<name>` can either include the `.md` extension or omit it. Examples:

| Placeholder | File read |
| --- | --- |
| `${guidelines-index}` or `${guidelines-index.md}` | `_agent_guidelines/index.md` |
| `${guidelines-project_guidelines}` | `_agent_guidelines/project_guidelines.md` |
| `${guidelines-dart/coding_guidelines}` | `_agent_guidelines/dart/coding_guidelines.md` (subfolder paths work too) |

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
${quest-todos}          → _ai/quests/<quest>/todos.<quest>.todo.yaml
${quest-references}     → _ai/quests/<quest>/references.<quest>.md
```

`${quest-quest-notes}` is the quest's default notes file, `_ai/quests/<quest>/notes/quest-notes.md` (for a quest that keeps its notes in `quest-notes.<quest>.md` in the quest folder and has no `notes/quest-notes.md`: that file).

Requires the `quest` chat variable to be set. Like `${role-description}`, `${quest-description}` is reserved for the active-quest shortcut and is not overridden by this pattern.

### Arbitrary files

`${file-<path>}` reads any file by path:

- Absolute when `<path>` starts with `/` (or a Windows drive letter like `C:\`).
- Otherwise resolved relative to the **workspace root**.

```text
${file-README.md}                      → <workspace>/README.md
${file-src/main.ts}                    → <workspace>/src/main.ts
${file-/etc/hosts}                     → /etc/hosts (absolute)
${file-doc/design-decisions.md}  → <workspace>/doc/design-decisions.md
```

### Memory

The quest memory (`_ai/quests/<quest>/memory/`, shared by every session; there is no shared memory across quests) is exposed as placeholders so you can put it wherever gives you the best prompt-caching behavior:

| Placeholder | Expands to |
| --- | --- |
| `${memory}` | The current quest's memory, prefixed by `## Memory`: the curated files (`facts.md`, …), newest first, each under `### quest/<file>`; then this host's candidates from the automatic extraction under their own heading, `### candidates/candidates.<host>.md — …`, newest first. |
| `${memory-quest}` | The same as `${memory}`. |

Char budget comes from `anthropic.memory.maxInjectedTokens × 4` (default 3000 tokens → 12000 chars). A curated file that would push the block past budget is left out; of the candidates as many of the newest lines as fit are taken. Other hosts' candidates files are not injected. With a profile's memory suffix the block holds only `facts-<suffix>.md` and this host's candidates meant for that file.

While the folder `_ai/memory/<quest>/` exists, the memory files the send's session wrote there (`_ai/memory/<quest>/<session>/*.md`; with a suffix `facts-<suffix>.md` of the session `default@default`) follow the quest folder's, each under `### quest/<file> (session <session>)`, within the same budget.

**Prompt caching note.** Anthropic's prompt cache matches on a byte-identical prefix; any change to the system prompt invalidates the cache for that session. Memory content changes as the extractor runs → drop `${memory}` into a **user-message template** rather than the profile's system prompt, and the system prefix stays stable so the cache keeps hitting.

Quick setups:

- **Caching-friendly** — system prompt has no memory; user-message template is `default-memory-injection` extended with `${memory}` at the top, or a dedicated `with-memory` template that prepends `${memory}\n\n${userMessage}`.
- **Simple** — put `${memory}` at the top of the profile's system prompt. Memory shows up without any user-template changes, but caching misses every turn.
- **Tool-only** — don't use the placeholder at all; enable memory tools in the compaction panel. The agent reads memory via `tomAi_readMemory` / `tomAi_listMemory` on demand; no injection, no cache invalidation.

### Imports

The files the placeholders above inject — `${file-…}`, `${guidelines-…}` and the guideline indexes, `${role-…}` and `${role-description}`, `${quest-…}` and `${quest-description}` — and the aspect guideline choice files take Anthropic's `@import` notation, so a file reads the same in the extension and in Claude Code (`src/utils/lineImports.ts`):

- A line that holds only `@<path>` (whitespace around it allowed) is replaced in place by that file's content when the path names an existing file. The path is relative to the importing file, `~/…` (the home folder) or absolute.
- The imported file's own import lines are expanded too, nested up to five levels; an import line deeper than that stays as written.
- Each file is imported once per resolution: a second import of a file already in it — a repeat, or a cycle back to a file on the way, the importing file included — drops the line.
- Never inside a fenced code block (` ``` ` or `~~~`). Any other `@` stays as written: inside a sentence, in an inline code span, `@T: …`, `@CHAT`, a path that names no file.

```text
## Dart rules
@dart/coding_guidelines.md      → replaced by _agent_guidelines/dart/coding_guidelines.md
See @dart/unit_tests.md.        → stays (not alone on its line)
```

`tomAi_readGlobalGuideline` expands the imports of the index files it returns (`index.md`, `index_root.md`, `index_workspace.md`) the same way. `${claudeMd}` and `${agent-instructions}` load a CLAUDE.md with its imports as Claude Code does (an `@path` anywhere in the text), listing each imported file.

### Available in every template context

All file-injection placeholders work inside system prompts, user-message templates, and compaction and memory-extraction templates. They resolve the same way everywhere.

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

Runs with every build of the quest history (every `runEveryNRounds` rounds, and with **Rebuild history and memory**), once per chunk of new inputs. Produces the quest's compacted history (`_ai/quests/<quest>/history/compacted_history.md`), which the Anthropic handler injects into the wire payload between the raw turns and the current user prompt of every session.

| Placeholder | Meaning |
| --- | --- |
| `${existingSummary}` | The quest's compacted history as it stood before this chunk. Empty (`"(empty — …)"`) on the first build or when the Compaction dry-run is invoked in a batch mode. |
| `${lastTurn}` | The new content to integrate: the chunk's inputs — each trail turn as `[user] [<time> · host <host> · session <session>]` with its prompt and `[assistant]` its answer, each archived todo as `[system] Archived todo …` with its record; when the dry-run button runs a batch mode (`summary` / `trim_and_summary`) it's the whole history / overflow slice instead. |
| `${lastTurnCharCount}` | Character count of `${lastTurn}` — useful when the template wants to tell the model roughly how much new material it's integrating. |
| `${maxHistoryTokens}` | Target token budget for the summary. Sourced from the Status Page → History Compaction → **Compacted history max tokens** field. |
| `${maxHistorySize}` | The same budget expressed in characters (`maxHistoryTokens × 4`). Use this to steer verbosity — writing "produce a summary of approximately `${maxHistorySize}` characters" gives the model a concrete target. |

### Memory extraction template

Runs with every build of the quest history, over the new turns of each session (controlled by the History Compaction section's **Run memory extraction** toggle; **Rebuild history and memory** always runs it). Its output becomes this host's memory candidates for the target file.

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

### Aspect conditions and the `prompt.*` variables

An aspect guideline choice's `when:` and an aspect's `remove_when:` (in
`_ai/aspect_guidelines/<aspect>/aspect.yaml`) are expressions of this language,
evaluated while a prompt is prepared; the choice is sent while its `when:` holds
(its value is set), the aspect sends nothing while `remove_when:` holds. Besides
every variable above they read the **prompt facts**:

| Variable | Value |
| --- | --- |
| `prompt.transport` | `direct`, `agentSdk`, `localLlm` or `vscodeLm` |
| `prompt.kind` | `chat` (a chat panel's send), `queue`, `todo` (a queue stage that runs a todo), `proceed` (a process step's Proceed prompt), `timed` (a timed request's) |
| `prompt.todo` | the id of the todo the prompt runs, `''` when none |
| `prompt.role`, `prompt.roleType` | the role the prompt runs as and its role type (`_ai/role-types/<type>`) |
| `prompt.run` | the process run |
| `prompt.process` | the run's process, `''` when it has none |
| `prompt.quest`, `prompt.workspace` | the quest, and the workspace folder's name |
| `prompt.night` | the effective choices of the night-mode aspect (`night_mode` or `night`), `''` when there is none |

```text
when: prompt.transport != "direct" && prompt.kind == "todo"
when: (prompt.roleType == "coder" || prompt.roleType == "reviewer")
remove_when: prompt.night == "on"
```

An expression that cannot be evaluated is logged and counts as not holding.

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
