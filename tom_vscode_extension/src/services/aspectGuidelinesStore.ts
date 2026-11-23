/**
 * The aspect guideline store, `_ai/aspect_guidelines/<aspect>/`, and the
 * aspect text of one send (utils/aspectGuidelines.ts has the rules).
 *
 * - {@link readAspectSections} reads every aspect folder: `aspect.yaml`
 *   (schema `aspect-guideline.schema.json`, generated into the root's
 *   `.tom/json-schema/aspect-guidelines/`) and its `<choice>.md` files. A
 *   folder that still has only `section.yaml` (before format version 10) is a
 *   problem: the migration renames it. A choice may also be a guideline file
 *   `_agent_guidelines/aspects/<aspect>/<choice>.md` of the root or a
 *   workspace folder down to the window's (gsel17, utils/aspectChoiceFiles.ts):
 *   own text wins, then the nearest layer. An aspect folder of a layer without
 *   a definition in `_ai/aspect_guidelines/` is a problem.
 * - {@link aspectsForSend} resolves the aspects over the levels a send
 *   carries, resolves the placeholders in the chosen choices' texts
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
    ASPECT_FILE,
    assembleAspects,
    buildAspectSection,
    LEGACY_ASPECT_FILE,
    placeAspects,
    resolveAspects,
    type AspectLevelChoices,
    type AspectSection,
    type AspectSectionYaml,
    type AspectTransport,
    type AssembledAspects,
} from '../utils/aspectGuidelines';
import { aspectFileLayers, choiceSources, type AspectChoiceSource, type AspectFileLayer } from '../utils/aspectChoiceFiles';

/** The store's folder name under `_ai/`. */
export const ASPECT_GUIDELINES_FOLDER = 'aspect_guidelines';

/** The `<choice>.md` files of a folder: name → text (none when it does not exist). */
export function choiceFilesOf(folder: string): Record<string, string> {
    const files: Record<string, string> = {};
    let names: string[] = [];
    try { names = fs.readdirSync(folder); } catch { return files; }
    for (const f of names) {
        if (!f.endsWith('.md') || f.startsWith('.')) { continue; }
        try { files[f.slice(0, -3)] = fs.readFileSync(path.join(folder, f), 'utf8'); } catch { /* gone meanwhile */ }
    }
    return files;
}

/** One aspect's choice texts: its own texts, each layer's guideline files, and the winning text and source per choice. */
export interface AspectChoiceTexts {
    own: Record<string, string>;
    /** Per layer, in layer order (the root's first): its files of the aspect. */
    layerFiles: Array<{ layer: AspectFileLayer; files: Record<string, string> }>;
    /** The text each choice is sent with: own text, else the nearest guideline file. */
    texts: Record<string, string>;
    sources: Record<string, AspectChoiceSource>;
}

/** The choice texts of aspect `id`: `<dir>/<id>/` (own texts) and `<layer.base>/<id>/` of every layer (gsel17). */
export function readAspectChoiceTexts(dir: string, id: string, layers: readonly AspectFileLayer[]): AspectChoiceTexts {
    const ownFolder = path.join(dir, id);
    const own = choiceFilesOf(ownFolder);
    const layerFiles = layers.map((layer) => ({ layer, files: choiceFilesOf(path.join(layer.base, id)) }));
    const sources = choiceSources(
        id,
        { names: Object.keys(own), path: (c) => path.join(ownFolder, `${c}.md`) },
        layerFiles.map((l) => ({ layer: l.layer, names: Object.keys(l.files) })),
    );
    const texts: Record<string, string> = {};
    for (const [choice, source] of Object.entries(sources)) {
        texts[choice] = source.kind === 'own' ? own[choice] : layerFiles.find((l) => l.layer.base === source.base)!.files[choice];
    }
    return { own, layerFiles, texts, sources };
}

/** The aspect folders of the guideline layers that have no definition in `dir` (gsel17): a problem each. */
export function orphanGuidelineAspects(dir: string, layers: readonly AspectFileLayer[]): Array<{ id: string; folders: string[] }> {
    const found = new Map<string, string[]>();
    for (const layer of layers) {
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(layer.base, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (!e.isDirectory() || e.name.startsWith('.') || fs.existsSync(path.join(dir, e.name))) { continue; }
            found.set(e.name, [...(found.get(e.name) ?? []), layer.folder]);
        }
    }
    return [...found.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, folders]) => ({ id, folders }));
}

