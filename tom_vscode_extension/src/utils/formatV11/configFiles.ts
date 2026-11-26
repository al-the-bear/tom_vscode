/**
 * Format version 11, step `config-files` (see context.ts): the configuration of every quest into its folder
 * `config/` (ai_format_migration.md § 3.2, AC-20 (a)). Runs first, so every later step of a run finds the
 * configuration there.
 *
 * Per quest folder, every file of the config families at its top level moves into `config/`:
 *   - `process-state.<q>.yaml` and every run's `process-state.<q>.<run>.yaml`;
 *   - `extension_config.<q>.yaml` and every host's `extension_config.<host>.<q>.yaml` (all hosts: the files
 *     are tracked, the first host migrating moves them all).
 * A target that exists already: identical, the old file is deleted; different, a problem and both stay.
 * A temporary file of these families a write left behind (`*.tmp`) is deleted.
 */

import * as fs from 'fs';
import * as path from 'path';

import { isQuestConfigFileName, questConfigFolder } from '../questConfigFiles';
import type { V11Context } from './context';

/** A temporary file of the config families (`<file>.tmp`, `.<file>.<pid>.<n>.tmp`). */
function isStaleTempName(name: string): boolean {
    return /^\.?(?:process-state|extension_config)\..*\.tmp$/.test(name);
}

function entries(folder: string): fs.Dirent[] {
    try { return fs.readdirSync(folder, { withFileTypes: true }); } catch { return []; }
}

function migrateQuest(ctx: V11Context, quest: string): void {
    const questFolder = path.join(ctx.aiRoot, 'quests', quest);
    const configFolder = questConfigFolder(questFolder);
    const names = entries(questFolder).filter((e) => e.isFile()).map((e) => e.name).sort();
    const moving = names.filter(isQuestConfigFileName);
    const stale = names.filter(isStaleTempName);
    if (!moving.length && !stale.length) { return; }

    if (fs.existsSync(configFolder) && !fs.statSync(configFolder).isDirectory()) {
        ctx.problem(quest, 'config-files', `${ctx.rel(configFolder)} is a file, not a folder: ${moving.join(', ')} stay where they are`);
        return;
    }
    for (const name of stale) {
        const file = path.join(questFolder, name);
        ctx.change(quest, 'config-files', `remove ${ctx.rel(file)} (a temporary file left behind)`);
        if (ctx.apply) { fs.unlinkSync(file); }
    }
    for (const name of moving) {
        const from = path.join(questFolder, name);
        const to = path.join(configFolder, name);
        if (!fs.existsSync(to)) {
            ctx.change(quest, 'config-files', `move ${ctx.rel(from)} -> ${ctx.rel(to)}`);
            if (ctx.apply) {
                fs.mkdirSync(configFolder, { recursive: true });
                fs.renameSync(from, to);
            }
            continue;
        }
        if (fs.statSync(to).isFile() && fs.readFileSync(from).equals(fs.readFileSync(to))) {
            ctx.change(quest, 'config-files', `remove ${ctx.rel(from)} (identical to ${ctx.rel(to)})`);
            if (ctx.apply) { fs.unlinkSync(from); }
            continue;
        }
        ctx.problem(quest, 'config-files', `${ctx.rel(from)}: ${ctx.rel(to)} exists with other content; both kept — merge them into ${ctx.rel(to)} and delete ${ctx.rel(from)}`);
    }
}

/** Move every quest's process states and extension configurations into its `config/` folder. */
export function migrateV11ConfigFiles(ctx: V11Context): void {
    for (const quest of ctx.quests) { migrateQuest(ctx, quest); }
}
