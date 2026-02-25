# VS Code Bridge Examples Overview

Use these examples to explore the API. Files marked "Helper" use `VsCodeHelper`; files marked "Direct" use the `VSCode` class and its namespaces. The minimal and script samples remain unchanged for quick smoke checks.

## Helper-driven examples
- [example/d4rt_helpers_demo.dart](example/d4rt_helpers_demo.dart): Window/status, workspace, diagnostics/commands, and Copilot helper flows in one run.
- [example/copilot_example.dart](example/copilot_example.dart): Focused Copilot helper tasks (models, Q&A, explain/review, generate/fix).
- [example/test_helper_methods.dart](example/test_helper_methods.dart): Class-based smoke suite for helper window/workspace/command usage (Explorer runnable).

## Direct VSCode API examples
- [example/test_vscode_api.dart](example/test_vscode_api.dart): Window, workspace, commands/extensions, and language model flows using `VSCode` namespaces.
- [example/code_analysis_demo.dart](example/code_analysis_demo.dart): Workspace scanning and reporting example using direct APIs.
- [example/d4rt_bridge_demo.dart](example/d4rt_bridge_demo.dart): Strongly typed bridge demo with bridged VS Code types.
- [example/nested_execution_example.dart](example/nested_execution_example.dart): Nested request pattern across Dart ↔ VS Code.
- [example/test_context_menu.dart](example/test_context_menu.dart): Class-based direct API smoke tests for window/workspace/commands (Explorer runnable).

## Language Model / Chat focused
- [example/test_inline_context_menu.dart](example/test_inline_context_menu.dart): LM and chat smoke suite using `VSCode.lm` (Explorer runnable).

## Minimal runners (kept as-is)
- [example/example_dart_minimal.dart](example/example_dart_minimal.dart)
- [example/example_dart_script.dart](example/example_dart_script.dart)

### Running
- From VS Code Explorer: right-click a file → choose the DartScript run option to execute the script.
- From Dart: `dart run example/<file>.dart` (helper scripts will no-op if the bridge is absent).
