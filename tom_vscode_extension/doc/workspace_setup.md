# TOM AI Workspace Setup

This workspace is not configured for TOM AI. The extension is running in **minimal mode** — only keyboard shortcuts and basic commands are available.

To enable all features (panels, trail logging, todo management, prompt templates, etc.), follow the steps below.

---

## Quick Setup

### 1. Create the `.tom/` Configuration Folder

Create a `.tom/` folder in your workspace root:

```
mkdir -p .tom
```

### 2. Create the Main Configuration File

Create `.tom/tom_vscode_extension.json` with at minimum:

```yaml
# TOM AI Configuration
version: 1

# Templates for Copilot Chat integration
templates: {}

# Default templates per panel section
defaultTemplates: {}
```

### 3. Create Required Workspace Folders

```
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
|--------|---------|
| `.tom/` | Extension configuration files |
| `_ai/trail/` | Copilot prompt/answer trail logs |
| `_ai/quests/` | Quest folders (structured project work) |
| `_ai/prompt/` | Reusable prompt templates |
| `_ai/roles/` | AI role definitions |

---

## Optional Configuration

### Quest Workspace

To use quest-specific features, create a quest folder:

```
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

Chat variables allow dynamic prompt expansion. Configure them in `.tom/tom_vscode_extension.json` under the `chatVariables` key.

---

## Need Help?

- Check the extension's quick reference: `DS: Status Page` command
- Review `_copilot_guidelines/` for workspace conventions
- Consult `doc/quick_reference.md` in the extension folder
