# Tom VS Code Scripting API - Copilot Guidelines

**Project:** `tom_vscode_scripting_api`  
**Type:** Dart Package

## Applicable Guidelines

### Global Guidelines
| Document | Purpose |
|----------|---------|
| [Documentation Guidelines](../../../../_copilot_guidelines/documentation_guidelines.md) | Where to place user docs vs development docs |
| [Specification Workflow](../../../../_copilot_guidelines/spec_workflow.md) | How to implement from specifications |

### Dart Guidelines
| Document | Purpose |
|----------|---------|
| [Coding Guidelines](../../../../_copilot_guidelines/dart/coding_guidelines.md) | Naming conventions, error handling, patterns |
| [Unit Tests](../../../../_copilot_guidelines/dart/unit_tests.md) | Test structure, matchers, mocking patterns |
| [Examples](../../../../_copilot_guidelines/dart/examples.md) | Example file creation guidelines |

## Publishing

This package is published to pub.dev. See [Project Republishing](../../../../_copilot_guidelines/dart/project_republishing.md) for the complete publishing workflow.

After every publish, move the consumers' locks onto it — from the workspace root,
`./_bin/upgrade_consumer_locks.py tom_vscode_scripting_api --test`. A lock is
machine-local and `dart pub get` keeps it, so without this step Webwork, d4rt,
tom_brain and the other consumers go on resolving the previous release, and
frozen-lock guards such as tom_webwork_core's FROZENLOCKS-2 go red. Held or
failing consumers are filed in their quests. The same holds for `tom_todo_model`
when this quest publishes it.

## Project-Specific Guidelines

None - this project follows standard guidelines.

## Quick Reference

See project README.md for usage documentation.
