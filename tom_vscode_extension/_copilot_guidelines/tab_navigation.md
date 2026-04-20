# Tab Navigation Component

`tabPanel` provides a reusable tabbed navigation shell for webviews that require strict tab UX. Source: [tabPanel.ts](../src/handlers/tabPanel.ts).

In `@CHAT` it is used in conjunction with [bottom_panel_accordion.md](bottom_panel_accordion.md) — collapsed accordion sections rotate into vertical tabs so the user can keep quick access to every subpanel without the whole accordion being expanded.

## When to use

- Use `accordionPanel` for mixed expandable sections with optional pinning.
- Use `tabPanel` for fixed mutually-exclusive tabs (no pin behavior).

## Design rules

- **Stable tab IDs.** They key persisted active-tab state.
- **Minimal message payloads per tab action.** Post a type + id; let the handler reply with full state.
- **Keep tab content rendering independent from tab control code.** The tab shell is pure layout; content is owned by the handler.

## Integration pattern

1. Define tab ids and content areas on webview init.
2. Bind click handlers in the webview script.
3. Post typed messages (`{ type: 'selectTab', id }`) to the extension host.
4. Update UI state from extension replies.
