# Extension Architecture

## System components

The plugin runtime consists of:

- VS Code extension host (`src/extension.ts`),
- TypeScript handler modules (`src/handlers/*`),
- bridge client integration (`vscode-bridge`),
- AI tooling registration (`src/tools/*`),
- webview managers for panel/editor UX,
- optional external packages (`yaml-graph-core`, `yaml-graph-vscode`).

## Activation flow

During activation, the extension:

1. initializes bridge client,
2. registers commands, key systems, and webviews,
3. initializes stores (chat variables, session todos, queue/timer/reminder),
4. registers Tom AI tools and variable resolvers,
5. registers custom editors (YAML graph and quest todo).

## Panel architecture

- Bottom panel `@CHAT` (`tomAi.chatPanel`) is the AI operations panel.
- Bottom panel `@WS` (`tomAi.wsPanel`) is the workspace/ops panel.
- Explorer views expose notes and todo sidebars.

## Data and state

Primary stateful services:

- `ChatVariablesStore`
- `WindowSessionTodoStore`
- `PromptQueueManager`
- `TimerEngine`
- `ReminderSystem`

These services are initialized once and shared across command handlers.

## Communication boundaries

- VS Code command API for UI and command execution.
- webview `postMessage` channels for panel/editor interaction.
- bridge protocol for delegated scripting and runtime operations.

## Fault tolerance

Critical optional features use soft-fail behavior (for example dynamic imports in YAML graph registration), so core extension activation can still succeed.
