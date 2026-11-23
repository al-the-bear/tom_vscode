/**
 * Aspect choices as guideline files (gsel17; guideline_sectioning.md D-8,
 * D-18): where a choice's **Guideline file** is looked up, and which copy wins.
 *
 * A choice's text is either its **Own text**, `_ai/aspect_guidelines/<aspect>/<choice>.md`,
 * or a **Guideline file**, `_agent_guidelines/aspects/<aspect>/<choice>.md`
 * in a guideline layer. The layers ({@link aspectFileLayers}): the Tom root's,
 * then each workspace folder on the way down to the window's — a nested
 * workspace folder sees the root's, the outer workspace folder's and its own —,
 * the nearest winning for the same aspect and choice. Own text wins over every
 * guideline file of the same choice (the files it shadows are named). The
 * aspect's definition, `aspect.yaml`, stays in `_ai/aspect_guidelines/`.
 *
 * Pure (`path` only; whether a folder is a workspace folder is passed in).
 */

import * as path from 'path';

/** The folder of the guideline files below a layer's folder. */
export const ASPECT_FILES_DIR = ['_agent_guidelines', 'aspects'] as const;

/** One layer of guideline files. */
export interface AspectFileLayer {
    /** `<folder>/_agent_guidelines/aspects`, absolute. */
    base: string;
    /** `root` for the Tom root's, `workspace` for a workspace folder's. */
    level: 'root' | 'workspace';
    /** The folder relative to the Tom root, `/`-separated; `.` for the root. */
    folder: string;
    /** The window's own workspace folder's layer (the nearest). */
    own: boolean;
}

/** Where a choice's text comes from. */
export interface AspectChoiceSource {
    kind: 'own' | 'file';
    /** The file, absolute. */
    path: string;
    /** The file as shown: relative to the Tom root, `/`-separated (an own text: `_ai/aspect_guidelines/<aspect>/<choice>.md`). */
    display: string;
    /** A guideline file: its layer. */
    level?: 'root' | 'workspace';
    /** A guideline file: its layer's `base`. */
    base?: string;
    /** The guideline files this text wins over (displayed), nearest first. */
    shadows?: string[];
}

const toPosix = (p: string): string => p.split(path.sep).join('/');

/**
 * The guideline layers of a window: the Tom root's, then every workspace
 * folder between it and `workspaceFolder` (`isWorkspaceFolder` decides), then
 * `workspaceFolder`'s own. A standalone window (the workspace folder is the
 * root) has one layer, the root's.
 */
export function aspectFileLayers(root: string, workspaceFolder: string, isWorkspaceFolder: (dir: string) => boolean): AspectFileLayer[] {
    const base = (dir: string): string => path.join(dir, ...ASPECT_FILES_DIR);
    const rel = path.relative(root, workspaceFolder);
    const below = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).filter(Boolean) : [];
    const layers: AspectFileLayer[] = [{ base: base(root), level: 'root', folder: '.', own: below.length === 0 }];
    let dir = root;
    below.forEach((segment, i) => {
        dir = path.join(dir, segment);
        const last = i === below.length - 1;
        if (last || isWorkspaceFolder(dir)) {
            layers.push({ base: base(dir), level: 'workspace', folder: toPosix(path.relative(root, dir)), own: last });
        }
    });
    return layers;
}

/** The folder a layer belongs to (the root or a workspace folder): `base` without `_agent_guidelines/aspects`. */
export function layerFolder(layer: Pick<AspectFileLayer, 'base'>): string {
    return path.dirname(path.dirname(layer.base));
}

/** A guideline file of `layer` as shown: relative to the Tom root. */
export function displayOfLayerFile(layer: Pick<AspectFileLayer, 'folder'>, aspect: string, choice: string): string {
    return `${layer.folder === '.' ? '' : `${layer.folder}/`}${ASPECT_FILES_DIR.join('/')}/${aspect}/${choice}.md`;
}

/** An own text's file as shown. */
export function displayOfOwnText(aspect: string, choice: string): string {
    return `_ai/aspect_guidelines/${aspect}/${choice}.md`;
}

/** How a layer is named to the user: the root's, or a workspace folder's. */
export function layerLabel(layer: Pick<AspectFileLayer, 'level' | 'folder'>): string {
    return layer.level === 'root' ? 'the root\'s' : `workspace ${layer.folder}`;
}

/**
 * The winning source of each choice of one aspect: own text over the guideline
 * files, the nearest guideline layer over the farther ones. `own`: the choice
 * names with an own text; `files`: per layer (in {@link aspectFileLayers}
 * order) the choice names it has a file for.
 */
export function choiceSources(
    aspect: string,
    own: { names: readonly string[]; path: (choice: string) => string },
    layers: ReadonlyArray<{ layer: AspectFileLayer; names: readonly string[] }>,
): Record<string, AspectChoiceSource> {
    const out: Record<string, AspectChoiceSource> = {};
    const names = new Set<string>([...own.names, ...layers.flatMap((l) => l.names)]);
    for (const choice of names) {
        const copies = [...layers].reverse().filter((l) => l.names.includes(choice)).map((l) => l.layer);
        const files = copies.map((l) => displayOfLayerFile(l, aspect, choice));
        if (own.names.includes(choice)) {
            out[choice] = { kind: 'own', path: own.path(choice), display: displayOfOwnText(aspect, choice), ...(files.length ? { shadows: files } : {}) };
            continue;
        }
        const nearest = copies[0];
        out[choice] = {
            kind: 'file',
            path: path.join(nearest.base, aspect, `${choice}.md`),
            display: files[0],
            level: nearest.level,
            base: nearest.base,
            ...(files.length > 1 ? { shadows: files.slice(1) } : {}),
        };
    }
    return out;
}
