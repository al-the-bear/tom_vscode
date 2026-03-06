# Prompt Queue YAML Schema

This document specifies the YAML schema for prompt queue entries and templates. The schema enables modeling complex multi-prompt flows with gates, follow-ups, decisions, and reminders.

## File Extensions

| Extension | Purpose |
|-----------|---------|
| `*.queue.yaml` | Generic prompt queue files |
| `*.entry.queue.yaml` | Queue entry files (active queue items) |
| `*.template.queue.yaml` | Prompt template files |

## File Locations

### Queue Entries

Queue entry files are stored in a configurable folder with fallback `${ai}/queue`:

```
<full-timestamp>_<quest-id>.<subsystem>.entry.queue.yaml
```

- **Timestamp**: Full timestamp (`YYYYMMDD_HHMMSSmmm`) for chronological ordering
- **Quest ID**: From active `.code-workspace` file, or `default` if none
- **Subsystem**: Currently only `copilot`

Example: `20260305_143022123_vscode_extension.copilot.entry.queue.yaml`

**Window Sharing**: VS Code windows with the same quest (same `.code-workspace` file) share the same queue.

### Templates

Template files are stored as:

```
<template-name>.template.queue.yaml
```

Templates appear queue template custom editor.

## Schema Structure

### Top-Level Structure

```yaml
meta:
  id: <unique-identifier>
  name: <display-name>
  description: <description-text>
  main-prompt: <entry-point-prompt-id>
  imports:
    - <path-to-imported-file.queue.yaml>
    - <another-import.queue.yaml>

prompt-queue:
  - prompt:
      id: P1
      # ... prompt fields ...
  - prompt:
      id: P2
      # ... prompt fields ...
```

### Metadata Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier for the queue file |
| `name` | string | Yes | Human-readable name |
| `description` | string | No | Description of the queue/template purpose |
| `main-prompt` | string | No | Entry point prompt ID when executing the file |
| `imports` | list | No | Files to import (treated as appended to this file) |

### Prompt Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier for the prompt |
| `name` | string | Human-readable name |
| `type` | enum | `main`, `followup`, `preprompt`, `gate`, `decision` |
| `prompt-text` | string | The actual prompt text (mutually exclusive with `file`) |
| `file` | string | Path to file to execute (mutually exclusive with `prompt-text`) |
| `template` | string | Template name for main/initial prompt |
| `answer-template` | string | Template name for final answer prompt |
| `use-answer-wrapper` | boolean | Whether to use answer wrapper |
| `llm-profile` | string | `copilot` or an LLM configuration name |

### Metadata (Per-Prompt)

| Field | Type | Description |
|-------|------|-------------|
| `metadata.status` | string | Prompt status |
| `metadata.collapsed` | boolean | UI collapse state |
| `metadata.name` | string | Display name override |
| `metadata.description` | string | Description override |
| `metadata.template-name` | string | Template name if this file is a template |
| `metadata.*` | any | Additional UI state attributes (extensible) |

### Reminder Fields

| Field | Type | Description |
|-------|------|-------------|
| `reminder-template` | string | Template name for reminder prompt |
| `reminder-wait-time` | duration | Time to wait before sending reminder |
| `reminder-repeat` | integer | Number of times to repeat reminder |
| `reminder-enabled` | boolean | Enable/disable reminder |

### Reference Fields

| Field | Type | Description |
|-------|------|-------------|
| `gate-ref` | string | Reference to ID of gate prompt |
| `pre-prompts` | list | List of references to pre-prompt IDs |
| `follow-ups` | list | List of references to follow-up prompt IDs |

### Decision Prompt Fields

Only valid for prompts with `type: decision`:

| Field | Type | Description |
|-------|------|-------------|
| `case-expression` | string | Expression to evaluate for decision |
| `case-mapping` | list | List of value/prompt pairs for routing |
| `case-reminder-ref` | string | Prompt reference for missing decision data |

### Case Mapping Entry

```yaml
case-mapping:
  - value: "approved"
    prompt-ref: approval-flow
  - value: "rejected"
    prompt-ref: rejection-flow
  - value: "default"  # Matches all other values
    prompt-ref: fallback-flow
```

Values support regex matching.

## Conditions

Gate prompts can have conditions for checking. Supported functions:

