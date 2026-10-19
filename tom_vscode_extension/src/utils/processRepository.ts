/**
 * Process files on disk — fs only, no `vscode`, so it is tested against
 * temporary folders.
 *
 *   <processes>/<id>/<id>.process.yaml   the structure (processDefinition.ts)
 *   <processes>/<id>/<id>.md             the description
 *   <quests>/<quest>/process-state.<quest>.yaml   where that quest is
 *
 * `<processes>` is `_ai/processes`, `<quests>` is `_ai/quests`; both live in
 * the one shared `_ai` clone, so a quest's process state is the same on every
 * machine.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';

import {
    EMPTY_PROCESS_STATE,
    parseProcessState,
    parseProcessYaml,
    stringifyProcessDefinition,
    stringifyProcessState,
    validateProcessDefinition,
    type ProcessDefinition,
    type ProcessProblem,
    type ProcessState,
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

    stateFile(quest: string): string {
        return path.join(this.questsDir, quest, `process-state.${quest}.yaml`);
    }

    /** Where `quest` is; the empty state when it has no state file. */
    readState(quest: string): ProcessState {
        if (!quest) { return { ...EMPTY_PROCESS_STATE }; }
        const text = readText(this.stateFile(quest));
        return text ? parseProcessState(text) : { ...EMPTY_PROCESS_STATE };
    }

    writeState(quest: string, state: ProcessState): void {
        const file = this.stateFile(quest);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, stringifyProcessState(state, new Date().toISOString()), 'utf-8');
    }
}
