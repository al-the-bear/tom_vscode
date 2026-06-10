# Media Webview Migration Guide

How to author a VS Code webview in this extension **without** embedding its
HTML/JS inside a TypeScript template literal. This is the pattern proven by the
chat panel reference migration (quest `vscode_extension`, Phase A) and applied
to every webview in Phase B.

> **Driving plan:** `_ai/quests/vscode_extension/webview_restructuring_plan.md`.
> Read §2 (target architecture) and §5 (standard migration steps) before
> migrating a panel; this doc is the day-to-day reference.

---

## 1. Why this exists

Embedding a panel's full HTML/JS in `webview.html = \`...\`` forces hand-escaping
of backticks, `${...}`, and backslashes, hides the JS from ESLint/`tsc`, and
makes every panel re-implement nonce + CSP + `asWebviewUri` rewriting. The fix:
author **real `.html` / `.js` / `.css` files** under `media/<panelId>/` and let
`src/utils/webviewLoader.ts` do all the rewriting in one place.

---

## 2. File layout

```
media/
  <panelId>/
    index.html    # standard HTML; references ./main.js (via {{baseUri}}) etc.
    main.js       # standard JS — @ts-check for new code, linted
    style.css
  shared/
    completion.js # reusable textarea-completion client (opt-in)
    base.css      # shared base styles
    accordion.css # shared accordion styles
  types/
    webview.d.ts  # dev-only ambient typings (NOT shipped — see §8)
```

`<panelId>` is the string you pass to `loadWebviewHtml`; keep it identical to the
webview's view/panel id where practical (e.g. `chatPanel`).

---

## 3. The loader

```ts
import { loadWebviewHtml } from '../utils/webviewLoader';

webviewView.webview.options = {
  enableScripts: true,
  localResourceRoots: [
    vscode.Uri.joinPath(this._context.extensionUri, 'media'),
    // ...any other roots the panel needs (codicons, etc.)
  ],
};

webviewView.webview.html = loadWebviewHtml(webviewView.webview, 'chatPanel', {
  init: { codiconsUri: codiconsUri.toString(), placeholderHelp: PLACEHOLDER_HELP },
});
```

`loadWebviewHtml(webview, panelId, opts?)` options:

| Option | Type | Purpose |
| --- | --- | --- |
| `init` | `Record<string, unknown>` | First-paint data → `window.__INIT__` (see §5). |
| `styles` | `string[]` | Extra CSS file names under `media/<panelId>/` to `<link>` into `<head>`. |
| `scripts` | `string[]` | Extra JS file names under `media/<panelId>/` to inject as nonce'd `<script src>` before the init payload. |

**Critical:** add `media` to `localResourceRoots`, or the webview cannot load any
externalized asset.

### The only rewriting that ever happens

The loader is deliberately minimal (`renderWebviewHtml` is the pure core):

1. **Fixed placeholder substitution** (§4) — and nothing else. Unknown `{{...}}`
   tokens are left untouched.
