# File and Prompt Placeholders

This reference documents placeholders used by prompt/template flows in the extension.

## Placeholder sources

Placeholder expansion is applied through template helpers in handler shared logic and prompt template expansion.

Primary categories:

- workspace/context values (`workspace`, `workspaceFolder`, `vs-code-workspace-name`, `vs-code-workspace-folder`, file, selection),
- chat variables (`quest`, `role`, `activeProjects`, `todo`, `workspaceName`),

## VS Code Workspace Placeholders

| Placeholder | Description | Example |
|---|---|---|
| `${vs-code-workspace-name}` | Name derived from the open `.code-workspace` file (without extension). Falls back to `"default"` when no `.code-workspace` file is open. | `vscode_extension` |
| `${vs-code-workspace-folder}` | Absolute path to the workspace root folder. | `/Users/.../tom_agent_container` |
| `${workspaceFolder}` | Same as `vs-code-workspace-folder` (VS Code standard) | `/Users/.../tom_agent_container` |
| `${workspace}` | Workspace display name from VS Code | `vscode_extension` |
- template-specific values from command/workflow context,
- response values extracted from Copilot answer JSON payloads.

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

## Notes

- Placeholder syntax and available fields are configuration-driven.
- If a placeholder resolves to empty, templates should still remain valid text prompts.