/** The problem an orphan aspect is reported with. */
export function orphanProblem(o: { id: string; folders: string[] }): string {
    return `${o.id}: guideline files in ${o.folders.map((f) => `${f === '.' ? '' : `${f}/`}_agent_guidelines/aspects/${o.id}/`).join(', ')}, but no _ai/aspect_guidelines/${o.id}/${ASPECT_FILE} defines the aspect (the Aspect Guidelines editor creates it)`;
}

/**
 * The aspects of a store folder, in folder-name order, and the problems found
 * reading them. `layers` (gsel17): the guideline layers whose
 * `_agent_guidelines/aspects/<aspect>/<choice>.md` files are choices too.
 */
export function readAspectSections(dir: string | undefined, layers: readonly AspectFileLayer[] = []): { sections: AspectSection[]; problems: string[] } {
    const sections: AspectSection[] = [];
    const problems: string[] = [];
    if (!dir) { return { sections, problems }; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
    for (const e of entries.filter((x) => x.isDirectory() && !x.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name))) {
        const folder = path.join(dir, e.name);
        let yaml: AspectSectionYaml | undefined;
        try {
            yaml = parseYaml(fs.readFileSync(path.join(folder, ASPECT_FILE), 'utf8')) as AspectSectionYaml;
        } catch (err) {
            if (fs.existsSync(path.join(folder, ASPECT_FILE))) {
                problems.push(`${e.name}: ${ASPECT_FILE} does not read: ${(err as Error).message}`);
                continue;
            }
            if (fs.existsSync(path.join(folder, LEGACY_ASPECT_FILE))) {
                problems.push(`${e.name}: has ${LEGACY_ASPECT_FILE}, the definition file before format version 10; Upgrade the workspace renames it to ${ASPECT_FILE}`);
                continue;
            }
        }
        const { texts, sources } = readAspectChoiceTexts(dir, e.name, layers);
        const built = buildAspectSection(e.name, yaml, texts, sources);
        problems.push(...built.problems);
        if (built.section) { sections.push(built.section); }
    }
    for (const o of orphanGuidelineAspects(dir, layers)) { problems.push(orphanProblem(o)); }
    return { sections, problems };
}

/**
 * The live store: `_ai/aspect_guidelines/` and the window's guideline layers
 * (the Tom root's, the workspace folders down to the window's). Loaded lazily,
 * so this module stays usable without `vscode`.
 */
export function liveAspectStore(): { dir: string | undefined; layers: AspectFileLayer[] } {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { WsPaths } = require('../utils/workspacePaths') as typeof import('../utils/workspacePaths');
    const { getLayout } = require('../utils/workspaceLayout') as typeof import('../utils/workspaceLayout');
    const { isWorkspaceFolderDir } = require('../utils/workspaceRegistry') as typeof import('../utils/workspaceRegistry');
    /* eslint-enable @typescript-eslint/no-require-imports */
    let dir: string | undefined;
    try { dir = WsPaths.ai(ASPECT_GUIDELINES_FOLDER); } catch { dir = undefined; }
    const layout = getLayout();
    return { dir, layers: layout ? aspectFileLayers(layout.root, layout.workspaceFolder, isWorkspaceFolderDir) : [] };
}

/** The live store's aspects (readAspectSections over liveAspectStore). */
export function readLiveAspectSections(): { sections: AspectSection[]; problems: string[] } {
    const { dir, layers } = liveAspectStore();
    return readAspectSections(dir, layers);
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
    layers: readonly AspectFileLayer[] = [],
): AspectsForSend {
    const { sections, problems } = readAspectSections(dir, layers);
    const resolution = resolveAspects(sections, choices ?? {});
    for (const i of resolution.ignored) { problems.push(`${i.level}: "${i.section}" → "${i.option}" names no choice of an aspect; skipped`); }
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
    const { resolveVariables, unescapePlaceholders } = require('../utils/variableResolver') as typeof import('../utils/variableResolver');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const { dir, layers } = liveAspectStore();
    return aspectsForSend(
        dir,
        transport,
        prompt,
        choices,
        (text) => unescapePlaceholders(resolveVariables(text)),
        layers,
    );
}

/**
 * The aspect text placed before a Copilot prompt (Copilot has no system
 * prompt). `choices`: the send's levels; default: the live ones
 * (services/aspectChoiceLevels.ts liveAspectChoices).
 */
export function withAspectsForCopilot(text: string, choices?: AspectLevelChoices): string {
    try {
        /* eslint-disable-next-line @typescript-eslint/no-require-imports */
        const levels = choices ?? (require('./aspectChoiceLevels') as typeof import('./aspectChoiceLevels')).liveAspectChoices();
        return liveAspectsForSend('copilot', { systemSegments: [], userContent: text }, levels).userContent;
    } catch {
        return text;
    }
}
