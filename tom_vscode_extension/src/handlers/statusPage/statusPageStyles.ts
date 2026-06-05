/**
 * Static CSS for the Status panel.
 *
 * Wave 3.2 continuation — `statusPage-handler.ts` is ~3,000 lines;
 * the embedded-status stylesheet is the single largest static block
 * and has no dependencies on handler state, so it moves cleanly out
 * here. The rest of the handler (HTML builders, message routing,
 * settings writes) keeps living in the handler because it wires
 * directly into per-section state and the webview contract.
 *
 * Re-exported from `../statusPage-handler.ts` so downstream callers
 * (`wsPanel-handler`, the bottom-panel embed) keep their imports
 * unchanged.
 */

import { readMediaText } from '../../utils/webviewLoader';

export function getEmbeddedStatusStyles(): string {
    // The stylesheet now lives verbatim in media/statusPage/status.css (Phase B.11
    // webview restructuring) so the standalone status page links it directly and
    // the @WS accordion embed inlines the same source via this function. The raw
    // read avoids the loader's HTML rewriting — see readMediaText's docs.
    return readMediaText('statusPage', 'status.css');
}
