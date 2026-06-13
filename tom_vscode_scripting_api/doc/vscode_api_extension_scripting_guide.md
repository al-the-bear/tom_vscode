# Extension Scripting Guide

This guide covers the part of `tom_vscode_scripting_api` that scripts the **Tom
AI extension's own features** — not VS Code itself (see the
[VS Code scripting guide](vscode_api_vscode_scripting_guide.md)) and not the
Anthropic Agent SDK (see the [Agent SDK guide](vscode_api_anthropic_agent_sdk_guide.md)),
but the subsystems the extension adds: local LLM prompts, bot conversations,
todos, the prompt queue, timed requests, documents, workspace metadata, tools,
and send-to-chat.

These nine APIs are **static-method classes**. Each one needs its adapter set
once before use:

```dart
import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

final adapter = await connectToWorkspace('tom_agent_container');

TomTodoApi.setAdapter(adapter);
TomQueueApi.setAdapter(adapter);
AiPromptApi.setAdapter(adapter);
// …set the adapter on each API you use
```

> Unlike the VS Code-namespace classes (which read the `VSCode` singleton after
> `VSCode.initialize`), these classes do **not** use the singleton — call
> `<Class>.setAdapter(adapter)` on each. Forgetting throws a `StateError`.

Each API maps to a family of bridge methods named `<area>.<op>Vce`.

---

## `AiPromptApi` — local LLM prompt processing

Run a prompt through the extension's configured local LLM, and manage the
profiles and model configurations. Bridge methods: `localLlm.*Vce`.

```dart
AiPromptApi.setAdapter(adapter);

final result = await AiPromptApi.process(prompt: 'Summarize this changelog');
print(result.text);          // AiPromptResult
print(result.tokenStats);    // AiTokenStats

final profiles = await AiPromptApi.getProfiles();
await AiPromptApi.updateProfile(/* AiPromptProfile */);
await AiPromptApi.removeProfile('profileId');

final models = await AiPromptApi.getModels();   // AiModelsResult
await AiPromptApi.updateModel(/* AiModelConfig */);
await AiPromptApi.removeModel('modelId');
```

Models: `AiPromptResult`, `AiTokenStats`, `AiPromptProfile`, `AiModelConfig`,
`AiModelsResult`.

---

## `AiConversationApi` — bot conversations

Drive the extension's multi-turn bot-conversation engine. Bridge methods:
`botConversation.*Vce`.

```dart
AiConversationApi.setAdapter(adapter);

await AiConversationApi.start(/* config */);
final status = await AiConversationApi.status();
await AiConversationApi.addInfo('Extra context for the bot');
await AiConversationApi.continueConversation();
final log = await AiConversationApi.getLog();
await AiConversationApi.halt();
await AiConversationApi.stop();

// One-shot:
final reply = await AiConversationApi.singleTurn(/* … */);
```

Other members: `getConfig`, `getProfiles`. Enums: `ConversationMode`,
`HistoryMode`.

> The AI Conversation subsystem is **not queue-compatible** — it is its own
> conversational loop, distinct from the prompt queue below.

---

## `TomTodoApi` — todos (quest / workspace / session)

CRUD over the three todo scopes plus a combined view. Bridge methods:
`todo.*Vce`.

```dart
TomTodoApi.setAdapter(adapter);

final questTodos = await TomTodoApi.listQuestTodos('vscode_extension');
final all        = await TomTodoApi.listAllTodos();
// quest / workspace / session create / update / delete / move operations
```

Models: `TodoItem`, enums `TodoStatus`, `TodoPriority`.

---

## `TomQueueApi` — the prompt queue

Full control of the multi-transport prompt queue: list, mutate, reorder, manage
follow-ups, and run/pause the queue. Bridge methods: `queue.*Vce`.

```dart
TomQueueApi.setAdapter(adapter);

final items = await TomQueueApi.list();              // List<QueuedPrompt>
final item  = await TomQueueApi.get(id);
await TomQueueApi.add(/* input */);
await TomQueueApi.remove(id);

await TomQueueApi.updateStatus(id, status);
await TomQueueApi.updateText(id, 'new text');
await TomQueueApi.updateReminder(id, /* … */);

// Reordering
await TomQueueApi.moveTo(id, index);
await TomQueueApi.moveUp(id);
await TomQueueApi.moveDown(id);

// Follow-ups
await TomQueueApi.addFollowUp(id, /* … */);
await TomQueueApi.updateFollowUp(/* … */);
await TomQueueApi.removeFollowUp(/* … */);

// Run control
await TomQueueApi.sendNext();
await TomQueueApi.pause();
await TomQueueApi.resume();
final paused = await TomQueueApi.isPaused();

// Bulk
await TomQueueApi.clearPending();
await TomQueueApi.clearSent();
```

Models: `QueuedPrompt`, `QueuedFollowUp`, plus input types.

---

## `TomTimedApi` — timed / scheduled requests

Create and manage scheduled prompts, and control the timer engine. Bridge
methods: `timed.*Vce`.

```dart
TomTimedApi.setAdapter(adapter);

final reqs = await TomTimedApi.list();          // List<TimedRequest>
final req  = await TomTimedApi.get(id);
await TomTimedApi.create(/* … */);
await TomTimedApi.update(/* … */);
await TomTimedApi.delete(id);
await TomTimedApi.enable(id);
await TomTimedApi.disable(id);
// timer-engine state operations
```

