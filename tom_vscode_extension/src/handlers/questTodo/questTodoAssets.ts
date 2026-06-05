/**
 * Static webview assets for the Quest TODO panel.
 *
 * Phase B.5 webview restructuring — the CSS, HTML fragment and client
 * script now live as real files under `media/questTodoPanel/`
 * (`style.css`, `fragment.html`, `main.js`). These accessors read them
 * raw via {@link readMediaText} so the assets stay lint/typecheck-clean
 * and free of template-literal escaping.
 *
 * `readMediaText` (not `loadWebviewHtml`) is used deliberately: these
 * fragments are composed into FOUR consumers — the standalone popout and
 * embedded webviews (in `questTodoPanel-handler.ts`), the quest todo
 * editor (`questTodoEditor-handler.ts`), and the WS panel accordion
 * (`wsPanel-handler.ts`). The accordion shell is migrated last
 * (plan B.24), so the assets must remain composable string fragments.
 *
 * The script accessor (`getQuestTodoScript`) lives in the handler because
 * it prepends the one config-dependent line (`var qtViewConfig = …`).
 */

import { readMediaText } from '../../utils/webviewLoader';

/** CSS for the Quest TODO section (top bar, split panes, pickers, mass-add overlay). */
export function getQuestTodoCss(): string {
    return readMediaText('questTodoPanel', 'style.css');
}

/** HTML fragment for the Quest TODO section content (inside accordion). */
export function getQuestTodoHtmlFragment(): string {
    return readMediaText('questTodoPanel', 'fragment.html');
}
