/**
 * The tools tomAi_askCopilot and tomAi_askBigBrother are gone (vscimpb108).
 * What still names them is cleaned by the format migration (format version 8,
 * aiFormatMigration.ts):
 *
 *   - `localLlm.tools` (their settings, edited on the Status Page) is removed
 *     from the workspace config and the user overlay;
 *   - their names are taken out of every tool list: profiles', configurations'
 *     and the MCP server's `enabledTools` in those files, the quests'
 *     `extension_config.<quest>.yaml` and the role types' tool selections —
 *     also the old reference names `tom_askCopilot` / `tom_askBigBrother`.
 *
 * The Copilot answer-file round trip of scripts stays (services/copilotRoundTrip.ts).
 * vscode-free.
 */

import { Document, isScalar, isSeq, visit } from 'yaml';

/** The format version that removes them. */
export const REMOVED_ASK_TOOLS_FORMAT_VERSION = 8;

/** The removed tools' names, current and old (`tom_askCopilot`). */
export const REMOVED_ASK_TOOL_NAME = /^(tomAi|tom)_ask(Copilot|BigBrother)$/;

/**
 * Remove `localLlm.tools` and every list entry naming a removed tool from a
 * parsed config (in place). Answers what was done ([] when nothing).
 */
export function dropAskToolSettings(cfg: unknown): string[] {
    const done: string[] = [];
    const local = (cfg as { localLlm?: unknown } | null)?.localLlm;
    if (local && typeof local === 'object' && !Array.isArray(local) && 'tools' in local) {
        delete (local as Record<string, unknown>).tools;
        done.push('remove localLlm.tools (the askCopilot / askBigBrother settings)');
    }
    let removed = 0;
    const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
            for (let i = node.length - 1; i >= 0; i--) {
                if (typeof node[i] === 'string' && REMOVED_ASK_TOOL_NAME.test(node[i] as string)) { node.splice(i, 1); removed++; }
                else { walk(node[i]); }
            }
        } else if (node && typeof node === 'object') {
            for (const value of Object.values(node as Record<string, unknown>)) { walk(value); }
        }
    };
    walk(cfg);
    if (removed > 0) { done.push(`remove tomAi_askCopilot / tomAi_askBigBrother from the tool lists, ${removed} entr${removed === 1 ? 'y' : 'ies'}`); }
    return done;
}

/**
 * The same for a YAML document kept as written (comments, layout): every
 * sequence entry naming a removed tool is deleted. Answers how many.
 */
export function dropAskToolNamesFromYaml(doc: Document): number {
    let removed = 0;
    visit(doc, {
        Scalar(key, node, path) {
            const parent = path[path.length - 1];
            if (typeof key === 'number' && isSeq(parent) && isScalar(node) && typeof node.value === 'string' && REMOVED_ASK_TOOL_NAME.test(node.value)) {
                removed++;
                return visit.REMOVE;
            }
            return undefined;
        },
    });
    return removed;
}
