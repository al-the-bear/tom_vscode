/**
 * The context the steps of `_ai` format version 11 work with (ai_format_migration.md § 3.6): every quest
 * folder into the layout of § 3.2. Each step is a module of this folder, called by migrateAiFormats
 * (src/utils/aiFormatMigration.ts) in a fixed order; with `apply: false` a step only reports. vscode-free.
 */

/** The steps of format version 11, as the migration report names them. */
export type V11Step =
    | 'config-files'
    | 'notes'
    | 'memory'
    | 'qa-journal'
    | 'host-sessions'
    | 'host-trail'
    | 'untrack'
    | 'copilot-leftovers';

export interface V11Context {
    /** The `_ai` folder. */
    aiRoot: string;
    /** This machine's host slug (hostSlugOf()): the `<host>` of every per-host file name. */
    hostSlug: string;
    /** false: report what would be done, write nothing. */
    apply: boolean;
    /** The quests to migrate (folder names under `quests/`). */
    quests: string[];
    /** Every quest folder under `quests/` (workspace-wide steps). */
    allQuests: string[];
    /** The workspace configuration (`.tom/tom_vscode_extension.json`), when it exists. */
    workspaceConfigPath?: string;
    /** The user-global overlay (`~/.tom/vscode/tom_vscode_extension.user.yaml`), when it exists. */
    userConfigPath?: string;
    /** Report a change (done, or to be done on a dry run). `quest` is a quest id or `(workspace)` / `(machine)`. */
    change(quest: string, step: V11Step, detail: string): void;
    /** Report what cannot be migrated and stays as it is (the format stamp is then not written). */
    problem(quest: string, step: V11Step, detail: string): void;
    /** A path as the report shows it: relative to `aiRoot`, `/`-separated. */
    rel(p: string): string;
    /**
     * Remove tracked files from git's index, keeping them on disk (`git rm --cached`), paths relative to
     * `aiRoot`. Undefined: no git available (the step reports what to untrack as a problem-free change
     * the user's next `_ai` commit has to make). Answers an error text, or undefined when it worked.
     */
    untrack?: (aiRelPaths: string[]) => string | undefined;
    /** The tracked files of `_ai` that its ignore rules now cover (`git ls-files -ci --exclude-standard`), relative to `aiRoot`. Undefined: no git. */
    trackedIgnored?: () => string[] | undefined;
}