| Function | Description |
|----------|-------------|
| `matches(<regex>)` | Match answer against regex |
| `checkAnswerValue(<name>, <expected-regex>)` | Check named value in answer |

Combining operators: `AND`, `OR`
Grouping: Parentheses `()` supported

Example:
```yaml
condition: "matches('success') AND checkAnswerValue('status', 'complete')"
```

## References

References can point to:

1. **Internal prompt**: Another prompt ID in this file or an imported file
2. **External file**: A `.queue.yaml` file path to load and run

External files can be called recursively.

### Answer Values

Prompts can return answer/chat values. Values collected during execution of an external file flow are returned and merged into the overall chat variables.

## Restrictions

| Prompt Type | Cannot Have |
|-------------|-------------|
| `gate` | `gate-ref`, `follow-ups` |
| `followup` | `follow-ups` |
| Non-`decision` | `case-expression`, `case-mapping`, `case-reminder-ref` |

## Trail Integration

- **Raw trail files**: All requests and answers from queue execution are written
- **Summary trail files**: Only track the original prompt and final answer
- **Final answer**: Obtained via "Answer Prompt" template sent after queue item completion

## Example

### Simple Queue Entry

```yaml
meta:
  id: refactor-component
  name: Refactor Component
  description: Multi-step refactoring flow with validation

prompt-queue:
  - prompt:
      id: P1
      name: Initial Analysis
      type: main
      prompt-text: |
        Analyze the component structure and identify
        refactoring opportunities.
      llm-profile: copilot
      gate-ref: gate-validate
      follow-ups:
        - implement-changes

  - prompt:
      id: gate-validate
      name: Validation Gate
      type: gate
      prompt-text: |
        Verify the analysis is complete and accurate.
        Respond with "PASS" or "FAIL".
      condition: "matches('PASS')"

  - prompt:
      id: implement-changes
      name: Implement Changes
      type: followup
      prompt-text: |
        Implement the identified refactoring changes.
      reminder-template: gentle-nudge
      reminder-wait-time: 5m
      reminder-enabled: true
```

### Decision Flow

```yaml
meta:
  id: review-decision
  name: Code Review Decision
  main-prompt: review-start

prompt-queue:
  - prompt:
      id: review-start
      name: Start Review
      type: main
      prompt-text: |
        Review the changes and decide: approve, request-changes, or reject.
        Return your decision in #decision=<value>.
      follow-ups:
        - decision-router

  - prompt:
      id: decision-router
      name: Route Decision
      type: decision
      case-expression: "checkAnswerValue('decision', '.*')"
      case-mapping:
        - value: "approve"
          prompt-ref: merge-flow.queue.yaml
        - value: "request-changes"
          prompt-ref: revision-request
        - value: "reject"
          prompt-ref: rejection-notice
        - value: "default"
          prompt-ref: clarify-decision
      case-reminder-ref: decision-reminder

  - prompt:
      id: decision-reminder
      name: Decision Reminder
      type: followup
      prompt-text: |
        Please provide your decision using #decision=<value>.

  - prompt:
      id: revision-request
      name: Request Revisions
      type: followup
      prompt-text: |
        Specify the changes needed.

  - prompt:
      id: rejection-notice
      name: Rejection Notice
      type: followup
      prompt-text: |
        Explain the rejection reason.

  - prompt:
      id: clarify-decision
      name: Clarify Decision
      type: followup
      prompt-text: |
        Your decision was unclear. Please choose: approve, request-changes, or reject.
```

## Deviation Notes

This schema is a **specification document** describing the intended design. The following aspects may require implementation work:

1. **Imports system**: File importing and merging logic needs implementation
2. **Condition parser**: The condition expression parser (`matches()`, `checkAnswerValue()`, `AND`/`OR`) needs implementation
3. **Decision routing**: Case expression evaluation and mapping logic needs implementation
4. **Recursive file calls**: Loading and executing external `.queue.yaml` files needs implementation
5. **Answer value collection**: Collecting and merging chat values from sub-flows needs implementation
6. **Queue path configuration**: Making the queue folder configurable alongside trails/status paths
7. **Template categories**: "Answer Prompts" category in template editor needs UI support

The current prompt queue implementation stores queue state differently; migration to this YAML-based storage is a breaking change that replaces existing queue storage mechanisms.