Models: `TimedRequest`, `ScheduledTime`, plus scheduling enums.

---

## `TomDocumentApi` — documents

A generic document store plus typed accessors for the well-known Tom document
folders (prompts, answers, trail, guidelines, notes, quest docs). Bridge
methods: `doc.*Vce`.

```dart
TomDocumentApi.setAdapter(adapter);

// Generic
final docs = await TomDocumentApi.list(DocumentFolder.guidelines);
final text = await TomDocumentApi.read(folder, 'name.md');
await TomDocumentApi.write(folder, 'name.md', 'content');
await TomDocumentApi.delete(folder, 'name.md');
final there = await TomDocumentApi.exists(folder, 'name.md');

// Typed accessors exist for prompts / answers / trail / guidelines / notes /
// quest docs.
```

Models: `DocumentFolder` enum, `DocumentInfo`, `TrailEntry`, `GuidelineInfo`.

---

## `TomWorkspaceApi` — workspace metadata

Workspace info, projects, quests (including the active quest), chat variables,
and config. Bridge methods: `workspace.*Vce`.

```dart
TomWorkspaceApi.setAdapter(adapter);

final info     = await TomWorkspaceApi.getInfo();        // WorkspaceInfo
final root     = await TomWorkspaceApi.getRootPath();
final windowId = await TomWorkspaceApi.getWindowId();

final projects = await TomWorkspaceApi.listProjects();   // List<ProjectInfo>

final quests   = await TomWorkspaceApi.listQuests();     // List<QuestInfo>
final active    = await TomWorkspaceApi.getActiveQuest();
await TomWorkspaceApi.setActiveQuest('vscode_extension');

// Chat variables (shared key/value channel with the chat panels)
final v = await TomWorkspaceApi.readChatVariable('foo');
await TomWorkspaceApi.writeChatVariable('foo', 'bar');
```

Models: `WorkspaceInfo`, `ProjectInfo`, `QuestInfo`, `ChatVariable`.

> `findBridgePortForWorkspace` / `connectToWorkspace` (the discovery helpers)
> use this API's `workspace.getInfoVce` round-trip to identify which window is
> which.

---

## `TomToolsApi` — the MCP-style tool surface

Invoke the extension's registered tools and fetch the tools JSON for prompt
injection. Bridge methods: `tools.invokeVce`, `tools.getJsonVce`.

```dart
TomToolsApi.setAdapter(adapter);

final result    = await TomToolsApi.invokeTool('tomAi_readFile', {'path': 'README.md'});
final toolsJson = await TomToolsApi.getToolsJson();          // for prompt injection
final names     = await TomToolsApi.listAllowedToolNames();
```

Model: `ToolDefinitionJson`.

> Tool availability is **profile-gated**: when the active target is Copilot, no
> tools are exposed. `listAllowedToolNames` reflects the current gating.

---

## `TomChatApi` — send to chat

Send a prompt to the active chat target (Anthropic or Copilot) and get the
reply. Bridge method: `sendToChatVce`.

```dart
TomChatApi.setAdapter(adapter);

final reply = await TomChatApi.sendToChat('Summarize the open file');
print(reply.text);     // SendToChatResult
```

`sendToChat` is **target-aware**: it dispatches to whichever chat target is
active. A second concurrent Anthropic send is rejected (the Anthropic transport
processes one at a time).

Model: `SendToChatResult`.

---

## Choosing the right API

| You want to… | Use |
| ------------ | --- |
| Run a quick local-LLM prompt | `AiPromptApi.process` |
| Run a multi-turn bot loop | `AiConversationApi` |
| Send a prompt to the live chat panel | `TomChatApi.sendToChat` |
| Drive the prompt queue | `TomQueueApi` |
| Schedule a prompt for later | `TomTimedApi` |
| Read/write quest or session todos | `TomTodoApi` |
| Read/write Tom documents (prompts, trail, notes…) | `TomDocumentApi` |
| Discover projects / quests / set the active quest | `TomWorkspaceApi` |
| Invoke a Tom tool or fetch tools JSON | `TomToolsApi` |
| Run a full agentic loop with tools & permissions | the [Agent SDK](vscode_api_anthropic_agent_sdk_guide.md) |
| Drive the editor (files, commands, diagnostics) | the [VS Code APIs](vscode_api_vscode_scripting_guide.md) |

---

## End-to-end example

```dart
import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

Future<void> main() async {
  final adapter = await connectToWorkspace('tom_agent_container');

  TomWorkspaceApi.setAdapter(adapter);
  TomTodoApi.setAdapter(adapter);
  TomChatApi.setAdapter(adapter);

  await TomWorkspaceApi.setActiveQuest('vscode_extension');
  final todos = await TomTodoApi.listQuestTodos('vscode_extension');

  final summary = await TomChatApi.sendToChat(
    'I have ${todos.length} open todos. Suggest which to tackle first.',
  );
  print(summary.text);
}
```

This completes the four-part VS Code Scripting API user guide. Start from
[vscode_api_intro.md](vscode_api_intro.md) for the overview and connection
model.
