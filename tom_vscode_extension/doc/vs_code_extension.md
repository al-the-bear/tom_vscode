# VS Code Extension Capabilities

This document provides a comprehensive overview of VS Code extension mechanisms, from simple commands to deep platform integrations.

## Table of Contents

1. [Basic Extension Mechanisms](#1-basic-extension-mechanisms)
2. [UI Contributions](#2-ui-contributions)
3. [Language Features](#3-language-features)
4. [Editor Integrations](#4-editor-integrations)
5. [Advanced Integrations](#5-advanced-integrations)
6. [AI Extension Mechanisms](#6-ai-extension-mechanisms)
7. [Limitations and Alternatives](#7-limitations-and-alternatives)

---

## 1. Basic Extension Mechanisms

### Commands

The fundamental building block. Commands can be invoked via:
- Command Palette (`Ctrl+Shift+P`)
- Keybindings
- Menus
- Other extensions

```json
// package.json
{
  "contributes": {
    "commands": [
      {
        "command": "myext.doSomething",
        "title": "Do Something"
      }
    ]
  }
}
```

```typescript
// extension.ts
vscode.commands.registerCommand('myext.doSomething', () => {
  vscode.window.showInformationMessage('Done!');
});
```

### Configuration

Extensions can define settings that users can customize:

```json
{
  "contributes": {
    "configuration": {
      "title": "My Extension",
      "properties": {
        "myext.enableFeature": {
          "type": "boolean",
          "default": true,
          "description": "Enable the feature"
        }
      }
    }
  }
}
```

### Keybindings

Assign keyboard shortcuts to commands:

```json
{
  "contributes": {
    "keybindings": [
      {
        "command": "myext.doSomething",
        "key": "ctrl+shift+d",
        "when": "editorTextFocus"
      }
    ]
  }
}
```

---

## 2. UI Contributions

### Views (Sidebar)

Create custom views in the sidebar (Explorer, Source Control, etc.):

```json
{
  "contributes": {
    "views": {
      "explorer": [
        {
          "id": "myext.treeView",
          "name": "My Tree View"
        }
      ]
    },
    "viewsContainers": {
      "activitybar": [
        {
          "id": "myext-sidebar",
          "title": "My Extension",
          "icon": "resources/icon.svg"
        }
      ]
    }
  }
}
```

### WebviewView (Panel or Sidebar)

Custom HTML/CSS/JS content in panels or sidebars. **This is how to add custom UI to the bottom panel.**

```json
{
  "contributes": {
    "views": {
      "panel": [
        {
          "type": "webview",
          "id": "myext.notepad",
          "name": "Notepad"
        }
      ]
    }
  }
}
```

```typescript
class NotepadViewProvider implements vscode.WebviewViewProvider {
  resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = `
      <!DOCTYPE html>
      <html>
        <body>
          <textarea id="notes" style="width:100%;height:300px;"></textarea>
        </body>
      </html>
    `;
  }
}

// Registration
vscode.window.registerWebviewViewProvider('myext.notepad', new NotepadViewProvider());
```

**Panel locations:**
- `panel` - Bottom panel (Output, Problems, Terminal area)
- `explorer` - Explorer sidebar
- `scm` - Source Control sidebar
- `debug` - Debug sidebar
- Custom activity bar container

### Menus

Add items to context menus, title bars, and more:

```json
{
  "contributes": {
    "menus": {
      "editor/context": [
        {
          "command": "myext.doSomething",
          "when": "editorHasSelection"
        }
      ],
      "view/title": [
        {
          "command": "myext.refresh",
          "group": "navigation"
        }
      ]
    }
  }
}
```

**Menu locations:**
- `editor/context` - Editor right-click menu
- `editor/title` - Editor title bar
- `explorer/context` - File explorer right-click
- `view/title` - View title bar
- `commandPalette` - Command palette visibility
- `scm/title`, `debug/toolbar`, etc.

### Status Bar

Add items to the bottom status bar:

```typescript
const statusBarItem = vscode.window.createStatusBarItem(
  vscode.StatusBarAlignment.Right,
  100
);
statusBarItem.text = "$(sync~spin) Processing...";
statusBarItem.command = "myext.showStatus";
statusBarItem.show();
```

### Quick Pick

Interactive selection dialogs:

```typescript
const result = await vscode.window.showQuickPick(
  ['Option 1', 'Option 2', 'Option 3'],
  { placeHolder: 'Select an option' }
);
```

### Input Box

Text input dialogs:

```typescript
const name = await vscode.window.showInputBox({
  prompt: 'Enter your name',
  validateInput: (value) => value.length < 2 ? 'Too short' : null
});
```

### Webview Panels

Full webview panels in the editor area (not Panel area):

```typescript
const panel = vscode.window.createWebviewPanel(
  'myext.preview',
  'Preview',
  vscode.ViewColumn.Two,
  { enableScripts: true }
);
panel.webview.html = '<html>...</html>';
```

---

## 3. Language Features

### Language Server Protocol (LSP)

The most powerful way to provide language intelligence. LSP separates language logic into a server process, enabling:

- **Completions** - IntelliSense suggestions
- **Hover** - Information on hover
- **Signature Help** - Parameter hints
- **Go to Definition/References** - Navigation
- **Document Symbols** - Outline view
- **Code Actions** - Quick fixes, refactorings
- **Diagnostics** - Errors, warnings, hints
- **Formatting** - Code formatting
- **Rename** - Rename symbols across files
- **Folding** - Code folding ranges
- **Semantic Tokens** - Semantic syntax highlighting

**Architecture:**
```
VS Code Extension (Client) <---> Language Server (Separate Process)
         |                              |
    JSON-RPC/stdio                  Language Logic
```

**Benefits:**
- Reusable across editors (Vim, Emacs, etc.)
- Out-of-process (won't crash VS Code)
- Testable independently

```typescript
// Client extension
import { LanguageClient, TransportKind } from 'vscode-languageclient/node';

const serverModule = context.asAbsolutePath('server/out/server.js');
const client = new LanguageClient(
  'myLanguageServer',
  'My Language Server',
  {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc }
  },
  { documentSelector: [{ scheme: 'file', language: 'mylang' }] }
);
client.start();
```

### Programmatic Language Features

For simpler cases, register providers directly:

```typescript
// Completion Provider
vscode.languages.registerCompletionItemProvider('javascript', {
  provideCompletionItems(document, position) {
    return [
      new vscode.CompletionItem('console.log', vscode.CompletionItemKind.Snippet)
    ];
  }
});

// Hover Provider
vscode.languages.registerHoverProvider('javascript', {
  provideHover(document, position) {
    return new vscode.Hover('Documentation here');
  }
});

// Definition Provider
vscode.languages.registerDefinitionProvider('javascript', {
  provideDefinition(document, position) {
    return new vscode.Location(uri, new vscode.Position(10, 0));
  }
});

// Diagnostic Collection
const diagnostics = vscode.languages.createDiagnosticCollection('myext');
diagnostics.set(document.uri, [
  new vscode.Diagnostic(range, 'Error message', vscode.DiagnosticSeverity.Error)
]);
```

### TextMate Grammars

Syntax highlighting via TextMate grammar files:

```json
{
  "contributes": {
    "grammars": [
      {
        "language": "mylang",
        "scopeName": "source.mylang",
        "path": "./syntaxes/mylang.tmLanguage.json"
      }
    ]
  }
}
```

### Semantic Token Provider

More accurate highlighting based on semantic analysis:

```typescript
vscode.languages.registerDocumentSemanticTokensProvider(
  { language: 'mylang' },
  new MySemanticTokensProvider(),
  legend
);
```

---

## 4. Editor Integrations

### Custom Editors

Replace the default text editor for specific file types:

```json
{
  "contributes": {
    "customEditors": [
      {
        "viewType": "myext.imageEditor",
        "displayName": "Image Editor",
        "selector": [
          { "filenamePattern": "*.png" },
          { "filenamePattern": "*.jpg" }
        ]
      }
    ]
  }
}
```

```typescript
class ImageEditorProvider implements vscode.CustomEditorProvider<ImageDocument> {
  // Implement open, save, revert, etc.
}
```

**Use cases:**
- Image editors
- Diagram editors (draw.io)
- Binary file viewers
- WYSIWYG editors

### Notebooks

Jupyter-style cell-based interface:

```json
{
  "contributes": {
    "notebooks": [
      {
        "type": "my-notebook",
        "displayName": "My Notebook",
        "selector": [{ "filenamePattern": "*.mynbk" }]
      }
    ]
  }
}
```

**Components:**
- **NotebookSerializer** - Load/save notebook files
- **NotebookController** - Execute cells
- **NotebookRenderer** - Render output

### Text Decorations

Add visual decorations to text:

```typescript
const decorationType = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'rgba(255,255,0,0.3)',
  border: '1px solid yellow'
});

editor.setDecorations(decorationType, [range1, range2]);
```

### Code Lens

Inline actionable information above code:

```typescript
vscode.languages.registerCodeLensProvider('javascript', {
  provideCodeLenses(document) {
    return [
      new vscode.CodeLens(range, {
        title: 'Run Test',
        command: 'myext.runTest'
      })
    ];
  }
});
```

### Inlay Hints

Inline hints within code (like TypeScript parameter names):

```typescript
vscode.languages.registerInlayHintsProvider('mylang', {
  provideInlayHints(document, range) {
    return [
      new vscode.InlayHint(position, 'paramName:', vscode.InlayHintKind.Parameter)
    ];
  }
});
```

---

## 5. Advanced Integrations

### Debug Adapter Protocol (DAP)

Create custom debuggers:

```json
{
  "contributes": {
    "debuggers": [
      {
        "type": "myDebugger",
        "label": "My Debugger",
        "program": "./out/debugAdapter.js",
        "runtime": "node",
        "configurationAttributes": {
          "launch": {
            "properties": {
              "program": { "type": "string" }
            }
          }
        }
      }
    ]
  }
}
```

**DAP Features:**
- Breakpoints
- Step execution
- Variable inspection
- Call stack
- Watch expressions
- Debug console

### Test Controller

Native test explorer integration:

```typescript
const controller = vscode.tests.createTestController('myTests', 'My Tests');

// Discover tests
controller.resolveHandler = async (item) => {
  const testItem = controller.createTestItem('test1', 'Test 1', uri);
  controller.items.add(testItem);
};

// Run tests
controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, async (request, token) => {
  const run = controller.createTestRun(request);
  // Execute tests, report results
  run.passed(testItem);
  run.end();
});
```

### File System Provider

Virtual file systems:

```typescript
class MyFileSystemProvider implements vscode.FileSystemProvider {
  // Implement stat, readDirectory, readFile, writeFile, etc.
}

vscode.workspace.registerFileSystemProvider('myfs', new MyFileSystemProvider());

// Access files via myfs:/path/to/file
```

**Use cases:**
- Remote files (SSH, FTP)
- Archive contents (ZIP, TAR)
- Database as filesystem
- Cloud storage

### Source Control Provider

Git-like source control integration:

```typescript
const scm = vscode.scm.createSourceControl('myscm', 'My SCM');
const changesGroup = scm.createResourceGroup('changes', 'Changes');
changesGroup.resourceStates = [
  { resourceUri: uri, decorations: { tooltip: 'Modified' } }
];
```

### Authentication Provider

OAuth and authentication flows:

```typescript
class MyAuthProvider implements vscode.AuthenticationProvider {
  // Implement getSessions, createSession, removeSession
}

vscode.authentication.registerAuthenticationProvider(
  'myauth',
  'My Auth',
  new MyAuthProvider()
);

// Use in other extensions
const session = await vscode.authentication.getSession('myauth', ['scope1']);
```

### Task Provider

Custom build tasks:

```typescript
vscode.tasks.registerTaskProvider('mytask', {
  provideTasks() {
    return [
      new vscode.Task(
        { type: 'mytask' },
        vscode.TaskScope.Workspace,
        'Build',
        'mytask',
        new vscode.ShellExecution('npm run build')
      )
    ];
  }
});
```

### Terminal Link Provider

Make text in terminals clickable:

```typescript
vscode.window.registerTerminalLinkProvider({
  provideTerminalLinks(context) {
    // Parse context.line for patterns
    return [{ startIndex: 0, length: 10, tooltip: 'Open file' }];
  },
  handleTerminalLink(link) {
    // Handle click
  }
});
```

---

## 6. AI Extension Mechanisms

VS Code provides multiple ways to integrate AI capabilities, from using Copilot's built-in features to running local models.

### Language Model API (vscode.lm)

> **Source:** VS Code Core API (since v1.90)  
> **Requires:** GitHub Copilot extension installed  
> **Namespace:** `vscode.lm`

The core API for accessing language models from extensions:

```typescript
// Select a model
const models = await vscode.lm.selectChatModels({
  vendor: 'copilot',
  family: 'gpt-4o'
});
const model = models[0];

// Send a request
const messages = [
  vscode.LanguageModelChatMessage.User('Explain this code')
];
const response = await model.sendRequest(messages, {}, token);

// Stream the response
for await (const chunk of response.text) {
  output += chunk;
}
```

**Key features:**
- Access Copilot models (GPT-4, GPT-4o, Claude, etc.)
- Streaming responses
- Token counting
- Model selection by vendor/family

### Chat Participants

> **Source:** VS Code Core API (since v1.90)  
> **Requires:** GitHub Copilot Chat extension  
> **Namespace:** `vscode.chat`

Create custom chat participants that users can invoke with `@participant`:

```typescript
const participant = vscode.chat.createChatParticipant('myext.expert', async (request, context, response, token) => {
  // Access the user's prompt
  const userPrompt = request.prompt;
  
  // Get conversation history
  const history = context.history;
  
  // Stream response back
  response.markdown('Here is my analysis...\n');
  
  // Use the LM API for AI responses
  const model = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
  const llmResponse = await model[0].sendRequest(messages, {}, token);
  for await (const chunk of llmResponse.text) {
    response.markdown(chunk);
  }
  
  return { metadata: { command: 'analyze' } };
});

participant.iconPath = vscode.Uri.file('/path/to/icon.png');
```

**Registration in package.json:**
```json
{
  "contributes": {
    "chatParticipants": [
      {
        "id": "myext.expert",
        "name": "expert",
        "description": "Domain expert assistant",
        "isSticky": true
      }
    ]
  }
}
```

**Participant features:**
- Custom icon and name
- Access to conversation history
- Can reference files, selections
- Can render markdown, code blocks, buttons
- Can provide follow-up suggestions

### Chat Tools

> **Source:** VS Code Core API (since v1.93)  
> **Requires:** GitHub Copilot Chat extension (Agent mode)  
> **Namespace:** `vscode.lm.registerTool`

Register tools that Copilot can invoke to gather context or perform actions:

```typescript
const tool = vscode.lm.registerTool('myext_searchDocs', {
  displayName: 'Search Documentation',
  description: 'Search the project documentation for relevant information',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query'
      },
      maxResults: {
        type: 'number',
        description: 'Maximum results to return'
      }
    },
    required: ['query']
  },
  
  async invoke(input, token) {
    const { query, maxResults } = input;
    const results = await searchDocs(query, maxResults ?? 10);
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify(results))
    ]);
  }
});
```

**Tool invocation flow:**
1. User asks Copilot a question
2. Copilot decides to call your tool based on description
3. Tool receives structured input matching schema
4. Tool returns results (text, JSON, etc.)
5. Copilot incorporates results into response

**Registration in package.json:**
```json
{
  "contributes": {
    "languageModelTools": [
      {
        "id": "myext_searchDocs",
        "displayName": "Search Documentation",
        "description": "Search project docs",
        "inputSchema": { ... }
      }
    ]
  }
}
```

### Chat Variables

> **Source:** VS Code Core API (since v1.90)  
> **Requires:** GitHub Copilot Chat extension  
> **Namespace:** `vscode.chat.registerChatVariableResolver`

Provide context variables that users can reference with `#variable`:

```typescript
vscode.chat.registerChatVariableResolver('myext.config', {
  resolve: async (name, context, token) => {
    const config = await loadProjectConfig();
    return [
      {
        level: vscode.ChatVariableLevel.Full,
        value: JSON.stringify(config, null, 2),
        description: 'Project configuration'
      }
    ];
  }
});
```

**Registration:**
```json
{
  "contributes": {
    "chatVariables": [
      {
        "id": "myext.config",
        "name": "config",
        "description": "Include project configuration"
      }
    ]
  }
}
```

Users can then type `#config` in Copilot Chat to include the configuration.

### MCP Servers (Model Context Protocol)

> **Source:** Anthropic (open standard)  
> **Support:** VS Code (since v1.99), Claude Desktop, Cursor, Zed, and others  
> **Protocol:** JSON-RPC over stdio/SSE

MCP is an open protocol for connecting AI models to external tools and data sources. VS Code supports MCP servers:

**Configuration (settings.json):**
```json
{
  "mcp": {
    "servers": {
      "filesystem": {
        "command": "npx",
        "args": ["-y", "@anthropic/mcp-server-filesystem", "/path/to/allowed/dir"]
      },
      "github": {
        "command": "npx",
        "args": ["-y", "@anthropic/mcp-server-github"],
        "env": {
          "GITHUB_TOKEN": "${env:GITHUB_TOKEN}"
        }
      },
      "custom": {
        "command": "node",
        "args": ["./my-mcp-server.js"]
      }
    }
  }
}
```

**MCP server capabilities:**
- **Tools** - Functions Copilot can call
- **Resources** - Data sources (files, databases, APIs)
- **Prompts** - Reusable prompt templates

**Creating an MCP server (Node.js):**
```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new Server({
  name: 'my-mcp-server',
  version: '1.0.0'
}, {
  capabilities: {
    tools: {}
  }
});

server.setRequestHandler('tools/list', async () => ({
  tools: [
    {
      name: 'search_database',
      description: 'Search the project database',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        }
      }
    }
  ]
}));

server.setRequestHandler('tools/call', async (request) => {
  if (request.params.name === 'search_database') {
    const results = await searchDb(request.params.arguments.query);
    return { content: [{ type: 'text', text: JSON.stringify(results) }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

**Available MCP servers:**
| Server | Purpose |
|--------|--------|
| `@anthropic/mcp-server-filesystem` | File system access |
| `@anthropic/mcp-server-github` | GitHub API |
| `@anthropic/mcp-server-postgres` | PostgreSQL queries |
| `@anthropic/mcp-server-sqlite` | SQLite queries |
| `@anthropic/mcp-server-brave-search` | Web search |
| `@anthropic/mcp-server-puppeteer` | Browser automation |

### Local Model Integration

> **Source:** Third-party tools (no VS Code API)  
> **Requires:** Local model server running (Ollama, LM Studio, etc.)  
> **Protocol:** HTTP REST API (OpenAI-compatible or custom)

Extensions can integrate with locally-running models:

**Ollama:**
```typescript
async function queryOllama(prompt: string): Promise<string> {
  const response = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama3.2',
      prompt: prompt,
      stream: false
    })
  });
  const data = await response.json();
  return data.response;
}

// Or with streaming:
async function* streamOllama(prompt: string) {
  const response = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    body: JSON.stringify({ model: 'llama3.2', prompt, stream: true })
  });
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = JSON.parse(decoder.decode(value));
    yield chunk.response;
  }
}
```

**LM Studio:**
```typescript
// LM Studio provides OpenAI-compatible API
async function queryLMStudio(messages: Array<{role: string, content: string}>) {
  const response = await fetch('http://localhost:1234/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'local-model',
      messages,
      temperature: 0.7,
      stream: true
    })
  });
  // Handle SSE streaming...
}
```

**llama.cpp server:**
```typescript
// Direct llama.cpp server integration
const response = await fetch('http://localhost:8080/completion', {
  method: 'POST',
  body: JSON.stringify({
    prompt: '<|user|>\nExplain this code\n<|assistant|>\n',
    n_predict: 512,
    temperature: 0.7
  })
});
```

### Prompt Flow Integration

> **Source:** VS Code Commands API  
> **Requires:** GitHub Copilot Chat extension  
> **Method:** `vscode.commands.executeCommand`

Send content to Copilot Chat programmatically:

```typescript
// Open chat with a query
await vscode.commands.executeCommand('workbench.action.chat.open', {
  query: 'Explain this function'
});

