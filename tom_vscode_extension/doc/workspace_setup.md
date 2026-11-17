# TOM AI Workspace Setup

This workspace is not configured for TOM AI. The extension is running in
**minimal mode** — only keyboard shortcuts and basic commands are available.

To enable all features (panels, trail logging, todo management, prompt
templates, etc.), set up a workspace folder from the bundled template, or by
hand.

---

## Setup New Workspace Folder

The extension carries a workspace template: the configuration, the guidelines
(`_copilot_guidelines/`, `CLAUDE.md`, `.github/copilot-instructions.md`) and
the generally useful `_ai/` folders (roles, processes, schemas, prompts).
**@T: Setup New Workspace Folder** unpacks it into a folder. It is in the
command palette, on the TOM AI panels of a folder without `.tom/` (**Setup new
workspace folder**) and at the top of the Status Page.

1. **Pick the folder.** The dialog can also create a new one.
2. **A folder that is not empty** shows what is in it; **Set up anyway** goes
   on, **Cancel** stops.
3. **The template is unpacked.** For each file that already exists you choose
   **Overwrite**, **Skip**, **Overwrite All** or **Skip All** (for every later
   file that exists), or **Cancel** (stops; the files written so far stay). At
   the end you see how many files were written, overwritten and skipped;
   **Show the file list** lists them.
4. **Adapt the configuration.** `.tom/tom_vscode_extension.json` carries the
   settings and paths of the machine the extension was built on: the bridge
   profiles' paths (`bridge.profiles`), the Dart binaries
   (`bridge.executables`), the Local LLM endpoint and the environment variable
   holding your Anthropic API key. **Open the configuration** opens it.
5. **Open it.** **Open the introduction quest** (when the template has it) or
   **Open the folder** opens a new window; **Stay here** keeps this one.

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
| `.tom/` | read at the root and in the workspace folder; changes are written to the root's `tom_vscode_extension.json` |
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
- Review `_copilot_guidelines/` for workspace conventions
- Consult [quick_reference.md](quick_reference.md) in the extension folder
