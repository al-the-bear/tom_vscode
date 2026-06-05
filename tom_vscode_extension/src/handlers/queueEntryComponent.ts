/**
 * Shared Queue Entry Editor Component (§3.2e)
 *
 * Provides reusable HTML/CSS/JS *strings* used by both the Prompt Queue Editor
 * and the Prompt Template Editor. Both editors render queue-entry YAML
 * documents using the same visual component; differences are controlled via a
 * `mode` flag inside the rendered JS (`'queue'` vs `'template'`).
 *
 * ## Single source of truth (Phase B.13 / B.14 webview restructuring)
 *
 * The component's CSS/JS now live as real, lintable files under
 * `media/shared/` rather than inside TypeScript template literals:
 *
 *   - `queueEntryStyles.css`
 *   - `queueEntryUtils.js`
 *   - `queueEntryRenderFunctions.js`
 *   - `queueEntryMessageHandlers.js`
 *
 * Both the Prompt Queue Editor and the Prompt Template Editor load them
 * directly as `<script src>` / `<link>` tags pointing at `media/shared/` (via
 * the loader's `{{sharedUri}}` placeholder). They were promoted from
 * `media/queueEditor/` to `media/shared/` in B.14 once the template editor
 * became the second consumer. Keeping both editors fed from one set of files
 * means a change to the component lands in both with no copy-paste.
 *
 * These accessors remain for any consumer that needs the raw text (e.g. tests
 * or a future inline host); they simply read the media files via
 * {@link readMediaText}.
 *
 * The leading `// @ts-nocheck` / `/* eslint-disable *​/` banner and the file
 * header comments in those media files are harmless JS/CSS comments when the
 * template editor concatenates them into its inline script/style.
 */

import { readMediaText } from '../utils/webviewLoader';

/** Shared queue-entry CSS (see {@link queueEntryStyles} media file). */
export function queueEntryStyles(): string {
  return readMediaText('shared', 'queueEntryStyles.css');
}

/** Shared JS utility functions (escapeHtml, statusSortRank, …). */
export function queueEntryUtils(): string {
  return readMediaText('shared', 'queueEntryUtils.js');
}

/** Shared JS render functions (renderEntry, renderFollowUps, renderPrePrompts). */
export function queueEntryRenderFunctions(): string {
  return readMediaText('shared', 'queueEntryRenderFunctions.js');
}

/** Shared JS message handlers (updateText, addPrePrompt, previewItem, …). */
export function queueEntryMessageHandlers(): string {
  return readMediaText('shared', 'queueEntryMessageHandlers.js');
}