2. A standard CSP `<meta>` is injected **iff** the document has none (§7).
3. Every `<script>` without a `nonce` attribute gets the per-load nonce.
4. `window.__INIT__ = <JSON>` is injected (nonce'd) before the first `main.js`
   reference, or before `</body>` if there is none.

Per-render/dynamic data does **not** go through string substitution — it flows
through `init` (first paint) or `postMessage` (updates).

---

## 4. Fixed placeholder set

Only these four placeholders are substituted. Write them verbatim in `index.html`:

| Placeholder | Resolves to |
| --- | --- |
| `{{cspSource}}` | `webview.cspSource` |
| `{{nonce}}` | fresh per-load nonce |
| `{{baseUri}}` | `asWebviewUri(media/<panelId>/)` (no trailing slash) |
| `{{sharedUri}}` | `asWebviewUri(media/shared/)` (no trailing slash) |

Reference assets relatively against these, e.g.
`<link rel="stylesheet" href="{{baseUri}}/style.css">`,
`<script src="{{baseUri}}/main.js"></script>`,
`<script src="{{sharedUri}}/completion.js"></script>`.

Do **not** invent new placeholders for dynamic data — use `init`/`postMessage`.
A tiny static label swap (the §9 exception) may keep a minimal `{{title}}`-style
token, but that token must be added to the loader's map to be substituted; the
four above are the only ones the loader knows.

---

## 5. `init` (first paint) vs `postMessage` (live updates)

- **First paint only, known at construction time → `init`.** Serialized to JSON
  and exposed as `window.__INIT__`. Read it once in `main.js`:
  ```js
  const init = window.__INIT__ || {};
  ```
  The loader escapes `</` in the payload so it cannot break out of `<script>`.
- **Anything that changes after load → `postMessage`.** The host posts; `main.js`
  listens with `window.addEventListener('message', ...)`. Never re-render the
  whole HTML to push an update.

Rule of thumb: if you would have string-substituted it into the HTML on every
render, it belongs on `postMessage`, not in a placeholder.

---

## 6. Textarea completion (`/skill` + `@file`)

Opt a textarea into shared Ctrl+Shift+Space completion:

1. **HTML/JS side:** tag the textarea with `data-completion="on"` and include the
   shared client: `<script src="{{sharedUri}}/completion.js"></script>` after
   your `main.js`.
2. **Publish the bridge:** in `main.js`, right after `acquireVsCodeApi()`:
   ```js
   var vscode = acquireVsCodeApi();
   window.__tomVscodeApi = vscode; // shared completion.js reads this
   ```
   `acquireVsCodeApi()` may be called only once per webview, so the host script
   publishes the handle and `completion.js` reads it (with an acquire-and-cache
   fallback).
3. **Extension side:** call `wireCompletionMessages(webview)` once when wiring the
   panel's message handler:
   ```ts
   import { wireCompletionMessages } from '../utils/completionWiring';
   // ...
   wireCompletionMessages(webviewView.webview);
   ```
   It registers its own `onDidReceiveMessage` (coexists with your switch),
   handles `requestCompletion`, and posts `insertCompletion` via
   `showCompletionPicker`.

The client uses **document-level keydown delegation**, so it covers textareas
rendered after load with no per-textarea wiring. After inserting it dispatches an
`input` event, so your existing input listeners (e.g. draft persistence) fire
normally — the component stays decoupled from panel state.

Pure completion logic lives in `src/services/completion-service.ts` (tested);
`completion.js` is the thin DOM client mirroring `detectToken`.

---

## 7. CSP gotcha — inline handlers vs the default nonce-only CSP

The loader's **default** CSP is **nonce-only** for scripts:
`script-src 'nonce-${nonce}'`. Under CSP level 3, when a nonce-source is present
`'unsafe-inline'` is **ignored** — so inline `onclick=` / `on*=` attributes and
inline `<script>` without the nonce will **not run**.

- **No inline handlers (preferred):** let the loader inject the default CSP. Wire
  events in `main.js` with `addEventListener`. New panels should do this.
- **Panel has inline `onclick=` handlers (legacy, e.g. chat panel):**
  **hand-write a CSP** in `index.html` that uses `'unsafe-inline'` **without** a
  nonce-source for `script-src`, e.g.:
  ```html
  <meta http-equiv="Content-Security-Policy" content="default-src 'none';
    img-src {{cspSource}} https: data:; style-src {{cspSource}} 'unsafe-inline';
    font-src {{cspSource}} data:; script-src {{cspSource}} 'unsafe-inline';">
  ```
  Because the document already declares a CSP, the loader leaves it alone (it
  only injects when none is present). Migrating away from inline handlers later
  lets you drop back to the stricter default.

---

## 8. Typecheck / lint policy for media JS

- **New media JS:** header `// @ts-check`. It must pass `npm run typecheck:media`
  (strict checkJs via `tsconfig.media.json`) and `npm run lint:media`.
- **Verbatim legacy extractions** (large scripts moved unchanged from a template
  literal, e.g. `media/chatPanel/main.js`): header `// @ts-nocheck` with a short
  comment noting it predates strict checkJs; tighten to `@ts-check` opportunistically.
- ESLint warnings that are unavoidable for inline-handler functions (eslint can't
  see them referenced from HTML, so they look `no-unused-vars`) are acceptable —
  the gate passes on warnings, fails on errors. Prefer `addEventListener` wiring
  in new code to avoid them.
- `media/types/webview.d.ts` provides ambient typings (`acquireVsCodeApi`,
  `window.__INIT__`, `window.__tomVscodeApi`). It is **dev-only** and excluded
  from the VSIX by `.vscodeignore` (`**/*.ts` covers `*.d.ts`; there is
  intentionally no `!**/*.d.ts` re-include, and `media/types/**` is excluded too).

---

## 9. Exceptions — do NOT route through the full loader

From plan §3:

| Case | Files | Handling |
| --- | --- | --- |
| **External-package webviews** | `yamlGraph-handler.ts` (delegates to the `yaml-graph-core` / `yaml-graph-vscode` npm packages) | HTML/JS is owned by the sub-packages and loaded via dynamic import. **Document only — do not migrate.** |
| **Content-injection / preview webviews** | `markdownHtmlPreview`, `markdownBrowser`, `handler_shared` preview panel | Externalize the **shell** like any other panel, but inject the rendered markdown/HTML **content via `postMessage`**, never via template substitution. |
| **Tiny static-string placeholders** | a panel that only swaps a label/title into otherwise-static HTML | A minimal `{{title}}`-style placeholder is fine (added to the loader map); don't over-engineer with an `init` payload. |
| **Degenerate error fallbacks** | the `catch`-block / unresolved-state HTML in `chatPanel-handler.ts` (T2 render error), `yamlGraph-handler.ts` (graph-type-unresolved + exception) | Tiny inline `<html><body>…</body></html>` strings assigned to `webview.html` **only** when the normal render path fails (e.g. `loadWebviewHtml` itself threw because a media file is missing). They carry no scripts and no user input, and externalizing them is circular — you cannot load a media shell to report that media loading failed. **Keep inline; do not migrate.** The migration's "no remaining `webview.html = \`\`" gate excludes these. |

### 9.1 yamlGraph — external-package webview (no migration)

`src/handlers/yamlGraph-handler.ts` registers the `tomAi.yamlGraphEditor`
custom editor but **does not own its webview**. The editor's HTML/CSS/JS is
produced by `YamlGraphEditorProvider.resolveCustomTextEditor` from the
**`yaml-graph-vscode`** npm package (with graph conversion from
**`yaml-graph-core`**), both pulled in via dynamic `import()` so a missing
dependency degrades gracefully instead of crashing activation. The handler is
thin glue: it loads graph types, resolves the graph type for the document, then
**delegates** to `provider.resolveCustomTextEditor(...)`, which assigns
`webviewPanel.webview.html`.

The only HTML authored **in this repo** for that editor is two degenerate
**error-fallback** pages assigned to `webview.webview.html` directly — one when
the graph type cannot be resolved (lists the registered types), one when
`resolveCustomTextEditor` throws (shows the stack). These are intentionally left
as small inline template literals: they are error placeholders, never the live
panel surface, and externalizing them would add a `media/` shell for something a
user sees only on misconfiguration. They carry no scripts and no user input.

**Action: none.** Do not create `media/yamlGraph/`. To restyle or restructure
the real editor webview, change the `yaml-graph-vscode` / `yaml-graph-core`
packages under `tom_ai/vscode/` (see the quest overview's *YAML graph editor*
docs: `doc/yaml_graph.md`, `doc/yaml_graph_architecture_design.md`), not this
extension. This handler is excluded from the "no remaining `webview.html = \`\`"
completion gate.

### 9.2 Host-shell panels (accordion / tab): two `<script>`-safety rules

The accordion (`@WS`) and tab-panel hosts do **not** route through
`loadWebviewHtml`. They author their JS/CSS in `media/<panelId>/` files, read
them with `readMediaText(panelId, file)`, and compose an **inline shell** via a
*literal* token substitution (`html.split('{{css}}').join(css)` etc.) in
`getAccordionHtml` / `getTabPanelHtml` (`src/handlers/accordionPanel.ts`,
`tabPanel.ts`). This is the documented "shell stays inline" path on
`readMediaText` — distinct from the fixed-placeholder rewriting of §3/§4. Because
the host composes raw HTML by hand, it carries two `<script>`-safety rules the
loader would otherwise enforce for you.

**Rule 1 — strip comments before token substitution.** Run
`stripHtmlComments(shell)` on the raw shell *before* substitution. The shells
carry a leading dev-doc comment that names the `{{css}}`/`{{script}}` tokens
verbatim. Literal substitution is not comment-aware, so it expands those tokens
**inside the comment** too — dumping the whole css+script blob there. The
injected script contains a `-->` sequence that closes the HTML comment early,
spilling the rest of the (escaped) script source onto the page as visible text
and leaving the real body unrendered. Stripping comments first lets the dev docs
reference the tokens freely without leaking. `stripHtmlComments`
(`src/utils/webviewLoader.ts`) is a plain `replace(/<!--[\s\S]*?-->/g, '')`; run
it on the **raw template only** so injected css/script that legitimately
contains `<!--`/`-->` is never touched.

**Rule 2 — escape `<`→`<` in any JSON embedded in an inline `<script>`.**
`getAccordionScript` serialises the section list + section contents to JSON and
embeds them **inside** the accordion's inline `<script>`. A section fragment
containing a literal `</script>` (e.g. guidelines or issues content) closes the
script element early, dumping the rest of the page as text and leaving `@WS`
stuck on "Loading…". The fix is `escapeForScript(json)` —
`json.replace(/</g, '\\u003c')` — applied to **both** `sectionsJson` and
`contentsJson`: the `<` escape is decoded back to `<` by the JS engine
inside the string literal but is invisible to the HTML parser, so no `</script>`
(or `<!--`) can ever appear in the markup. This is the **same technique** as the
loader's `serializeInit`, which escapes `</` in the `window.__INIT__` payload
(§5) — the host shell just has to apply it explicitly because it builds its
inline script by hand instead of going through the loader.

> Both rules are about the literal-`{{css}}`/`{{script}}` *shell-token*
> substitution and hand-built inline `<script>`, **not** the AI-prompt
> placeholder engine (`${…}` / `{{…}}` resolved by `variableResolver.ts` /
> `promptTemplate.ts` — see `doc/placeholder_engine.md`). Different subsystem;
> the AI-template engine does neither comment stripping nor `<`-escaping.

---

## 10. Per-panel migration checklist

1. Extract HTML → `media/<panelId>/index.html`, JS → `main.js`, CSS → `style.css`
   (collapse `\\`→`\` from the old template literal).
2. Move first-paint data to `init`/`window.__INIT__`; keep live updates on
   `postMessage`.
3. Swap `webview.html = \`...\`` → `loadWebviewHtml(webview, '<panelId>', { init })`;
   add `media` to `localResourceRoots`.
4. For textareas: add `data-completion="on"`, include `completion.js`, publish
   `window.__tomVscodeApi`, call `wireCompletionMessages(webview)`.
5. **QA:** `source ~/.nvm/nvm.sh; nvm use 25 && npm run compile && npm test &&
   npm run lint:media && npm run typecheck:media`.
6. **Verify (manual):** `!reinstall_extension` + reload; confirm the panel
   renders, its actions work, and completion (if any) works.
