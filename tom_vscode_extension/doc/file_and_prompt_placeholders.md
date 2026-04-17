# File and Prompt Placeholders

This reference documents placeholders used by prompt/template flows in the extension.

## Placeholder sources

Placeholder expansion is applied through template helpers in handler shared logic and prompt template expansion.

Primary categories:

- workspace/context values (`workspace`, `workspaceFolder`, `vs-code-workspace-name`, `vs-code-workspace-folder`, file, selection),
- chat variables (`quest`, `role`, `activeProjects`, `todo`, `workspaceName`),
- file-injection placeholders — active role/quest shortcuts (`role-description`, `quest-description`), workspace instructions (`claude.md`, `copilot-instructions`, `instructions`), named guideline/role/quest files (`guidelines-<name>`, `role-<name>`, `quest-<type>`), and arbitrary files (`file-<path>`). See [File-injection placeholders](#file-injection-placeholders) below for the full reference.

## VS Code Workspace Placeholders

| Placeholder | Description | Example |
| --- | --- | --- |
| `${vs-code-workspace-name}` | Name derived from the open `.code-workspace` file (without extension). Falls back to `"default"` when no `.code-workspace` file is open. | `vscode_extension` |
| `${vs-code-workspace-folder}` | Absolute path to the workspace root folder. | `/Users/.../tom_agent_container` |
| `${workspaceFolder}` | Same as `vs-code-workspace-folder` (VS Code standard) | `/Users/.../tom_agent_container` |
| `${workspace}` | Workspace display name from VS Code | `vscode_extension` |
| `${userMessage}` | Raw user input. Resolves to the typed text inside `anthropicUserMessage` templates (anthropic_sdk_integration.md §7.3); empty string in every other template context. | `Refactor the auth middleware to drop the legacy session shim.` |

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

### Available in every template context

All file-injection placeholders work inside system prompts, user-message templates, compaction and memory-extraction templates, Local LLM / Tom AI Chat / Copilot prompt templates, and the AI Conversation orchestrator prompts. They resolve the same way everywhere.

### Conditional injection via JS expressions

```text
${{ vars["role-description"] ? "## Your role\n" + vars["role-description"] + "\n" : "" }}
${{ vars["quest-description"] ? "## Current quest\n" + vars["quest-description"] + "\n" : "" }}
${{ vars["instructions"] ? "## Workspace instructions\n" + vars["instructions"] + "\n" : "" }}
```

Note: inside `${{ ... }}` expressions the dynamic keys (`${guidelines-*}`, `${role-*}`, `${quest-*}`, `${file-*}`) are **not** pre-populated into the `vars` object — they're resolved only when referenced via `${...}`. If you need the content in JS, put the `${...}` form in a separate pass or use `${{ (() => { /* read via fs */ })() }}` — most prompts don't need this.

## Notes

- Placeholder syntax and available fields are configuration-driven.
- If a placeholder resolves to empty, templates should still remain valid text prompts.

---

## JavaScript Expression Placeholders

Prompt templates support inline JavaScript expressions using the `${{ ... }}` syntax.
This allows dynamic values, conditional text, and computations that go beyond what
static `${...}` placeholders can provide.

### Syntax

```text
${{ <javascript expression> }}
```

The expression must be a single JS expression (not a statement). It is evaluated and
its result is converted to a string and inserted in place of the `${{ ... }}` block.

```text
Today is ${{ new Date().toDateString() }}
Branch: ${{ vars["git.branch"] === "main" ? "production" : "development" }}
Next item: ${{ Number(vars.repeatNumber) + 1 }}
```

### Evaluation order

JS expressions are evaluated **before** `${...}` placeholders in each resolution pass.
The resolver runs up to 10 passes, so a `${...}` value set in pass 1 can be used by a
`${{ }}` expression in pass 2 — but within a single pass, `${{ }}` always runs first.

### What is in scope

Six objects are injected into every expression:

| Name | Type | Description |
| --- | --- | --- |
| `vars` | `Record<string, string>` | All resolved placeholder values (see below) |
| `env` | `Record<string, string>` | Full `process.env` — all OS environment variables |
| `path` | Node.js `path` module | Path utilities (`path.join`, `path.basename`, etc.) |
| `os` | Node.js `os` module | OS utilities (`os.homedir`, `os.platform`, etc.) |
| `vscode` | VS Code API | Full VS Code extension API namespace |
| `editor` | `TextEditor \| undefined` | `vscode.window.activeTextEditor` — may be `undefined` |

Standard JavaScript globals (`Math`, `Date`, `JSON`, `Array`, `String`, `Number`, etc.)
are also available — this is a normal JS `new Function(...)` context with `"use strict"`.

### Accessing `vars`

`vars` contains all built-in placeholder values as strings, populated before JS
evaluation. Use dot notation for simple keys and bracket notation for keys that
contain dots or dashes.

```js
// Simple keys
vars.workspaceFolder   // workspace root path
vars.username          // OS user name
vars.hostname          // machine hostname
vars.datetime          // YYYYMMDD_HHMMSS timestamp
vars.uuid              // random UUID v4

// Keys with dots — must use bracket notation
vars["git.branch"]
vars["git.commit"]
vars["git.dirty"]          // "true" or "false"
vars["file.name"]          // filename without extension
vars["file.extension"]     // e.g. ".dart"
vars["file.language"]      // language ID
vars["vs-code-workspace-name"]   // quest/workspace name
vars["vscode.version"]
vars["custom.myVar"]       // custom chat variable
vars["chat.quest"]
vars["chat.todoFile"]
```

All values in `vars` are strings. Convert when doing arithmetic:

```js
Number(vars.repeatCount)
parseInt(vars["custom.count"], 10)
```

#### Repeat-specific values (queue prompts only)

Available when a prompt is part of a repeat sequence:

| Key | Value | Notes |
| --- | --- | --- |
| `vars.repeatCount` | Total number of repetitions | String |
| `vars.repeatIndex` | Current iteration, 0-based | String — `"0"` on first run |
| `vars.repeatNumber` | Current iteration, 1-based | String — `repeatIndex + 1`, use for display |

```js
// Are we on the last repetition?
${{ Number(vars.repeatNumber) === Number(vars.repeatCount) ? "FINAL PASS" : `Pass ${vars.repeatNumber} of ${vars.repeatCount}` }}

// Zero-based index for array access or offset calculations
${{ Number(vars.repeatIndex) * 10 }}
```

### Using the `editor` object

`editor` can be `undefined` when no file is open. Always guard with `?.`:

```js
${{ editor?.document.languageId ?? "unknown" }}
${{ editor?.document.fileName ?? "" }}
${{ editor?.document.getText(editor.selection) ?? "" }}
${{ editor ? path.basename(editor.document.fileName) : "" }}
```

### Using `path` and `os`

```js
${{ path.basename(vars.workspaceFolder) }}
${{ path.join(vars.home, ".tom", "config.json") }}
${{ path.extname(vars["file.name"]) }}
${{ os.homedir() }}
${{ os.platform() }}   // linux, darwin, win32
${{ os.cpus().length }} // number of CPU cores
```

### Using `env`

```js
${{ env.HOME }}
${{ env.PATH }}
${{ env.MY_CUSTOM_VAR ?? "default" }}
```

### Using `vscode`

The full VS Code API is available. Some useful examples:

```js
${{ vscode.workspace.workspaceFolders?.length ?? 0 }}
${{ vscode.env.appName }}
${{ vscode.env.sessionId }}
${{ vscode.version }}
${{ vscode.window.activeTextEditor?.document.uri.fsPath ?? "" }}
```

### Error handling

- If the expression throws, the `${{ }}` block is replaced with an empty string `""`.
- The error is logged to the VS Code developer console as:
  `[VariableResolver] JS expression error in ${{...}}: <message>`
- A `null` or `undefined` result also produces `""`.

### Practical examples

```text
// Conditional branch label
${{ vars["git.branch"] === "main" ? "PROD" : "DEV" }}

// Next iteration number
${{ Number(vars.repeatNumber) + 1 }}

// Workspace name from path
${{ path.basename(vars.workspaceFolder) }}

// Filter all vars keys that contain "count"
${{ Object.keys(vars).filter(k => k.includes("count")).join(", ") }}

// Format today's date manually
${{ (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; })() }}

// Safely read selected text or fall back to file name
${{ editor?.document.getText(editor.selection) || vars["file.name"] || "no file" }}

// Read an environment variable with fallback
${{ env.PROJECT_PREFIX ?? vars["vs-code-workspace-name"] }}

// Conditional prompt section (multi-line via ternary)
${{ vars["git.dirty"] === "true" ? "⚠️ There are uncommitted changes.\n" : "" }}
```

### Limitations

- The expression must be a single JS **expression**, not a statement block. Use IIFEs
  (`(() => { ... })()`) for multi-step logic.
- JS expressions run with `"use strict"` and have no access to Node.js `require` or the
  file system beyond what the injected objects expose.
- `${{ }}` is **not** evaluated when the resolver is called in path-only mode
  (e.g. folder path fields in configuration). It is only active in prompt templates.
- `${{ }}` runs before `${...}` in the same pass, so it cannot reference the result of
  a `${...}` replacement made earlier in the same string during the same pass.