// Open chat with context
await vscode.commands.executeCommand('workbench.action.chat.open', {
  query: '@workspace /explain How does authentication work?'
});

// Insert into existing chat input
await vscode.commands.executeCommand('workbench.action.chat.insertIntoInput', {
  text: 'Additional context...'
});
```

### AI Extension Architecture Patterns

**Pattern 1: Tool-First**
Register tools that Copilot calls automatically:
```
User → Copilot → Your Tool → Results → Copilot → Response
```

**Pattern 2: Participant-First**
Create a dedicated participant for domain expertise:
```
User → @yourparticipant → Custom Logic + LM API → Response
```

**Pattern 3: MCP Server**
External process providing tools/resources:
```
Copilot → MCP Protocol → External Server → Data/Actions → Copilot
```

**Pattern 4: Local Model Fallback**
Use local models when Copilot unavailable or for privacy:
```
User → Extension → Check Copilot → Fallback to Ollama → Response
```

### Summary: AI Integration Options

| Mechanism | Source | Best For |
|-----------|--------|----------|
| Language Model API | VS Code API + Copilot | Accessing Copilot models from extension code |
| Chat Participants | VS Code API + Copilot | Custom conversational agents (`@agent`) |
| Chat Tools | VS Code API + Copilot | Giving Copilot access to external data/actions |
| Chat Variables | VS Code API + Copilot | User-referenced context (`#variable`) |
| MCP Servers | Anthropic (open std) | External tool servers, reusable across editors |
| Local Models | Third-party (Ollama, etc.) | Privacy-sensitive, offline, or specialized models |

