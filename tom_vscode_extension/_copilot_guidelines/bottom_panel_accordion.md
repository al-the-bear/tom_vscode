# Bottom Panel Accordion

Reusable accordion component for webview section containers. Source: [accordionPanel.ts](../src/handlers/accordionPanel.ts).

## Used by

- [chatPanel-handler.ts](../src/handlers/chatPanel-handler.ts) — `@CHAT` webview with 5 chat subpanels.
- [wsPanel-handler.ts](../src/handlers/wsPanel-handler.ts) — `@WS` workspace webview.
- [questTodoPanel-handler.ts](../src/handlers/questTodoPanel-handler.ts) — quest todo panel.
- [minimalMode-handler.ts](../src/handlers/minimalMode-handler.ts) — minimal-mode variants.

## Component API

Use `getAccordionHtml(...)` with:

- section definitions (`id`, `title`, `icon`, `content`),
- initial expanded section,
- optional extra CSS / JS blocks,
- pin + rotation callbacks.

## Behavior

- One-section-focus default: opening a section collapses unpinned siblings.
- **Pin** a section to keep it expanded when others open.
- **Rotate** collapsed sections as vertical tabs (see [tab_navigation.md](tab_navigation.md)).
- Section state persistence across webview reloads via `retainContextWhenHidden` + extension-host persistence.
- Codicon-based section headers.

## Guidance

- Keep section IDs stable across releases — they key persisted layout state.
- Keep section content generation deterministic; side-effects belong in the handler, not in HTML builders.
- Route messages through the handler's top-level `onDidReceiveMessage` switch, not from inside accordion helpers.
