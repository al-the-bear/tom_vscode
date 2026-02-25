# AI Conversation

## Overview

The AI Conversation section orchestrates automated multi-turn conversations between a local Ollama model and GitHub Copilot. The local model acts as a "supervisor" that generates prompts, evaluates responses, and decides when the goal is reached.

## Conversation Flow

```
1. User enters goal → "Build a REST API endpoint for users"
2. Local model generates first Copilot prompt
3. Prompt sent to Copilot via VS Code Language Model API
4. Copilot response captured
5. Local model evaluates response + decides:
   ├─ Generate follow-up prompt → goto 3
   └─ Output goal-reached marker → END
6. Full conversation log saved
```

## Requirements

- **Ollama** running locally with a capable model
- **GitHub Copilot** extension activated
- Configured profiles in `tom_vscode_extension.json`

## Configuration

Settings are in the `botConversation` section of `tom_vscode_extension.json`:

```json
{
  "botConversation": {
    "maxTurns": 10,
    "historyMode": "full",
    "goalReachedMarker": "<<<GOAL_REACHED>>>",
    "initialPromptTemplate": "...",
    "followUpTemplate": "...",
    "copilotSuffix": "...",
    "profiles": {
      "default": {
        "label": "Default Conversation",
        "maxTurns": 5,
        "modelConfig": "fast"
      }
    }
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxTurns` | number | 10 | Maximum conversation turns |
| `historyMode` | string | "full" | How to handle conversation history |
| `goalReachedMarker` | string | `<<<GOAL_REACHED>>>` | Output when goal is achieved |
| `initialPromptTemplate` | string | - | Template for first prompt generation |
| `followUpTemplate` | string | - | Template for follow-up prompts |
| `copilotSuffix` | string | - | Suffix added to Copilot prompts |

## Profiles

Create profiles for different conversation types:

```json
{
  "botConversation": {
    "profiles": {
      "code-implementation": {
        "label": "Code Implementation",
        "maxTurns": 15,
        "modelConfig": "code",
        "historyMode": "trim_and_summary",
        "includeFileContext": ["src/types.ts", "README.md"]
      },
      "quick-question": {
        "label": "Quick Question",
        "maxTurns": 3,
        "temperature": 0.3
      }
    }
  }
}
```

### Profile Options

| Option | Type | Description |
|--------|------|-------------|
| `label` | string | Display name |
| `initialPromptTemplate` | string | Override initial template |
| `followUpTemplate` | string | Override follow-up template |
| `copilotSuffix` | string | Override Copilot suffix |
| `maxTurns` | number | Override max turns |
| `modelConfig` | string | Ollama model config key |
| `temperature` | number | Override temperature |
| `historyMode` | string | History handling mode |
| `includeFileContext` | string[] | Files to include as context |
| `goalReachedMarker` | string | Override completion marker |

## History Modes

| Mode | Description |
|------|-------------|
| `full` | Keep complete conversation history |
| `last` | Only include last exchange |
| `summary` | Summarize long conversations |
| `trim_and_summary` | Trim old messages and add summary |

## Panel Actions

| Button | Action |
|--------|--------|
| **Profile dropdown** | Select a conversation profile |
| **Add Profile** (+) | Create a new profile |
| **Edit Profile** (pencil) | Modify selected profile |
| **Delete Profile** (trash) | Remove profile |
| **Preview** | Show expanded goal |
| **Start** | Begin the automated conversation |

## Conversation Modes

### Ollama-Copilot Mode (Default)
- Local model generates prompts
- Copilot provides responses
- Local model evaluates and continues

### Ollama-Ollama Mode
- Two local personas converse
- Configurable with `SelfTalkPersona`

## Response Format

Copilot responses are captured in JSON answer files. See [copilot_answers.md](copilot_answers.md) for the complete answer file specification, format details, and `responseValues` reuse.

```json
{
  "requestId": "20250115_143052",
  "generatedMarkdown": "Here is the implementation...",
  "comments": "Based on your requirements...",
  "references": ["src/api/users.ts"],
  "requestedAttachments": ["config.json"],
  "responseValues": {
    "status": "completed"
  }
}
```

When `responseValues` are present, they are automatically saved to the shared chat answer store and can be referenced via `${chat.<key>}` in subsequent prompts and templates.

## Usage Workflow

1. **Select a profile** from the dropdown
2. **Enter your goal** clearly in the textarea
3. **Click Start** to begin the conversation
4. **Monitor progress** in the output channel "Tom Conversation Log"
5. **Conversation ends** when goal marker is output or max turns reached

## Output Logging

Conversations are logged to:
- **Output Channel**: "Tom Conversation Log" (real-time)
- **Markdown File**: `{workspace}/_ai/conversations/conversation_{timestamp}.md`

## Example Goals

Good goal descriptions:
- "Create a REST API endpoint for user registration with validation"
- "Refactor the UserService class to use dependency injection"
- "Write unit tests for the calculateDiscount function"

Too vague:
- "Make it better" (what is "it"?)
- "Fix bugs" (which bugs?)

## Tips

- **Be specific** in goals - the local model generates better prompts
- **Use profiles** for repetitive task types
- **Monitor the log** to observe the conversation flow
- **Adjust maxTurns** based on task complexity
- **Include file context** for code-related goals

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| "Ollama not available" | Ollama not running | Start `ollama serve` |
| "Max turns reached" | Conversation too long | Increase maxTurns or refine goal |
| "Copilot timeout" | VS Code API slow | Retry or check Copilot status |
