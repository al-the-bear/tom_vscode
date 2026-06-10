# Chat & Tooling Enhancements — Specification

**Quest:** vscode_extension
**Created:** 17 February 2026
**Status:** Draft — awaiting review (historical design spec; implementation has since shipped and evolved)

> **Note:** This is the original design spec. Several behaviours described here as "COPILOT panel" sends now route through the **Send-to-Chat target router** (`sendToChatTarget: 'anthropic' | 'copilot'`, default `'anthropic'`), so a "send to chat" can land on the Anthropic transport rather than Copilot. See [copilot_chat_tools.md → Send-to-Chat Target Routing](copilot_chat_tools.md#send-to-chat-target-routing) for the current behaviour.

---

## Table of Contents

1. [LLM Tools](#1-llm-tools)
   - 1.1 Notify User (Telegram)
   - 1.2 Detect Workspace Name
   - 1.3 Quest Todo Management
   - 1.4 Window Session Todo Management (LLM Self-Todo)
2. [Chat Variables (New Feature)](#2-chat-variables-new-feature)
3. [COPILOT Panel Enhancements](#3-copilot-panel-enhancements)
   - 3.1 Compact Panel Layout & Context Popup
   - 3.2 Prompt Queue System
   - 3.3 Timed/Repeat Requests
   - 3.4 "Are You Alive?" Reminder System
4. [QUEST TODO Panel](#4-quest-todo-panel)
5. [Workspace Notes Rework](#5-workspace-notes-rework)
6. [Attachment Upload for Issues/Tests](#6-attachment-upload-for-issuestests)
7. [Chat Variables Editor](#7-chat-variables-editor)

---

## 1. LLM Tools

These are tools callable by local LLM (Ollama), Copilot (via `@dartscript` chat participant tools), and the Tom AI Chat LLM. They are registered as VS Code language model tools and exposed through the bridge protocol.

### 1.1 Notify User (Telegram)

**Purpose:** Allow any LLM to send a notification to the user via Telegram when it needs attention, has completed a long task, or encounters a blocking issue.

**Implementation:**
- New tool: `dartscript_notifyUser`
- Parameters:
  - `message` (string, required) — The notification text
  - `urgency` (enum: `info` | `warning` | `error`, default: `info`) — Controls emoji prefix and notification style
  - `title` (string, optional) — Short title/subject line
- Sends via the existing Telegram bot integration already configured in `tom_vscode_extension.json` under `botConversation.telegram`
- Uses `botTokenEnv` environment variable for the bot token, `defaultChatId` for the target
- Returns confirmation: `{ sent: true, timestamp: "..." }` or error details
- If Telegram is not configured (`telegram.enabled: false`), falls back to VS Code notification (`vscode.window.showInformationMessage`)

**Config reference (already exists in `tom_vscode_extension.json`):**
```json
"telegram": {
  "enabled": false,
  "botTokenEnv": "TELEGRAM_ALTHEBEAR_BOT_TOKEN",
  "allowedUserIds": [279417862],
  "defaultChatId": 279417862
}
```

**Note:** The `enabled` flag should be set to `true` in the config to activate Telegram. When `false`, all notifications go to VS Code's native notification system instead.

### 1.2 Detect Workspace Name

**Purpose:** Allow LLMs to programmatically determine which workspace is open, enabling context-aware behaviour.

**Implementation:**
- New tool: `dartscript_getWorkspaceInfo`
- No parameters required
- Returns:
  ```json
  {
    "workspaceName": "tom_agent_container",
    "workspaceFile": "tom_agent_container.code-workspace",
    "workspaceFolders": ["tom/", "tom_ai/xternal/tom_module_vscode/", ...],
    "quest": "vscode_extension",
    "role": "developer",
    "activeProjects": ["tom_vscode_extension", "yaml_graph_vscode"]
  }
  ```
- Sources workspace name from `vscode.workspace.workspaceFile` or `vscode.workspace.name`
- Quest, role, and active projects come from the chat variables store (see §2)

### 1.3 Quest Todo Management

**Purpose:** Allow LLMs to read, create, update, and query todos from quest YAML files — both the persistent quest todo file and per-session todo files.

**File structure:**
```
_ai/quests/{quest-id}/
├── todos.{quest-id}.yaml              # Persistent quest todos (main file)
├── 20260217_1430_window1.todos.yaml   # Session-scoped todo file
├── 20260217_1445_window2.todos.yaml   # Another session's todos
└── ...
```

Session filenames: `{YYYYMMDD}_{HHMM}_{windowId}.todos.yaml`

**Tools:**
- `dartscript_listTodos` — List todos from a quest, optionally filtered by status, file, or tags
  - Parameters: `questId`, `status?` (filter), `file?` (specific file or `"all"`), `tags?`
  - Returns array of todo items with their source file
- `dartscript_getAllTodos` — Get ALL todos from ALL sources in a single call (quest files + window session)
  - Parameters: `questId`
  - Returns: `{ questTodos: TodoItem[], windowTodos: TodoItem[], sources: { file: string, count: number }[] }`
  - This is the preferred tool when the LLM needs a complete picture of all pending work
- `dartscript_getTodo` — Get a single todo by ID
  - Parameters: `questId`, `todoId`
- `dartscript_createTodo` — Create a new todo in a specified file
  - Parameters: `questId`, `file?` (defaults to session file), `todo` (object matching schema)
  - YAML write uses CST/AST preservation (via `yaml` npm package's `parseDocument` + CST API)
- `dartscript_updateTodo` — Update an existing todo's fields
  - Parameters: `questId`, `todoId`, `updates` (partial todo object)
- `dartscript_moveTodo` — Move a todo from one file to another (e.g., session → persistent)
  - Parameters: `questId`, `todoId`, `targetFile`

**Schema:** Uses existing `_ai/schemas/yaml/todo.schema.json` — todo items have `id`, `title`, `description`, `status`, `priority`, `tags`, `scope`, `references`, `dependencies`, `notes`, `created`, `updated`, `completed_date`, `completed_by`.

**YAML handling:** All reads/writes must preserve YAML formatting, comments, and anchors using the `yaml` package's CST/document API (`parseDocument()` for reads, `doc.toString()` for writes). Never use `JSON.stringify` → `yaml.dump` — always operate on the parsed document model.

### 1.4 Window Session Todo Management (LLM Self-Todo)

**Purpose:** A separate, window-scoped tool for the LLM to store and retrieve its own todos within a session. This prevents the LLM from forgetting postponed tasks, deferred decisions, or follow-up items during a conversation. Unlike quest todos (§1.3), these are transient by design — scoped to the VS Code window session.

**Rationale:** The LLM often postpones actions ("I'll fix this after completing X") or identifies follow-up items during work. Without a persistent self-reminder, these get lost when the context window fills up or the conversation is summarized. This tool gives the LLM a memory scratchpad that survives within a session.

**Storage:** In-memory map + persisted to VS Code workspace state under `windowSessionTodos.{windowId}`. Not written to disk as YAML — these are ephemeral.

**Tools:**
- `dartscript_windowTodo_add` — Add a self-todo item
  - Parameters:
    - `title` (string, required) — Short description
    - `details` (string, optional) — Extended context, reasoning, or notes
    - `priority` (enum: `low` | `medium` | `high`, default: `medium`)
    - `tags` (string[], optional) — Categorization tags
  - Returns: `{ id: string, created: true }`

- `dartscript_windowTodo_list` — List all window session todos
  - Parameters: `status?` (filter: `pending` | `done` | `all`, default: `all`), `tags?`
  - Returns: array of all window session todo items

- `dartscript_windowTodo_getAll` — Get ALL window session todos in a single call (no filtering)
  - Parameters: none
  - Returns: `{ todos: WindowTodoItem[], count: number, pendingCount: number }`

- `dartscript_windowTodo_update` — Mark a todo as done or update its details
  - Parameters: `id`, `status?` (`pending` | `done`), `title?`, `details?`, `priority?`

- `dartscript_windowTodo_delete` — Remove a todo
  - Parameters: `id`

**Data model:**
```typescript
interface WindowTodoItem {
  id: string;        // Auto-generated UUID
  title: string;
  details?: string;
  priority: 'low' | 'medium' | 'high';
  tags: string[];
  status: 'pending' | 'done';
  createdAt: string; // ISO timestamp
  updatedAt: string;
  source: 'copilot' | 'localLlm' | 'tomAiChat'; // Which LLM created it
}
```

**Lifecycle:**
- Created during a session, automatically cleared when the VS Code window closes
- On window start: loads from workspace state (crash recovery)
- "Move to quest" action available (converts to a quest todo via §1.3 `dartscript_createTodo`)

---

## 2. Chat Variables (New Feature)

**Current state:** The extension does NOT have a chat variables panel or any registered `#chatVariables` for Copilot. Placeholder expansion exists (`${dartscript.chat.<key>}`) but only for template processing — these are not visible to Copilot Chat, and there is no UI to view or manage them. This is an entirely new feature.

**New feature:** Register VS Code chat participant variables (`vscode.chat.registerChatVariableResolver`) so Copilot can access workspace context via `#quest`, `#activeProjects`, `#todo`, `#role`, etc. Also create the `ChatVariablesStore` singleton that underpins all other features in this spec.

**Variables to register:**

| Variable | Content | Source |
|----------|---------|--------|
| `#quest` | Current quest ID and overview summary | Chat variables store + quest overview file |
| `#activeProjects` | List of currently active project IDs with paths | Chat variables store |
| `#todo` | Current todo item (if selected) or todo list summary | COPILOT panel selection or quest todo file |
| `#role` | Current role name and description | Chat variables store + role file from `_ai/roles/` |
| `#workspaceName` | Workspace name and file | `vscode.workspace.workspaceFile` |

**Chat variables store:** A singleton `ChatVariablesStore` that:
- Persists state to workspace storage (`context.workspaceState`)
- Tracks current values for quest, activeProjects, todo, role
- Emits change events so panels can react
- Records a change log (last 100 entries) with timestamp, key, old value, new value, and source (`user` | `localLlm` | `copilot` | `tomAiChat`)
- Is accessible from all handlers, the bridge protocol, and LLM tools

---

## 3. COPILOT Panel Enhancements

The COPILOT section lives inside the TOM AI accordion (`UnifiedNotepadViewProvider`). The panel must remain compact — a **single line** for the main controls. Advanced selectors and settings are accessed via a popup. Icons replace text labels to save space.

### 3.1 Compact Panel Layout & Context Popup

The main COPILOT panel should look like this in its default (collapsed) state:

```
┌──────────────────────────────────────────────────────────┐
│ [🔧] [📋▼] [👁️] [📤] [🔄] [📥] [⏱️]  [□Keep] [prompt...] │
└──────────────────────────────────────────────────────────┘
```

**Icon buttons (left to right):**

| Icon | Action | Replaces |
|------|--------|----------|
| 🔧 (wrench) | Opens the **Context & Settings Popup** (see below) | "Template" label, "Autohide" label, all context selectors |
| 📋▼ | Template quick-selector (dropdown, no label) | "Template" label + dropdown |
| 👁️ | Preview (icon only, no "Preview" label) | "Preview" button |
| 📤 | Send / Add to Queue (icon only, no "Send" label) | "Send" button |
| 🔄 | Queue toggle — when active, 📤 adds to queue instead of sending | "Queue" checkbox |
| 📥 | Opens Queue Editor | "Queue (N)" link |
| ⏱️ | Opens Timed Requests Editor | "Repeat" checkbox + stopwatch link |
| □ Keep | Keep checkbox (retains prompt after send) | Unchanged |

**Prompt textarea** fills the remaining space on the right.

#### Context & Settings Popup (🔧)

Clicking the wrench icon opens a floating popup panel (VS Code `QuickPick`-style or custom webview overlay) with all advanced settings grouped into sections:

```
┌─── Context & Settings ──────────────────────────┐
│                                                  │
│ ── Context ──────────────────────────────────── │
│ Quest:      [vscode_extension ▼]                 │
│ Role:       [developer ▼]                        │
│ Projects:   [3 selected ▼]                       │
│ Todo File:  [All files ▼]                        │
│ Todo:       [(None) ▼]                           │
│                                                  │
│ ── Template ─────────────────────────────────── │
│ Template:   [Default ▼]                          │
│ Auto-hide:  [After send ▼]                       │
│                                                  │
│ ── Reminder ─────────────────────────────────── │
│ Prompt:     [Are you alive? ▼] [➕][✏️][🗑️]     │
│ Timeout:    [5] minutes                          │
│ Enabled:    [✓]                                  │
│                                                  │
│                              [Apply] [Cancel]    │
└──────────────────────────────────────────────────┘
```

**Context section** — same selectors as the previous §3.1 spec, but now inside the popup:

##### a) Quest Picker
- Dropdown listing quest IDs from `_ai/quests/` subfolders
- Detection: scan `_ai/quests/*/overview.*.md` to build the list
- Selecting a quest updates `ChatVariablesStore.quest`, refreshes todo file dropdown and role options
- Default: auto-detect from workspace name or last selection (persisted in workspace state)

##### b) Role Selector
- Dropdown listing roles from `_ai/roles/` subfolders
- Each subfolder in `_ai/roles/` is a role with a `role.md` or `role.yaml` file
- Bootstrap: if `_ai/roles/` doesn't exist, show "(No roles defined)" with a "Create roles folder" action
- Updates `ChatVariablesStore.role`

##### c) Project Selector
- Multi-select checklist listing projects from `tom_master.yaml`
- Updates `ChatVariablesStore.activeProjects`

##### d) Todo File Picker
- Dropdown listing YAML todo files from the current quest folder
- Options: "All files" (default, aggregates), `todos.{quest-id}.yaml`, session files
- Refreshes on quest change or file creation/deletion (file watcher)

##### e) Todo Selector
- Dropdown listing todo items from the selected todo file
- Shows `{id}: {title}` with status icon (⬜ not-started, 🔄 in-progress, ✅ completed, ⛔ blocked)
- "(None)" option to clear selection
- Updates `ChatVariablesStore.todo`

**Template section** — the template and auto-hide settings previously inline on the panel.

**Reminder section** — "Are you alive?" reminder configuration (see §3.4 for full details).

**Apply/Cancel** — Apply saves all popup changes to `ChatVariablesStore` and closes the popup. Cancel discards.

### 3.2 Prompt Queue System

**Purpose:** Allow queuing multiple prompts that are sent sequentially to Copilot Chat. After each answer is received (detected via `_answer.json` file), the system processes the answer (extracts info for chat variables, text for trail file) and then sends the next queued prompt.

#### UI Elements

1. **Queue toggle (🔄)** — Icon button on the compact panel bar (see §3.1)
   - When active (highlighted), the Send button (📤) appends the prompt to the queue instead of sending immediately
   - When inactive, 📤 sends directly as before

2. **Queue editor button (📥)** — Icon button on the compact panel bar
   - Badge shows count: "(3)" or empty when queue is empty
   - Clicking opens the Queue Editor (custom editor panel)

3. **Auto-send toggle** — When queue has items and an `_answer.json` is detected:
   - Extract relevant information (update chat variables if answer contains `responseValues`)
   - Write trail file if trail is enabled
   - Wait a configurable delay (default: 2 seconds, configurable in settings)
   - Send the next prompt from the queue

#### Queue Editor (Custom Editor)

A new custom webview editor that opens in the main editor area (not a panel).

**Content:** Ordered list of queued prompts, each showing:
- **Index** — Position in queue (drag-reorderable)
- **Type indicator** — Icon showing source: 📝 normal, ⏱️ timed, ⏰ reminder
- **Template** — Which template was selected for this prompt
- **Original prompt** — The user's raw input (editable textarea)
- **Expanded preview** — The prompt after template processing (read-only, collapsible)
  - Editing the original re-triggers expansion in real-time
- **Status** — `pending` | `sending` | `sent` | `error`
- **Reminder config** — Editable per-item: reminder template dropdown + timeout minutes
- **Actions per item:**
  - 🗑️ Delete from queue
  - ⬆️⬇️ Move up/down (or drag handle)
  - ▶️ Send now (skip queue order)
  - ✏️ Edit (focus the original prompt textarea)

**Queue storage:** In-memory array + persisted to workspace state for crash recovery. Each queue item:
```typescript
interface QueuedPrompt {
  id: string;                    // UUID
  template: string;              // Template name or "(None)"
  originalText: string;          // User's raw prompt
  expandedText: string;          // After template processing
  status: 'pending' | 'sending' | 'sent' | 'error';
  type: 'normal' | 'timed' | 'reminder';  // Source: user, timer, or reminder system
  createdAt: string;             // ISO timestamp
  sentAt?: string;               // When actually sent to Copilot
  error?: string;
  reminderTemplateId?: string;   // Reminder template for this item (null = global default)
  reminderTimeoutMinutes?: number; // Reminder timeout override (null = global default)
  reminderQueued?: boolean;      // Whether a reminder has been queued for this item
}
```

#### Answer Processing Pipeline

When `_answer.json` is detected (file watcher on `${chatAnswerFolder}/${windowId}_${machineId}_answer.json`):

1. Read answer JSON
2. If `responseValues` present → update `ChatVariablesStore` with relevant values
3. If trail is enabled → write answer trail file
4. If queue is non-empty and auto-send is active:
   - Pop next prompt from queue
   - Apply template expansion with current variables
   - Send to Copilot Chat
   - Update queue status to `sending`

### 3.3 Timed/Repeat Requests

**Purpose:** Schedule prompts to be sent at regular intervals or at specific times — for automated monitoring, periodic status checks, or scheduled tasks.

#### UI Elements

1. **Timer button (⏱️)** — Icon button on the compact panel bar (see §3.1)
   - Clicking opens the **Timed Requests Editor** (custom editor panel)
   - Badge shows count of active timed entries: "(2)" or empty

**Note:** Adding new timed entries is done exclusively in the Timed Requests Editor (no inline scheduling from the panel bar). The ⏱️ button is the entry point.

#### Timed Requests Editor (Custom Editor)

A custom webview editor showing a list of scheduled/repeating request entries.

**Each entry has:**
- **Enable/Disable toggle** — Switch to activate/deactivate without deleting
- **Prompt section** — Same as Queue Editor: original prompt textarea + template selector + expanded preview
- **Schedule mode** (radio buttons):
  - **Interval:** "Repeat every X minutes" — numeric input for minutes (min: 1)
  - **Scheduled times:** "Send at specific times" — a list of time entries, each with:
    - Time picker (HH:MM, 24h format)
    - Optional date picker (YYYY-MM-DD) — when set, this entry fires only on that specific day
    - Add/remove time entries
- **Reminder settings** — Per-entry override for the "Are you alive?" reminder (see §3.4):
  - Reminder prompt template: dropdown from configured templates + "None (no reminder)"
  - Reminder timeout: minutes before sending reminder (inherits from global default)
- **Last sent:** Timestamp of last execution
- **Next scheduled:** Computed next fire time
- **Status:** `active` | `paused` | `completed` (for one-shot scheduled entries whose date has passed)

**Actions:**
- ➕ Add new entry
- 🗑️ Delete entry
- ⏸️ Pause / ▶️ Resume individual entry
- Bulk: "Pause All", "Resume All"

**Storage:** Persisted to config file or workspace state. Each entry:
```typescript
interface TimedRequest {
  id: string;
  enabled: boolean;
  template: string;
  originalText: string;
  scheduleMode: 'interval' | 'scheduled';
  intervalMinutes?: number;         // For interval mode
  scheduledTimes?: ScheduledTime[]; // For scheduled mode
  reminderTemplateId?: string;      // Override: which reminder prompt template (null = use global default)
  reminderTimeoutMinutes?: number;  // Override: minutes before reminder (null = use global default)
  lastSentAt?: string;
  status: 'active' | 'paused' | 'completed';
}

interface ScheduledTime {
  time: string;  // "HH:MM"
  date?: string; // "YYYY-MM-DD" — one-shot if present
}
```

**Timer engine:** A singleton `TimerEngine` that:
- Checks every 30 seconds for due entries
- For interval mode: fires if `now - lastSentAt >= intervalMinutes`
- For scheduled mode: fires if current time matches any enabled time entry (within 1-minute window)
- **Always queues into the Prompt Queue (§3.2)** — never sends directly to Copilot Chat
  - When a timed entry fires, it creates a `QueuedPrompt` with template expansion using current variables and appends it to the prompt queue
  - The queue's auto-send mechanism then handles orderly delivery
  - This ensures timed requests, manual queue items, and reminder prompts all execute in FIFO order without overlap
- Skips if the same timed entry already has a pending item in the queue (prevents duplicate queueing)
- Updates `lastSentAt` when the entry is queued (not when it's actually sent by the queue)

### 3.4 "Are You Alive?" Reminder System

**Purpose:** Detect when a sent prompt has not received an answer within a configurable timeout and automatically queue a reminder prompt. This handles cases where Copilot or the LLM stops responding (e.g., due to rate limits, errors, or disconnections), ensuring the user and the automation pipeline are alerted.

#### How It Works

1. When a prompt is sent to Copilot Chat (either directly or via queue auto-send), a **response timer** starts
2. If no `_answer.json` is detected within the configured timeout (default: 5 minutes), the system:
   - Selects the configured reminder prompt template
   - Queues it into the Prompt Queue with high priority (inserted at position 1, after the currently-sending item)
   - Marks the reminder in the queue as `type: 'reminder'` so it's visually distinct
3. Only one reminder is queued per unanswered prompt (no reminder storms)
4. When an answer finally arrives, any pending reminder for that prompt is automatically removed from the queue

#### Reminder Prompt Templates

Templates are CRUD-managed (create, read, update, delete) with the standard ➕ Add / ✏️ Edit / 🗑️ Delete buttons.

**Storage:** In config file (`tom_vscode_extension.json`) under `reminderTemplates`:
```json
"reminderTemplates": [
  {
    "id": "default",
    "name": "Are you alive?",
    "prompt": "Are you still there? The previous prompt has been waiting for {{timeoutMinutes}} minutes without a response. Please continue or let me know if there's an issue.",
    "isDefault": true
  },
  {
    "id": "retry",
    "name": "Retry last prompt",
    "prompt": "The previous prompt didn't receive a response. Please try again.",
    "isDefault": false
  }
]
```

**Template variables:**
- `{{timeoutMinutes}}` — the configured timeout value
- `{{waitingMinutes}}` — actual elapsed time since prompt was sent
- `{{originalPrompt}}` — the text of the unanswered prompt (truncated to 200 chars)

**Management UI locations:**
- **Context & Settings Popup (🔧)** — Reminder section (see §3.1): select active template, set timeout, enable/disable, CRUD buttons for template management
- **Queue Editor** — Each queued item shows its reminder config (template + timeout), editable inline
- **Timed Requests Editor** — Each timed entry has per-entry reminder override (template + timeout)

#### Data Model

```typescript
interface ReminderTemplate {
  id: string;
  name: string;
  prompt: string;     // Template text with {{variables}}
  isDefault: boolean; // Only one can be default
}

interface ReminderConfig {
  enabled: boolean;                // Global enable/disable
  defaultTemplateId: string;       // Which template to use by default
  defaultTimeoutMinutes: number;   // Default timeout (min: 1, default: 5)
}
```

**Extended `QueuedPrompt` interface** — add reminder tracking fields:
```typescript
interface QueuedPrompt {
  // ... existing fields from §3.2 ...
  type: 'normal' | 'timed' | 'reminder';  // Source of the queued item
  reminderTemplateId?: string;             // Override for this item's reminder
  reminderTimeoutMinutes?: number;         // Override for this item's timeout
  sentAt?: string;                         // When actually sent (for timeout tracking)
  reminderQueued?: boolean;                // Whether a reminder has already been queued for this item
}
```

#### Visual Indicators

- In the queue list, reminder items show with a ⏰ icon and distinct styling (e.g., orange border)
- In the panel status bar (if space allows), show a small indicator when a prompt is waiting: "⏳ Waiting 2:30" with countdown
- Reminder items can be manually deleted from the queue like any other item

---

## 4. QUEST TODO Panel

**Purpose:** A dedicated panel for viewing and editing quest todos, providing a richer experience than the chat todo list.

**Location:** New view in the `dartscript-t3-panel` (TOM) container, as a sibling to the existing T3 panel sections, OR as a standalone accordion section. Given its complexity, it should be a **new webview view** registered alongside the existing TOM panel.

**Registration:** Add to `package.json`:
```json
"dartscript-t3-panel": [
  { "id": "dartscript.t3Panel", "name": "TOM", "type": "webview" },
  { "id": "dartscript.questTodoPanel", "name": "QUEST TODO", "type": "webview" }
]
```

### Panel Layout

```
┌──────────────────────────────────────────────────┐
│ Quest: [vscode_extension ▼]  File: [All files ▼] │
│ [📄 Open YAML] [➕ Add Todo]                      │
├────────────────────────┬─────────────────────────┤
│ Todo List              │ Todo Detail              │
│                        │                          │
│ ⬜ T001: Setup bridge  │ ID: T001                 │
│ 🔄 T002: Fix popup  ← │ Title: [Setup bridge   ] │
│ ✅ T003: Add tests     │ Status: [not-started ▼]  │
│ ⬜ T004: Doc update    │ Priority: [medium ▼]     │
│   ↳ [➡️ Move to quest] │ Description:             │
│                        │ [                      ] │
│                        │ Tags: [bridge, deploy  ] │
│                        │ Dependencies: [T001    ] │
│                        │ Notes:                   │
│                        │ [                      ] │
│                        │ [💾 Save] [↩️ Revert]     │
└────────────────────────┴─────────────────────────┘
```

### Features

**Top bar:**
- **Quest dropdown** — Same as COPILOT panel (synced via `ChatVariablesStore`)
- **File dropdown** — List of todo files in quest folder:
  - "All files" — read-only aggregate view (no add button)
  - `todos.{quest-id}.yaml` — persistent file
  - Session files (`{timestamp}_{window}.todos.yaml`)
- **📄 Open YAML** — Opens the selected YAML file directly in the text editor
- **➕ Add Todo** — Only visible when a specific file is selected (not "All files"). Creates a new todo with auto-generated ID and opens the detail panel

**Todo list (left pane):**
- Scrollable list of todo items showing: status icon, ID, title (truncated)
- Click to select → shows detail in right pane
- Color-coded by status:
  - Not-started: default
  - In-progress: blue highlight
  - Blocked: orange
  - Completed: grey/strikethrough
  - Cancelled: grey/italic
- For session file items in "All files" view: show a **➡️ Move to quest** icon button that moves the todo from the session file to the persistent `todos.{quest-id}.yaml`
- Source file indicator (small label) when viewing "All files"

**Todo detail (right pane):**
- Form fields matching the todo schema:
  - `id` — text input (read-only for existing, editable for new)
  - `title` — text input
  - `status` — dropdown (not-started, in-progress, blocked, completed, cancelled)
  - `priority` — dropdown (low, medium, high, critical)
  - `description` — textarea
  - `tags` — tag input (chips with x to remove, text input to add)
  - `dependencies` — multi-select from other todo IDs
  - `scope.project`, `scope.module`, `scope.area` — text inputs
  - `scope.files` — list of file paths
  - `references` — list of `{path/url, description, lines}`
  - `notes` — textarea
  - `created`, `updated` — read-only date display
  - `completed_date`, `completed_by` — shown when status is completed
- **💾 Save** button — writes changes using YAML CST/AST preservation
- **↩️ Revert** button — discards unsaved changes
- **🗑️ Delete** button — removes the todo (with confirmation)

**YAML handling:** Same as §1.3 — all YAML operations use the `yaml` package's document API to preserve formatting and comments. On save:
1. `parseDocument()` the source file
2. Navigate to the todo item in the document tree
3. Update changed fields
4. `doc.toString()` to write back

---

## 5. Workspace Notes Rework

**Current state:** `WorkspaceNotepadProvider` hardcodes `notes.md` in the first workspace folder root.

**Enhancement:**

1. **Workspace detection:** Use `vscode.workspace.workspaceFile` to detect if an actual `.code-workspace` file is open
   - If yes → show the notes panel with the workspace name
   - If no → show "No workspace is open" message with a "Open Workspace..." button

2. **Configurable file location:** The notes file path is stored in VS Code's workspace storage (`context.workspaceState.get('workspaceNotesPath')`)
   - First use: prompt user to choose/create the file (file picker dialog)
   - Subsequent: auto-load from stored path
   - "Change file..." action in the panel header to pick a different file

3. **Create notes file:** If the workspace is open but no notes file is configured:
   - Show "No workspace notes file configured" with a "Create Notes File" button
   - On click: file save dialog, defaulting to `{workspaceRoot}/notes.md`
   - Creates the file with a header: `# Workspace Notes — {workspaceName}`
   - Stores the chosen path in workspace storage

4. **Workspace name display:** Show the workspace name (from the `.code-workspace` filename, without extension) in the panel header: "WORKSPACE NOTES — Tom Agent Container"

---

## 6. Attachment Upload for Issues/Tests

**Current state:** The Issues and Tests panels (inside T3 Panel) display issue details but have no attachment support.

**Enhancement:** Add attachment upload and display to the issue/test detail view.

**UI Elements per issue/test detail:**

1. **Attachments section** — Below the existing detail fields
   - Header: "Attachments (N)" with a 📎 upload button
   - List of attached files, each showing:
     - File icon (based on extension)
     - Filename
     - Size
     - ❌ Delete button (with confirmation)
     - Click to open/preview

2. **Upload button (📎):**
   - Opens VS Code's file picker dialog (`vscode.window.showOpenDialog` with `canSelectMany: true`)
   - Uploads selected files to the issue provider (GitHub API for GitHub issues)
   - Shows upload progress indicator
   - After upload, refreshes the attachment list

3. **Drag & drop:** Accept file drops onto the attachments section

**GitHub implementation:** Uses GitHub's issue comment API to attach files:
- Upload image/file via GitHub's content API or as issue comment with attachment
- For non-image files: create a comment with file content or link
- Deletion: edit the comment to remove the attachment reference

**For local/offline mode:** Store attachments in `_ai/quests/{quest-id}/attachments/{issue-id}/` and track in the issue's YAML metadata.

---

## 7. Chat Variables Editor

**Purpose:** A custom editor panel that displays all current chat variables, allows editing, and shows a change log.

**Access:** New command `dartscript.openChatVariablesEditor` + button in the COPILOT panel context section header.

### Editor Layout

```
┌─────────────────────────────────────────────────┐
│ Chat Variables                        [+ Add]   │
├──────────────┬──────────────────────────────────┤
│ Variable     │ Value                            │
├──────────────┼──────────────────────────────────┤
│ quest        │ [vscode_extension            ]   │
│ role         │ [developer                   ]   │
│ activeProj.  │ [tom_vscode_extension, yaml..]   │
│ todo         │ [T002: Fix popup             ]   │
│ custom.note  │ [Working on queue system     ]   │
│ custom.ctx   │ [Need to test on Linux       ] 🗑│
├──────────────┴──────────────────────────────────┤
│ Change Log (last 100)                           │
│                                                 │
│ 08:45:23 quest = "vscode_extension" (user)      │
│ 08:44:01 role = "developer" (user)              │
│ 08:42:15 todo = "T002" (copilot)                │
│ 08:40:00 activeProjects = [...] (localLlm)      │
│ 08:38:22 custom.note = "Working..." (user)      │
│ ...                                             │
└─────────────────────────────────────────────────┘
```

### Features

**Variable table:**
- All registered chat variables displayed in a two-column editable table
- Built-in variables (quest, role, activeProjects, todo) have type-appropriate editors:
  - Quest: dropdown (same as panel)
  - Role: dropdown (same as panel)
  - Active projects: multi-select
  - Todo: dropdown (same as panel)
- Custom variables: free-text input
- Each custom variable has a 🗑️ delete button
- Built-in variables cannot be deleted

**Add variable (+):**
- Opens inline row with key input + value input
- Key must be unique, lowercase, alphanumeric + dots/underscores
- Added as a custom variable accessible via `${dartscript.chat.custom.<key>}`

**Change log:**
- Scrollable log at the bottom of the editor
- Each entry: `{HH:MM:SS} {variableName} = "{newValue}" ({source})`
- Source is one of: `user`, `localLlm`, `copilot`, `tomAiChat`
- Stored in `ChatVariablesStore` (in-memory ring buffer, max 100 entries)
- Persisted to workspace state for session continuity

---

## Implementation Priority & Dependencies

### Phase 1 — Foundation (Required first)
1. **ChatVariablesStore** singleton — all other features depend on this
2. **Chat Variables registration** (`#quest`, `#role`, etc.) — NEW feature (§2)
3. **COPILOT Panel compact layout & context popup** (§3.1) — wrench icon, icons, popup
4. **`_ai/roles/` folder structure** — create initial structure

### Phase 2 — Tools & Todos
5. **LLM Tools** (notify, workspace info, quest todo management, window session todos)
6. **QUEST TODO Panel**
7. **Chat Variables Editor** (§7) — NEW panel

### Phase 3 — Queue & Automation
8. **Prompt Queue System** (toggle, editor, answer processing)
9. **Timed/Repeat Requests** (editor, timer engine — always queues, never sends directly)
10. **"Are You Alive?" Reminder System** (§3.4) — templates, timeout tracking, auto-queue

### Phase 4 — Polish
11. **Workspace Notes Rework**
12. **Attachment Upload for Issues/Tests**

### Key Dependencies
- Queue system depends on: ChatVariablesStore, answer file watcher (already exists)
- Timed requests depends on: Queue system (fires into queue)
- Reminder system depends on: Queue system + Timed Request storage for templates
- QUEST TODO panel depends on: ChatVariablesStore, YAML CST handling
- All LLM tools depend on: ChatVariablesStore
- Window session todos: standalone (only depends on workspace state API)
- Context popup depends on: ChatVariablesStore, quest folder scanner

---

## Technical Notes

### YAML CST/AST Handling
All YAML file operations MUST use the `yaml` npm package's document-level API:
```typescript
import { parseDocument } from 'yaml';
const doc = parseDocument(yamlContent);
// Navigate and modify via doc.get(), doc.set(), doc.getIn(), doc.setIn()
const output = doc.toString(); // Preserves comments and formatting
```
Never use `yaml.parse()` → `yaml.stringify()` for round-tripping, as this destroys comments and formatting.

### Webview Communication
All new panels use the standard `postMessage` / `onDidReceiveMessage` pattern already established in `UnifiedNotepadViewProvider` and `T3PanelHandler`. Custom editors use `CustomTextEditorProvider` or `CustomReadonlyEditorProvider` as appropriate.

### File Watchers
New file watchers needed:
- `_ai/quests/*/todos.*.yaml` and `_ai/quests/*/*.todos.yaml` — for todo file changes
- `_ai/roles/*/` — for role folder changes
- Queue answer file watcher already exists, needs enhancement for auto-send

### Config File Extensions
The `tom_vscode_extension.json` config will gain new sections:
- `queue` — queue behavior settings (auto-send delay, max queue size)
- `timedRequests` — stored scheduled entries
- `reminderTemplates` — CRUD-managed reminder prompt templates (see §3.4)
- `reminderConfig` — global reminder settings (enabled, default template, default timeout)
- Chat variables are NOT stored in config — they go in VS Code workspace state
- Window session todos are NOT stored in config — they go in VS Code workspace state
