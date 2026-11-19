# TOM AI Workspace Setup

This workspace is not configured for TOM AI. The extension is running in
**minimal mode** — only keyboard shortcuts and basic commands are available.

To enable all features (panels, trail logging, todo management, prompt
templates, etc.), set up a workspace folder from the bundled template, or by
hand.

---

## Setup New Workspace Folder

The extension carries a workspace template in two parts:

- **`root/`** — what a root holds: `.tom/` (`tom_root.yaml`, the configuration,
  the schema of the workspace lists), the root guidelines
  (`_agent_guidelines/`, with the shared `workspace_agents.md` every
  workspace folder's `CLAUDE.md` imports), `CLAUDE.md` (`@AGENTS.md` and the
  shared file), an `AGENTS.md` for the root's own rules, and the generally
  useful `_ai/` folders (roles, role types, processes, schemas, prompts, the
  format version) with the starting quest `tomai_introduction`.
- **`workspace/`** — what a workspace folder holds: an empty `.tom/`, an
  `AGENTS.md` for its own rules, a `CLAUDE.md` importing the root's shared
  `workspace_agents.md` and its `AGENTS.md`, and its guidelines
  (`_agent_guidelines/`: Dart, cloud and D4rt guidelines and the others of
  a Dart workspace, its index linking the root's).

The workspace part's `CLAUDE.md` names the root by the token `{{root}}`
(`@{{root}}/_agent_guidelines/workspace_agents.md`), as does its guidelines
index's link to the root's index: setup writes the path from the new
workspace folder to its root there. The schemas of the files the extension
writes are not in the template; the extension writes them into the root's
`.tom` when it starts.

**@T: Setup New Workspace Folder** asks first which of three setups to make:

- **A new root with a first workspace folder.** The root part goes into the
  folder you pick, the workspace part into a subfolder whose name you give
  (default `workspace`). The workspace folder's `_ai` is a link to the root's
  (a relative symbolic link; on Windows a junction when a symbolic link may
  not be made). The introduction quest's
  `_ai/quests/tomai_introduction/tomai_introduction.code-workspace` is written
  when it is missing; **Open the introduction quest** opens it through the
  workspace folder's `_ai`, so its window's folder is the workspace folder.
- **A workspace folder in an existing root.** The folder you pick must lie
  inside a root: a folder above it with `.tom/tom_root.yaml` (and an `_ai`);
  otherwise the setup says so and writes nothing. The workspace part goes
  into the folder, and its `_ai` is linked to the root's.
- **A standalone workspace folder.** Both parts go into the one folder you
  pick: the workspace part's `CLAUDE.md` and `AGENTS.md`, no `tom_root.yaml`,
  its own `_ai`, so `CLAUDE.md` imports `./_agent_guidelines/workspace_agents.md`.

In each, the workspace part's root token is written as the path from the
workspace folder to its root (`..` for the first workspace folder of a new
root). Every `.code-workspace` the extension writes — the introduction
quest's and each new quest's (**Create new quest**) — sets
`"chat.useAgentsMdFile": true`, so Copilot reads `AGENTS.md`.

The command is in the command palette, on the TOM AI panels of a folder
without `.tom/` (**Setup new workspace folder**) and at the top of the
Status Page.

1. **Choose the setup.**
2. **Pick the folder.** The dialog can also create a new one. For a new root,
   give the first workspace folder's name.
3. **A folder that is not empty** shows what is in it; **Set up anyway** goes
   on, **Cancel** stops.
4. **The template is unpacked.** For each file that already exists (named by
   its path from the folder you picked) you choose **Overwrite**, **Skip**,
   **Overwrite All** or **Skip All** (for every later file that exists, in
   both parts), or **Cancel** (stops; the files written so far stay). At the
   end you see how many files were written, overwritten and skipped;
   **Show the file list** lists them.
5. **Adapt the configuration** (a new root or a standalone folder).
   `.tom/tom_vscode_extension.json` carries the settings and paths of the
   machine the extension was built on: the bridge profiles' paths
   (`bridge.profiles`), the Dart binaries (`bridge.executables`), the Local
   LLM endpoint and the environment variable holding your Anthropic API key.
   **Open the configuration** opens it.
6. **Open it.** **Open the introduction quest** (when the template has it) or
   **Open the folder** (the workspace folder) opens a new window; **Stay
   here** keeps this one.

## Your First Quest

A quest is a larger piece of work with its own folder `_ai/quests/<id>/`;
you work on it in its workspace `_ai/quests/<id>/<id>.code-workspace`. While
no quest is open, the panels say so and offer **Create new quest**
(**@T: Create New Quest**): it asks the quest's id and name, creates its files
and one todo that defines the quest with you, and offers to open the quest's
workspace. Run that todo there, in the prompt queue or the chat.

The first time a quest's window opens on a machine, its overview opens in
the MD Browser; later it is in **@WS › Documentation › Quest Overview**.

---

## Setting Up by Hand

### 1. Create the `.tom/` Configuration Folder

Create a `.tom/` folder in your workspace folder (the first folder of the window; see [the workspace layout](#where-the-extension-looks-the-workspace-layout)):

```bash
mkdir -p .tom
```

### 2. Create the Main Configuration File

Create `.tom/tom_vscode_extension.json` with at minimum:

```json
{
  "version": 1,
  "templates": {},
  "defaultTemplates": {}
}
```

### 3. Create Required Workspace Folders

```bash
mkdir -p _ai/trail
mkdir -p _ai/quests
mkdir -p _ai/prompt
mkdir -p _ai/roles
```

### 4. Reload the Window

After creating the configuration, reload VS Code:

- Press `Cmd+Shift+P` (macOS) or `Ctrl+Shift+P` (Windows/Linux)
- Type "Reload Window" and select it

---

## Folder Structure Overview

| Folder | Purpose |
| --- | --- |
| `.tom/` | Extension configuration files |
| `_ai/trail/` | Copilot prompt/answer trail logs |
| `_ai/quests/` | Quest folders (structured project work) |
| `_ai/prompt/` | Reusable prompt templates |
| `_ai/roles/` | AI role definitions |

## Where the Extension Looks: the Workspace Layout

A window works in its **workspace folder**: the first folder of the
`.code-workspace` file (a folder window: that folder). The extension works in
the first folder of the `.code-workspace` file; other folders are only extra
root folders, and the file open in the editor changes nothing.

Above it, the extension looks for the **root** of the Tom workspace: the
nearest folder (the workspace folder included) holding `.tom/tom_root.yaml`.
Without one, the workspace folder is its own root (a standalone workspace).

| Place | Where it is |
| --- | --- |
| `_ai/` | the workspace folder's `_ai` when it exists (a symlink counts), else the root's; neither: the status page reports it under Configuration Errors |
| `.tom/` | read at the root and in the workspace folder; `tom_vscode_extension.json` is merged deep (objects key by key, arrays and scalars replace; the workspace folder's wins), changes are written to the root's file, only the changed keys |
| guidelines | `_agent_guidelines/` at the root and in the workspace folder |

`.tom/tom_root.yaml` may rename the default folders for its root, and
`<workspace folder>/.tom/tom_workspace.yaml` for one workspace folder:

```yaml
version: 1
defaults:
  ai: _ai
  guidelines: _agent_guidelines
  config: .tom
```

The extension is in minimal mode (the setup screen) only when neither the root
nor the workspace folder has a `.tom/` and `tomAi.configPath` points nowhere.

**Overrides** — settings in a quest's `.code-workspace` file, for special
cases; paths are absolute or relative to the workspace folder:

| Setting | Changes |
| --- | --- |
| `tomAi.layout.root` | the root (replaces the walk up) |
| `tomAi.layout.aiFolder` | the `_ai` folder (`tomAi.aiFolder`, a folder name under the workspace folder, is its deprecated alias; `tomAi.layout.aiFolder` wins) |
| `tomAi.layout.configFolder` | the workspace folder's configuration folder |
| `tomAi.layout.guidelinesFolder` | the workspace folder's guidelines folder |
| `tomAi.configPath` | the one configuration file, for a layout without a root `.tom` |

In configuration values, `${workspaceFolder}` is the workspace folder and
`${tomRoot}` the root.

When a window opens a quest, it records the quest's workspace folder (relative
to the root, `.` standalone) as `workspaceFolder` in the quest's
`extension_config.<quest>.yaml`. A workspace's quests are its list in
`_ai/workspaces/<workspace>.yaml`, else the quests recorded for its workspace
folder, else every quest: the prompt variable `${workspaceQuests}` names them,
and `tomAi_getWorkspaceInfo` with `include: ["layout", "workspaceFolders",
"quests"]` answers the layout, the root's workspace folders (found by a scan:
folders with an `_ai` entry and a `.tom` or CLAUDE.md) and each quest's recorded
folder.

---

## Optional Configuration

### Quest Workspace

To use quest-specific features, create a quest folder:

```bash
mkdir -p _ai/quests/my_quest
```

And optionally a quest `.code-workspace` file pointing to your project.

### Workspace Todos

Create a workspace todo file:

```yaml
# workspace.todo.yaml
todos: []
```

### Chat Variables

Chat variables allow dynamic prompt expansion. Configure them in
`.tom/tom_vscode_extension.json` under the `chatVariables` key.

---

## Need Help?

- Check the extension's quick reference: `@T: Extension Status Page` command
- Review `_agent_guidelines/` for workspace conventions
- Consult [quick_reference.md](quick_reference.md) in the extension folder
