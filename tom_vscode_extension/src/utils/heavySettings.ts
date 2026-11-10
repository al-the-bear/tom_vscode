/**
 * The settings of the biggest resource consumers that the @TOM VSC view
 * offers as workspace toggles (vscimpb30) — pure: the definitions, the row a
 * setting shows and the workspace value a change writes. The view writes
 * them with `WorkspaceConfiguration.update(…, ConfigurationTarget.Workspace)`.
 *
 * Why these: on a tree with dozens of repositories and many Dart packages the
 * Dart analysis server analyses every package (`dart.onlyAnalyzeProjectsWithOpenFiles`),
 * the Git extension scans every nested repository (`git.*`), and the file
 * watcher and search walk build output and scratch folders (`files.watcherExclude`,
 * `search.exclude`).
 */

export type HeavySettingKind = 'bool' | 'enum' | 'number' | 'glob' | 'listItem';

export interface HeavySetting {
    /** Unique within the list: the setting key, plus the glob / item for those kinds. */
    id: string;
    /** The setting key, e.g. `dart.onlyAnalyzeProjectsWithOpenFiles`. */
    key: string;
    kind: HeavySettingKind;
    label: string;
    /** Why it helps, for the tooltip. */
    hint: string;
    /** `enum`: the values offered. */
    options?: Array<string | boolean>;
    /** `glob`: the pattern switched on / off in the object setting. `listItem`: the entry added / removed. */
    entry?: string;
    /** The value of the lean setup (what "Lean" would choose). */
    lean: string | boolean | number;
}

const EXCLUDED_FOLDERS = ['ztmp', 'build', '.dart_tool', 'node_modules'];

/** Every setting the view offers, in the order shown. */
export const HEAVY_SETTINGS: readonly HeavySetting[] = [
    {
        id: 'dart.onlyAnalyzeProjectsWithOpenFiles', key: 'dart.onlyAnalyzeProjectsWithOpenFiles', kind: 'bool', lean: true,
        label: 'Dart: analyse only projects with open files',
        hint: 'The Dart analysis server analyses only the packages that have a file open, not every package of the workspace.',
    },
    {
        id: 'dart.analysisExcludedFolders:ztmp', key: 'dart.analysisExcludedFolders', kind: 'listItem', entry: 'ztmp', lean: true,
        label: 'Dart: do not analyse ztmp/',
        hint: 'Scratch packages in ztmp/ are left out of the analysis.',
    },
    {
        id: 'git.autoRepositoryDetection', key: 'git.autoRepositoryDetection', kind: 'enum', options: [true, false, 'subFolders', 'openEditors'], lean: 'openEditors',
        label: 'Git: find repositories',
        hint: 'openEditors: only the repositories of open files are opened, not every nested repository.',
    },
    {
        id: 'git.repositoryScanMaxDepth', key: 'git.repositoryScanMaxDepth', kind: 'number', lean: 1,
        label: 'Git: scan depth for repositories',
        hint: 'How many folder levels Git searches for repositories (-1 unlimited).',
    },
    {
        id: 'git.openRepositoryInParentFolders', key: 'git.openRepositoryInParentFolders', kind: 'enum', options: ['always', 'never', 'prompt'], lean: 'never',
        label: 'Git: open repositories in parent folders',
        hint: 'never: a repository above the workspace is not opened.',
    },
    ...EXCLUDED_FOLDERS.flatMap((folder): HeavySetting[] => [
        {
            id: `files.watcherExclude:**/${folder}/**`, key: 'files.watcherExclude', kind: 'glob', entry: `**/${folder}/**`, lean: true,
            label: `Do not watch ${folder}/`,
            hint: `The file watcher leaves ${folder}/ alone (no events, no CPU for its churn).`,
        },
        {
            id: `search.exclude:**/${folder}/**`, key: 'search.exclude', kind: 'glob', entry: `**/${folder}/**`, lean: true,
            label: `Do not search ${folder}/`,
            hint: `Search and quick open skip ${folder}/.`,
        },
    ]),
];

/** What a setting row shows. */
export interface HeavySettingRow {
    id: string;
    key: string;
    kind: HeavySettingKind;
    label: string;
    hint: string;
    options?: Array<string | boolean>;
    /** The value in effect (bool / glob / listItem: on or off). */
    value: string | boolean | number | null;
    /** Set in this workspace's settings (not only inherited). */
    inWorkspace: boolean;
    lean: string | boolean | number;
}

/**
 * The row of `def` from the setting's effective value and its workspace value
 * (`WorkspaceConfiguration.inspect(key)`).
 */
export function heavySettingRow(def: HeavySetting, effective: unknown, workspace: unknown): HeavySettingRow {
    let value: HeavySettingRow['value'];
    let inWorkspace = workspace !== undefined;
    switch (def.kind) {
        case 'glob':
            value = isRecord(effective) && effective[def.entry!] === true;
            inWorkspace = isRecord(workspace) && def.entry! in workspace;
            break;
        case 'listItem':
            value = Array.isArray(effective) && effective.includes(def.entry);
            inWorkspace = Array.isArray(workspace) && workspace.includes(def.entry);
            break;
        case 'bool':
            value = effective === true;
            break;
        case 'number':
            value = typeof effective === 'number' ? effective : null;
            break;
        default:
            value = typeof effective === 'string' || typeof effective === 'boolean' ? effective : null;
    }
    return { id: def.id, key: def.key, kind: def.kind, label: def.label, hint: def.hint, ...(def.options ? { options: def.options } : {}), value, inWorkspace, lean: def.lean };
}

/**
 * The workspace value to write when the row of `def` is set to `input`, from
 * the setting's workspace value now: a glob switched on / off in the object
 * (the other patterns kept; off removes it), an entry added to / removed from
 * the list, a boolean, an enum value (`"true"` / `"false"` read as booleans),
 * a whole number. Undefined: `input` is no value of the setting. `inherited`
 * is the value below the workspace (user, else default): a glob it has on is
 * switched off with `false` (removing it would leave it on).
 */
export function heavySettingWrite(def: HeavySetting, workspace: unknown, input: unknown, inherited?: unknown): unknown {
    switch (def.kind) {
        case 'glob': {
            const next: Record<string, unknown> = isRecord(workspace) ? { ...workspace } : {};
            if (input === true) { next[def.entry!] = true; }
            else if (isRecord(inherited) && inherited[def.entry!] === true) { next[def.entry!] = false; }
            else { delete next[def.entry!]; }
            return next;
        }
        case 'listItem': {
            const list = Array.isArray(workspace) ? workspace.filter((x) => x !== def.entry) : [];
            return input === true ? [...list, def.entry] : list;
        }
        case 'bool':
            return typeof input === 'boolean' ? input : undefined;
        case 'number': {
            const n = typeof input === 'number' ? input : Number(input);
            return Number.isInteger(n) ? n : undefined;
        }
        default: {
            const value = input === 'true' ? true : input === 'false' ? false : input;
            return def.options?.some((o) => o === value) ? value : undefined;
        }
    }
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
