/**
 * Shared Queue Entry Editor Component (§3.2e)
 *
 * Provides reusable HTML/CSS/JS *strings* used by both the Prompt Queue Editor
 * and the Prompt Template Editor. Both editors render queue-entry YAML
 * documents using the same visual component; differences are controlled via a
 * `mode` flag inside the rendered JS (`'queue'` vs `'template'`).
 *
 * ## Single source of truth (Phase B.13 webview restructuring)
 *
 * The component's CSS/JS now live as real, lintable files under
 * `media/queueEditor/` rather than inside TypeScript template literals:
 *
 *   - `queueEntryStyles.css`
 *   - `queueEntryUtils.js`
 *   - `queueEntryRenderFunctions.js`
 *   - `queueEntryMessageHandlers.js`
 *
 * The Prompt Queue Editor loads them directly as `<script src>` / `<link>`
 * tags via its `media/queueEditor/index.html`. The Prompt Template Editor
 * (which still inlines the component into its own script block) gets the exact
 * same text through these accessors, which simply read the media files via
 * {@link readMediaText}. Keeping both consumers fed from one set of files means
 * a change to the component lands in both editors with no copy-paste.
 *
 * The leading `// @ts-nocheck` / `/* eslint-disable *​/` banner and the file
 * header comments in those media files are harmless JS/CSS comments when the
 * template editor concatenates them into its inline script/style.
 */

import { readMediaText } from '../utils/webviewLoader';

/** Shared queue-entry CSS (see {@link queueEntryStyles} media file). */
export function queueEntryStyles(): string {
  return readMediaText('queueEditor', 'queueEntryStyles.css');
}

/** Shared JS utility functions (escapeHtml, statusSortRank, …). */
export function queueEntryUtils(): string {
  return readMediaText('queueEditor', 'queueEntryUtils.js');
}

/** Shared JS render functions (renderEntry, renderFollowUps, renderPrePrompts). */
export function queueEntryRenderFunctions(): string {
  return readMediaText('queueEditor', 'queueEntryRenderFunctions.js');
}

/** Shared JS message handlers (updateText, addPrePrompt, previewItem, …). */
export function queueEntryMessageHandlers(): string {
  return readMediaText('queueEditor', 'queueEntryMessageHandlers.js');
}
