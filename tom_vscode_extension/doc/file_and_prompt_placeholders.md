# File and Prompt Placeholders

This reference documents placeholders used by prompt/template flows in the extension.

## Placeholder sources

Placeholder expansion is applied through template helpers in handler shared logic and prompt template expansion.

Primary categories:

- workspace/context values (`workspace`, `workspaceFolder`, `vs-code-workspace-name`, `vs-code-workspace-folder`, file, selection),
- chat variables (`quest`, `role`, `activeProjects`, `todo`, `workspaceName`),
- file-injection placeholders (`role-description`, `quest-description`),

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

These placeholders read the **contents** of a file at variable-resolution time and inline the result. If the file does not exist or the referenced variable is empty, the placeholder resolves to `""`.

| Placeholder | File read | Depends on |
| --- | --- | --- |
| `${role-description}` | `_ai/roles/${role}/role.md` | `role` chat variable |
| `${quest-description}` | `_ai/quests/${quest}/overview.${quest}.md` | `quest` chat variable |

Both placeholders are available in all template contexts (system prompts, compaction templates, memory extraction templates, etc.).

Example — conditional injection using the JS expression syntax:

```text
${{ vars["role-description"] ? "## Your role\n" + vars["role-description"] + "\n" : "" }}
${{ vars["quest-description"] ? "## Current quest\n" + vars["quest-description"] + "\n" : "" }}
```

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
