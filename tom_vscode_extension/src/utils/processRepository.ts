/**
 * Process files on disk — fs only, no `vscode`, so it is tested against
 * temporary folders.
 *
 *   <processes>/<id>/<id>.process.yaml   the structure (processDefinition.ts)
 *   <processes>/<id>/<id>.md             the description
 *   <quests>/<quest>/process-state.<quest>.yaml   where that quest is: a stack of
 *                                                 levels, the top one its position
 *   <quests>/<quest>/process-state.<quest>.<run>.yaml   another run of the quest
 *                                                 (processRuns.ts): its own stack
 *
 * `<processes>` is `_ai/processes`, `<quests>` is `_ai/quests`; both live in
 * the one shared `_ai` clone, so a quest's process state is the same on every
 * machine.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';

import { DEFAULT_RUN, runOfStateFile, runStateFileName } from './processRuns';

import {
    EMPTY_PROCESS_STATE,
    parseProcessStateStack,
    parseProcessYaml,
    stringifyProcessDefinition,
    stringifyProcessState,
    stringifyProcessStateStack,
    validateProcessDefinition,
    type ProcessDefinition,
    type ProcessProblem,
    type ProcessState,
    type ProcessStateStack,
} from './processDefinition';

export interface ProcessEntry {
    /** The folder name, which is the process id. */
    id: string;
    yamlPath: string;
    mdPath: string;
    /** Set when the YAML is valid. */
    definition?: ProcessDefinition;
    /** The parsed YAML even when invalid (so the editor can open it); undefined when it does not parse. */
    raw?: unknown;
    errors: ProcessProblem[];
    /** The `.md` description; `''` when absent. */
    description: string;
}

export type RepositoryResult = { ok: true } | { ok: false; error: string };

function readText(file: string): string {
    try { return fs.readFileSync(file, 'utf-8'); } catch { return ''; }
}

/** A definition to start a new process from: one phase, one step, its gate. */
export function starterDefinition(id: string, name?: string): ProcessDefinition {
    return {
        id,
        name: name || id,
        summary: '',
        phases: [{
            id: 'phase1',
            name: 'Phase 1',
            description: '',
            steps: [{ id: 'work', name: 'Work' }],
            gate: { id: 'gate', name: 'Quality gate' },
        }],
    };
}

export class ProcessRepository {
    constructor(
        private readonly processesDir: string,
        private readonly questsDir: string,
    ) {}

    private paths(id: string): { dir: string; yamlPath: string; mdPath: string } {
        const dir = path.join(this.processesDir, id);
        return { dir, yamlPath: path.join(dir, `${id}.process.yaml`), mdPath: path.join(dir, `${id}.md`) };
    }

    /** Every folder holding a `<id>.process.yaml`, by id. */
    list(): ProcessEntry[] {
        let names: string[];
        try {
            names = fs.readdirSync(this.processesDir, { withFileTypes: true })
                .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
                .map((e) => e.name)
                .sort();
        } catch {
            return [];
        }
        const out: ProcessEntry[] = [];
        for (const id of names) {
            const { yamlPath, mdPath } = this.paths(id);
            if (!fs.existsSync(yamlPath)) { continue; }
            const text = readText(yamlPath);
            const parsed = parseProcessYaml(text);
            let raw: unknown;
            try { raw = parse(text); } catch { raw = undefined; }
            const errors = [...parsed.errors];
            if (parsed.definition && parsed.definition.id !== id) {
                errors.push({ path: 'id', message: `"${parsed.definition.id}" differs from its folder "${id}"` });
            }
            out.push({
                id, yamlPath, mdPath,
                definition: errors.length ? undefined : parsed.definition,
                raw,
                errors,
                description: readText(mdPath),
            });
        }
        return out;
    }

    /** The valid definitions, by id. */
    definitions(): Map<string, ProcessDefinition> {
        const out = new Map<string, ProcessDefinition>();
        for (const entry of this.list()) {
            if (entry.definition) { out.set(entry.id, entry.definition); }
        }
        return out;
    }

    private checkNewId(id: string): string | undefined {
        const bad = validateProcessDefinition({ id, phases: [{ id: 'x', steps: [], gate: { id: 'g' } }] }).errors.find((e) => e.path === 'id');
        if (bad) { return `id: ${bad.message}`; }
        if (fs.existsSync(this.paths(id).dir)) { return `a process "${id}" exists already`; }
        return undefined;
    }

    /** A new process with a starter definition and description. */
    create(id: string, name?: string): RepositoryResult {
        const problem = this.checkNewId(id);
        if (problem) { return { ok: false, error: problem }; }
        const def = starterDefinition(id, name);
        return this.write(def, `# ${def.name}\n\nWhat this process is for, and how it is meant to be worked through.\n`);
    }