---

## 7. Limitations and Alternatives

### What VS Code Extensions Cannot Do

| Limitation | Reason |
|------------|--------|
| Modify VS Code's core UI layout | Electron shell is fixed |
| Add new panel areas | Panel, Sidebar, Editor are hardcoded |
| Change window chrome | OS-level, not exposed |
| Run without sandbox | Security restrictions |
| Access arbitrary system resources | Sandboxed web context |

### Alternatives for Deeper Customization

#### Fork VS Code

Create your own VS Code distribution:
- **VSCodium** - FOSS build without telemetry
- **Code - OSS** - Microsoft's open source base

#### Eclipse Theia

VS Code-compatible IDE framework with more flexibility:
- Same extension API
- Customizable shell
- Can run in browser
- White-label friendly

#### Custom Electron App

Build from scratch using:
- Monaco Editor (VS Code's editor component)
- xterm.js (Terminal component)
- Custom shell

#### Web-Based IDEs

- **Gitpod** - Cloud development
- **GitHub Codespaces** - VS Code in browser
- **code-server** - Self-hosted VS Code

---

## Summary: Choosing the Right Mechanism

| Need | Mechanism |
|------|-----------|
| Add a button/command | Commands + Keybindings |
| Settings | Configuration |
| Tree view in sidebar | TreeDataProvider |
| Custom HTML UI in sidebar | WebviewView |
| Custom HTML UI in panel | WebviewView (panel location) |
| Full editor replacement | Custom Editor |
| Language support | LSP or Language Providers |
| Debugging | Debug Adapter Protocol |
| Testing | Test Controller |
| Virtual files | File System Provider |
| Source control | Source Control Provider |
| Build integration | Task Provider |
| Access AI models | Language Model API |
| Custom chat agent | Chat Participant |
| Give Copilot tools | Chat Tools or MCP Server |
| User-referenced context | Chat Variables |
| Local/offline AI | Ollama, LM Studio integration |

---

## References

- [VS Code Extension API](https://code.visualstudio.com/api)
- [Extension Capabilities Overview](https://code.visualstudio.com/api/extension-capabilities/overview)
- [Language Server Protocol](https://microsoft.github.io/language-server-protocol/)
- [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/)
- [Webview Guide](https://code.visualstudio.com/api/extension-guides/webview)
- [Custom Editors](https://code.visualstudio.com/api/extension-guides/custom-editors)
- [Chat Extensions](https://code.visualstudio.com/api/extension-guides/chat)
- [Language Model API](https://code.visualstudio.com/api/extension-guides/language-model)
- [MCP Specification](https://spec.modelcontextprotocol.io/)
- [MCP Servers Repository](https://github.com/modelcontextprotocol/servers)
- [Ollama API](https://github.com/ollama/ollama/blob/main/docs/api.md)
