# `media/` — externalized webview assets

Authored as **real `.html` / `.js` / `.css` files** and loaded through the
single rewriting loader `src/utils/webviewLoader.ts`. This replaces embedding
webview HTML/JS inside TypeScript template literals (the source of the
recurring escaping/lint bugs).

## Layout

```
media/
  <panelId>/
    index.html   # standard HTML; references ./main.js, ./style.css
    main.js      # standard JS (lint/typecheck-able), uses window.__INIT__
    style.css
  shared/
    base.css     # shared base styles (migrated from getBaseStyles)
    completion.js  # (Phase A.4) reusable textarea-completion client
```

## Loader contract

`loadWebviewHtml(webview, panelId, { init })` performs the **only** rewriting:

| Placeholder   | Replaced with |
| ------------- | ------------- |
| `{{cspSource}}` | `webview.cspSource` |
| `{{nonce}}`     | fresh per-load nonce |
| `{{baseUri}}`   | `asWebviewUri(media/<panelId>/)` (no trailing slash) |
| `{{sharedUri}}` | `asWebviewUri(media/shared/)` (no trailing slash) |

Plus: a standard CSP `<meta>` is injected if the document has none; every
`<script>` without a `nonce` gets the per-load nonce; and `window.__INIT__`
(first-paint data) is injected before `main.js`.

**Rule:** first-paint data goes through `init` (→ `window.__INIT__`); live
updates go through `postMessage`. Never build per-render data via string
substitution — keep the `.html` files static and lint-clean.

Unknown `{{...}}` tokens are left untouched.
