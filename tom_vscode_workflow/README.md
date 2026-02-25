# TOM Tracker

TODO tracking and project management panels for Tom workspace.

## Overview

TOM Tracker is a VS Code extension for TODO-oriented workflows. It reuses existing patterns from the Tom VS Code extension ecosystem, including accordion webview sections and YAML graph integration.

## Features

- **@TODO Bottom Panel** — Accordion UI with `FILE1` and `FILE2` editors
- **Todo File Editing** — Edits `todo1.md` and `todo2.md` in workspace root
- **Debug Logging** — Centralized debug output to "Tom Tracker Debug Log" panel
- **Regular Logging** — Centralized log output to "Tom Tracker Log" panel
- **Error Capture** — Robust error handling across UI components and event handlers
- **YAML Graph Reuse** — Uses `yaml-graph-core` and `yaml-graph-vscode`

## Development

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Watch mode
npm run watch
```

## Dependency

This extension requires the DartScript extension (`tom.dartscript-vscode`) to be installed.

## Project Structure

```
src/
  extension.ts          # Extension entry point
  infrastructure/
    logger.ts           # Centralized logging (output panel, console, file)
    errorCapture.ts     # Error capture and reporting patterns
  handlers/
    flowPanel-handler.ts # @TODO panel provider and todo file editor bridge
  components/
    accordionPanel.ts   # Reused accordion component
```
