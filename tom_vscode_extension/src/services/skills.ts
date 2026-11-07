/**
 * Skills for every transport (CC-10 (a)).
 *
 * A skill is Claude Code's `.claude/skills/<name>/SKILL.md`: YAML frontmatter
 * (`name`, `description`, `allowed-tools`) and a Markdown body, with any
 * supporting files beside it. The Agent SDK loads them itself (its Skill
 * tool). For direct, Local LLM and VS Code LM the handler puts each skill's
 * name and description into the system prompt ({@link skillsSystemSection})
 * and `tomAi_loadSkill` ({@link loadSkillImpl}) returns a skill's SKILL.md and
 * lists its files, which the model then reads with `tomAi_readFile`.
 *
 * Skills are found as the panel's `/skill` completion finds them
 * ({@link discoverSkills}): in the workspace's own `.claude/skills/` and in
 * every parent folder's, the nearest skill of a name winning. A skill folder
 * may be a symlink.
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';
import { frontmatterList, frontmatterString, firstProseLine, splitFrontmatter } from './claudeDirs';
import { discoverSkills, type SkillStore } from './completion-service';

/** The tool that loads a skill (named in the system-prompt section). */
export const LOAD_SKILL_TOOL_NAME = 'tomAi_loadSkill';

/** Longest description the system-prompt section carries per skill. */
export const SKILL_DESCRIPTION_MAX_CHARS = 300;

/** Most files `tomAi_loadSkill` lists for one skill. */
const MAX_LISTED_FILES = 200;

/** A skill as the system prompt and `tomAi_loadSkill` see it. */
export interface SkillInfo {
    name: string;
    description: string;
    /** The frontmatter's `allowed-tools`, as written (string or list). */
    allowedTools: string[];
    /** Absolute folder of the skill. */
    dir: string;
    /** True when it lives in the workspace's own `.claude/skills/`. */
    direct: boolean;
}

/** A `.claude/skills` folder on disk: its skill folders (symlinks followed) that hold a SKILL.md. */
export function fsSkillStore(wsRoot: () => string | null): SkillStore {
    return {
        wsRoot,
        listSkillFolders(claudeSkillsDir: string): string[] {
            let names: string[];
            try { names = fs.readdirSync(claudeSkillsDir); } catch { return []; }
            return names.filter((name) => {
                try {
                    return fs.statSync(path.join(claudeSkillsDir, name)).isDirectory()
                        && fs.statSync(path.join(claudeSkillsDir, name, 'SKILL.md')).isFile();
                } catch {
                    return false;
                }
            });
        },
    };
}

/** SKILL.md split into its frontmatter fields and body. */
export function parseSkillFile(text: string): { name?: string; description?: string; allowedTools: string[]; body: string } {
    const { meta, body } = splitFrontmatter(text);
    return {
        name: frontmatterString(meta.name),
        description: frontmatterString(meta.description),
        allowedTools: frontmatterList(meta['allowed-tools'] ?? meta.allowedTools) ?? [],
        body,
    };
}

/** Every skill visible from the workspace: its own first, then by name. */
export function listSkills(wsRoot: string): SkillInfo[] {
    return discoverSkills(fsSkillStore(() => wsRoot), '').map((found) => {
        const dir = path.join(found.skillsDir, found.name);
        let text = '';
        try { text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'); } catch { /* listed, unreadable */ }
        const parsed = parseSkillFile(text);
        return {
            name: found.name,
            description: parsed.description ?? firstProseLine(parsed.body),
            allowedTools: parsed.allowedTools,
            dir,
            direct: found.direct,
        };
    });
}

/**
 * The system-prompt section naming every skill and how to load one; `''`
 * without skills. One line per skill, its description cut at
 * {@link SKILL_DESCRIPTION_MAX_CHARS}.
 */
export function skillsSystemSection(skills: readonly SkillInfo[]): string {
    if (skills.length === 0) { return ''; }
    const lines = skills.map((s) => {
        const one = s.description.replace(/\s+/g, ' ');
        const description = one.length > SKILL_DESCRIPTION_MAX_CHARS ? `${one.slice(0, SKILL_DESCRIPTION_MAX_CHARS)}…` : one;
        return `- ${s.name}: ${description}`;
    });
    return [
        '## Skills',
        '',
        `Skills are task guides kept in \`.claude/skills/\`. When a task matches a skill's description, call \`${LOAD_SKILL_TOOL_NAME}\` with its name first and follow what it says; read the files it lists with \`tomAi_readFile\` when it points to them.`,
        '',
        ...lines,
    ].join('\n');
}

/** The files of a skill folder, relative, sorted, sub-folders included (symlinks followed once). */
function listFiles(dir: string): string[] {
    const out: string[] = [];
    const walk = (rel: string, depth: number): void => {
        if (out.length >= MAX_LISTED_FILES || depth > 8) { return; }
        let names: string[];
        try { names = fs.readdirSync(path.join(dir, rel)).sort(); } catch { return; }
        for (const name of names) {
            if (name.startsWith('.')) { continue; }
            const relPath = rel ? `${rel}/${name}` : name;
            let stat: fs.Stats;
            try { stat = fs.statSync(path.join(dir, relPath)); } catch { continue; }
            if (stat.isDirectory()) { walk(relPath, depth + 1); } else { out.push(relPath); }
            if (out.length >= MAX_LISTED_FILES) { return; }
        }
    };
    walk('', 0);
    return out.sort((a, b) => (a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a.localeCompare(b)));
}

export interface LoadSkillInput {
    name: string;
}

/**
 * `tomAi_loadSkill`: the skill's folder, its allowed tools, its files and its
 * whole SKILL.md. An unknown name answers the skills there are.
 */
export async function loadSkillImpl(wsRoot: string, input: LoadSkillInput): Promise<string> {
    const wanted = (input.name ?? '').trim().replace(/^\//, '');
    const skills = listSkills(wsRoot);
    const skill = skills.find((s) => s.name === wanted);
    if (!skill) {
        const names = skills.map((s) => s.name).join(', ');
        return `No skill "${wanted}". ${names ? `Skills: ${names}.` : 'There are no skills in .claude/skills/ here.'}`;
    }
    let text: string;
    try {
        text = await fs.promises.readFile(path.join(skill.dir, 'SKILL.md'), 'utf8');
    } catch (err) {
        return `Error reading the SKILL.md of "${skill.name}": ${(err as Error).message}`;
    }
    const files = listFiles(skill.dir);
    return [
        `Skill: ${skill.name}`,
        `Folder: ${skill.dir}`,
        `Allowed tools: ${skill.allowedTools.length > 0 ? skill.allowedTools.join(', ') : '(not stated)'}`,
        `Files:\n${files.map((f) => `- ${f}`).join('\n')}${files.length >= MAX_LISTED_FILES ? `\n(first ${MAX_LISTED_FILES} files)` : ''}`,
        '',
        '--- SKILL.md ---',
        text,
    ].join('\n');
}
