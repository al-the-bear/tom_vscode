# Bottom Panel Accordion

Reusable accordion component for webview section containers.

## Used by

- `src/handlers/unifiedNotepad-handler.ts` (`@CHAT`)
- `src/handlers/t3Panel-handler.ts` (`@WS`)

## Component API

Use `getAccordionHtml(...)` with:

- section definitions (`id`, `title`, `icon`, `content`),
- initial expanded section,
- optional extra CSS/JS blocks.

## Behavior

- one-section-focus default behavior,
- pin support for persistent expansion,
- section state persistence,
- codicon-based section headers.

## Guidance

- Keep section IDs stable to preserve state.
- Keep section content generation deterministic.
- Route messages through handler-level switch statements.
