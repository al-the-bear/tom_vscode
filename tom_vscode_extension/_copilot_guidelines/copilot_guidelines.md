# Copilot Coding Guidelines for this Extension

## Goals

- keep behavior aligned with registered commands and view IDs,
- prefer minimal, targeted edits,
- preserve message protocol compatibility in webviews,
- keep docs synchronized with implementation changes.

## Required checks for changes

- Compile TypeScript (`npx tsc -p ./`).
- Verify impacted command IDs still match `package.json`.
- Verify panel/view IDs still match registration.

## Documentation sync rules

When changing command surfaces, panel sections, or architecture:

1. update `vscode_extension_overview.md`,
2. update relevant focused guideline files,
3. update `doc/quick_reference.md` and `doc/user_guide.md` if user-visible behavior changed.

## Message handling

- Use explicit `type`/`action` branches.
- Avoid introducing ambiguous message payloads.
- Keep payload schema backward-compatible where possible.

## Reliability

- Guard filesystem access.
- Fail soft for optional feature stacks.
- Keep activation resilient to partial dependency failures.
