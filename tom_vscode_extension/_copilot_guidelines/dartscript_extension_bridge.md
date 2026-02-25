# DartScript Extension Bridge

## Role

Defines how extension commands and handlers interact with bridge-backed runtime services.

## Command families

Bridge-relevant command IDs include:

- bridge lifecycle (`restart`, profile switch),
- CLI integration server control,
- process monitor startup,
- debug logging toggles,
- bridge-assisted execution helpers.

## Integration principles

- Keep bridge operations idempotent where possible.
- Surface status in logs/status page.
- Avoid hard coupling between unrelated handlers and bridge internals.

## Diagnostics

Use:

- status page command,
- debug logging toggle,
- compile/runtime command feedback.
