# Tab Navigation Component

`tabPanel` provides a reusable tabbed navigation shell for webviews that require strict tab UX.

## When to use

- Use `accordionPanel` for mixed expandable sections.
- Use `tabPanel` for fixed mutually-exclusive tabs.

## Design rules

- Stable tab IDs.
- Minimal message payloads per tab action.
- Keep tab content rendering independent from tab control code.

## Integration pattern

1. define tabs and content areas,
2. bind click handlers,
3. post typed messages to extension host,
4. update UI state from extension replies.
