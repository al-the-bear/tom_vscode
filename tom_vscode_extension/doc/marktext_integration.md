a) timed requests "Add New" doesn't work

b) Prompt queue: no visible effect of the "Auto-Send" button when I click.

c) Prompt queue: no visible effect of the "Variable button" button when I click, this either open a variables view/editor section here or a separate editor for this

d) Prompt queue: no visible effect of the "Context & Setting" button when I click.

e) Placeholder help: are all of the placeholders really available? Please verify and add what is missing. 

f) What are the "mustache" placeholders?

g) for persistent of window specific data we use the current workspace file name (if I opened "vscode_extension.code-workspace" this is "vscode_extension"), so all window specific files can be stored in their foldes, with this prefix, like vscode_extension.queue.yaml. We should store on every modification, to ensure nothing gets lost.

g) the prompt queue and the timed requests must be persistent across window reloads and vs code restarts. Where are these stored? Please create a json-schema for the yaml files to store these. The location must be configurable, the extension *.queue.yaml and *.timed.yaml, the extension must be bound to the new editors, so I can edit such files, even if they are not the ones currently in use. The editor should include a "use this file" button to change the configuration file.

h) Add "show file" icon to the two views, so I can open the yaml files.

i) The COPILOT, TOM AI CHAT, AI CONVERSION and LOCAL LLM panel state must survive window reloads, also store in yaml files with their own schema for each. Add a reload button to the panel to refresh from the file, but no automatic update. It should only load on window reload or vs code restart. 

j) In the "Context & Settings" editor the "Select..." button for projects doesn't show any projects. this should use the reusable project scanning logic you just created. Where is this stored? Create a schema for this information and store it in *.context.yaml" files. Link the *.content.yaml extension to this editor

k) The activeProject edit field in the chat variable editor should have the same "Select..." option. Let's store the chat variable in a special *.chatvars.yaml file, too and link the editor to the *.chatvars.yaml extension.

l) Add a dropdown to the guidelines panel, which allows to switch between guidelines groups, the groups are:

- global: in _copilot_guidelines in workspace root
- projects: in _copilot_guidelines in the project folders. When I choose this another dropdown to pick the project appear before showing me files.
- roles: in _ai/roles
- copilot-instructions: the file in .github

m) the "Move to workspace" button should show always. the workspace.todo.yaml must be created if it doesn't exist yet.# MarkText Integration for VS Code

**Date:** 2026-02-18  
**Workspace:** c2dart

## Overview

This document describes the configuration added to integrate MarkText as an external Markdown viewer in VS Code.

## Changes Made

### 1. VS Code Task (`.vscode/tasks.json`)

Created a task that launches MarkText with the current file:

```json
{
    "version": "2.0.0",
    "tasks": [
        {
            "label": "Open with MarkText",
            "type": "shell",
            "command": "marktext",
            "args": ["${file}"],
            "presentation": {
                "reveal": "never",
                "panel": "shared"
            },
            "problemMatcher": []
        }
    ]
}
```

**Usage:** `Ctrl+Shift+P` → "Run Task" → "Open with MarkText"

### 2. Keyboard Shortcut (`~/.config/Code/User/keybindings.json`)

Added a keyboard shortcut to quickly open Markdown files in MarkText:

```json
[
    {
        "key": "ctrl+shift+m",
        "command": "workbench.action.tasks.runTask",
        "args": "Open with MarkText",
        "when": "editorLangId == markdown"
    }
]
```

**Usage:** When editing a `.md` file, press `Ctrl+Shift+M`

### 3. Explorer Context Menu (`.vscode/settings.json`)

Configured the "Open in External App" extension to add MarkText to the Explorer context menu:

```json
{
    "openInExternalApp.openMapper": [
        {
            "extensionName": "md",
            "apps": [
                {
                    "title": "MarkText",
                    "openCommand": "/usr/bin/marktext",
                    "args": ["${file}"],
                    "isElectronApp": true
                }
            ]
        }
    ]
}
```

**Note:** The `args` and `isElectronApp` fields are required for MarkText to work correctly.

## Required Extension

To enable the **"Open with..."** option in the Explorer context menu, you must install the **"Open in External App"** extension:

1. Press `Ctrl+Shift+X` to open Extensions
2. Search for: `YuTengjing.open-in-external-app`
3. Click **Install**

After installation:
- Right-click any `.md` file in Explorer
- Select **"Open in External App"**
- Choose **"MarkText"** from the submenu

## Summary of Access Methods

| Method | How to Use |
|--------|------------|
| **Keyboard Shortcut** | `Ctrl+Shift+M` when editing a `.md` file |
| **Command Palette** | `Ctrl+Shift+P` → "Run Task" → "Open with MarkText" |
| **Explorer Context Menu** | Right-click `.md` file → "Open in External App" → "MarkText" (requires extension) |

## Files Modified

| File | Purpose |
|------|---------|
| `.vscode/tasks.json` | Task definition for MarkText |
| `.vscode/settings.json` | External app mapping for .md files |
| `~/.config/Code/User/keybindings.json` | Global keyboard shortcut |

## MarkText Location

```
/usr/bin/marktext
```
