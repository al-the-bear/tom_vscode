/**
 * The aspect guideline store, `_ai/aspect_guidelines/<section>/`, and the
 * aspect text of one send (utils/aspectGuidelines.ts has the rules).
 *
 * - {@link readAspectSections} reads every section folder: `section.yaml`
 *   (schema `aspect-guideline-section.schema.json`, generated into the root's
 *   `.tom/json-schema/aspect-guidelines/`) and its `<option>.md` files.
 * - {@link aspectsForSend} resolves the sections over the levels a send
 *   carries, resolves the placeholders in the chosen options' texts
 *   (recursively, `${guidelines-…}`, `${file-…}` …) and places the text for
 *   the send's transport.
 *
 * The levels other than the section default reach a send through
 * `AspectLevelChoices` (an explicit input until the queue, the panels and the
 * todos feed them).
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import {
    assembleAspects,
    buildAspectSection,
    placeAspects,
    resolveAspects,
    type AspectLevelChoices,
    type AspectSection,
    type AspectSectionYaml,
    type AspectTransport,
    type AssembledAspects,
} from '../utils/aspectGuidelines';

/** The store's folder name under `_ai/`. */
export const ASPECT_GUIDELINES_FOLDER = 'aspect_guidelines';

/** The sections of a store folder, in folder-name order, and the problems found reading them. */
export function readAspectSections(dir: string | undefined): { sections: AspectSection[]; problems: string[] } {
    const sections: AspectSection[] = [];
    const problems: string[] = [];
    if (!dir) { return { sections, problems }; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { sections, problems }; }
    for (const e of entries.filter((x) => x.isDirectory() && !x.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name))) {
        const folder = path.join(dir, e.name);
        let yaml: AspectSectionYaml | undefined;
        try {
            yaml = parseYaml(fs.readFileSync(path.join(folder, 'section.yaml'), 'utf8')) as AspectSectionYaml;
        } catch (err) {
            if (fs.existsSync(path.join(folder, 'section.yaml'))) {
                problems.push(`${e.name}: section.yaml does not read: ${(err as Error).message}`);
                continue;
            }
        }
        const files: Record<string, string> = {};
        for (const f of fs.readdirSync(folder)) {
            if (!f.endsWith('.md') || f.startsWith('.')) { continue; }
            try { files[f.slice(0, -3)] = fs.readFileSync(path.join(folder, f), 'utf8'); } catch { /* gone meanwhile */ }
        }
        const built = buildAspectSection(e.name, yaml, files);
        problems.push(...built.problems);
        if (built.section) { sections.push(built.section); }
    }
    return { sections, problems };
}

/** What one send gets: the text placed for its transport, and how it was made. */
export interface AspectsForSend {
    systemSegments: string[];
    userContent: string;
    assembled: AssembledAspects;
    problems: string[];
}

/**
 * The aspect text of one send: the sections of `dir` resolved over `choices`
 * (the section defaults always apply), each chosen option's text through
 * `resolve` (the placeholder resolution, recursive), placed into the prompt
 * for `transport`.
 */
export function aspectsForSend(
    dir: string | undefined,
    transport: AspectTransport,
    prompt: { systemSegments: readonly string[]; userContent: string },
    choices: AspectLevelChoices | undefined,
    resolve: (text: string) => string,
): AspectsForSend {
    const { sections, problems } = readAspectSections(dir);
    const resolution = resolveAspects(sections, choices ?? {});
    for (const i of resolution.ignored) { problems.push(`${i.level}: "${i.section}" → "${i.option}" names no option of a section; skipped`); }
    const assembled = assembleAspects(sections, resolution, resolve);
    return { ...placeAspects(transport, prompt, assembled), assembled, problems };
}

/**
 * The live store and resolver: `_ai/aspect_guidelines/` and the placeholder
 * engine. Loaded lazily, so this module stays usable without `vscode`.
 */
export function liveAspectsForSend(
    transport: AspectTransport,
    prompt: { systemSegments: readonly string[]; userContent: string },
    choices?: AspectLevelChoices,
): AspectsForSend {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { WsPaths } = require('../utils/workspacePaths') as typeof import('../utils/workspacePaths');
    const { resolveVariables, unescapePlaceholders } = require('../utils/variableResolver') as typeof import('../utils/variableResolver');
    /* eslint-enable @typescript-eslint/no-require-imports */
    return aspectsForSend(
        WsPaths.ai(ASPECT_GUIDELINES_FOLDER),
        transport,
        prompt,
        choices,
        (text) => unescapePlaceholders(resolveVariables(text)),
    );
}

/** The aspect text placed before a Copilot prompt (Copilot has no system prompt). */
export function withAspectsForCopilot(text: string, choices?: AspectLevelChoices): string {
    try {
        return liveAspectsForSend('copilot', { systemSegments: [], userContent: text }, choices).userContent;
    } catch {
        return text;
    }
}
