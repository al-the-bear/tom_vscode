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

---

## Setting Up by Hand

### 1. Create the `.tom/` Configuration Folder

Create a `.tom/` folder in your workspace root:

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