    /** A copy of `fromId` under `toId`. */
    copy(fromId: string, toId: string): RepositoryResult {
        const source = this.list().find((p) => p.id === fromId);
        if (!source) { return { ok: false, error: `no process "${fromId}"` }; }
        if (!source.definition) { return { ok: false, error: `process "${fromId}" is not valid; fix it before copying` }; }
        const problem = this.checkNewId(toId);
        if (problem) { return { ok: false, error: problem }; }
        return this.write({ ...source.definition, id: toId }, source.description);
    }

    /** Write a definition and its description after validating it; nothing is written when invalid. */
    save(def: ProcessDefinition, description: string): RepositoryResult {
        const check = validateProcessDefinition(JSON.parse(JSON.stringify(def)));
        if (check.errors.length) {
            return { ok: false, error: check.errors.map((e) => `${e.path}: ${e.message}`).join('\n') };
        }
        return this.write(def, description);
    }

    private write(def: ProcessDefinition, description: string): RepositoryResult {
        try {
            const { dir, yamlPath, mdPath } = this.paths(def.id);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(yamlPath, stringifyProcessDefinition(def), 'utf-8');
            fs.writeFileSync(mdPath, description, 'utf-8');
            return { ok: true };
        } catch (e) {
            return { ok: false, error: (e as Error).message };
        }
    }

    /** The state file of `run` of `quest` (the quest's own file for `default`). */
    stateFile(quest: string, run: string = DEFAULT_RUN): string {
        return path.join(this.questsDir, quest, runStateFileName(quest, run));
    }

    /** Where `run` of `quest` is: the top level of its stack; the empty state when it has no state file. */
    readState(quest: string, run: string = DEFAULT_RUN): ProcessState {
        const { levels } = this.readStateStack(quest, run);
        return levels[levels.length - 1];
    }

    /** The whole stack of `run` of `quest`, bottom first; one empty level when it has no state file. */
    readStateStack(quest: string, run: string = DEFAULT_RUN): ProcessStateStack {
        if (!quest) { return { levels: [{ ...EMPTY_PROCESS_STATE }] }; }
        const text = readText(this.stateFile(quest, run));
        return text ? parseProcessStateStack(text) : { levels: [{ ...EMPTY_PROCESS_STATE }] };
    }

    /** Write `state` as the top level of `run`; the levels below it stay as they are. */
    writeState(quest: string, state: ProcessState, run: string = DEFAULT_RUN): void {
        const below = this.readStateStack(quest, run).levels.slice(0, -1);
        const file = this.stateFile(quest, run);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, stringifyProcessState(state, new Date().toISOString(), below), 'utf-8');
    }

    /** Write the whole stack of `run` (a level pushed or removed). */
    writeStateStack(quest: string, levels: readonly ProcessState[], run: string = DEFAULT_RUN): void {
        const file = this.stateFile(quest, run);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, stringifyProcessStateStack({ levels: [...levels] }, new Date().toISOString()), 'utf-8');
    }

    /**
     * The runs of `quest`, the last changed first: `default` always (its file
     * may not exist yet), every other run whose state file is there. `changed`
     * is the file's modification time (every move writes it), null without a file.
     */
    listRuns(quest: string): ProcessRunEntry[] {
        if (!quest) { return [{ run: DEFAULT_RUN, file: '', changed: null }]; }
        const dir = path.join(this.questsDir, quest);
        const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
        const runs: ProcessRunEntry[] = [];
        let hasDefault = false;
        for (const name of names) {
            const run = runOfStateFile(quest, name);
            if (run === null) { continue; }
            if (run === DEFAULT_RUN) { hasDefault = true; }
            const file = path.join(dir, name);
            runs.push({ run, file, changed: fs.statSync(file).mtime.toISOString() });
        }
        if (!hasDefault) { runs.push({ run: DEFAULT_RUN, file: this.stateFile(quest), changed: null }); }
        // The last changed first; never changed last, `default` before the others among those.
        return runs.sort((a, b) => (b.changed ?? '').localeCompare(a.changed ?? '')
            || Number(b.run === DEFAULT_RUN) - Number(a.run === DEFAULT_RUN) || a.run.localeCompare(b.run));
    }

    /** Whether `run` of `quest` has a state file (`default` always counts as there). */
    hasRun(quest: string, run: string): boolean {
        return run === DEFAULT_RUN || fs.existsSync(this.stateFile(quest, run));
    }

    /** Delete `run` of `quest` (its state file). `default` is refused. */
    deleteRun(quest: string, run: string): RepositoryResult {
        if (run === DEFAULT_RUN) { return { ok: false, error: 'the run "default" cannot be deleted' }; }
        const file = this.stateFile(quest, run);
        if (!fs.existsSync(file)) { return { ok: false, error: `the quest ${quest} has no run "${run}"` }; }
        fs.unlinkSync(file);
        return { ok: true };
    }
}

/** One run of a quest (ProcessRepository.listRuns). */
export interface ProcessRunEntry {
    run: string;
    /** Its state file ('' without a quest). */
    file: string;
    /** When its state file was last written (ISO), null when it has none yet. */
    changed: string | null;
}
