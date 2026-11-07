/**
 * Skills for every transport (ccparity_d_claudecode-1, CC-10 (a)):
 * `.claude/skills/<name>/SKILL.md` — name, description, allowed tools — read
 * from the workspace and its parent folders. On direct, Local LLM and VS Code
 * LM each skill's name and description go into the system prompt and
 * `tomAi_loadSkill` returns a skill's SKILL.md and lists its files; the Agent
 * SDK keeps its own Skill tool.
 *
 *   SK-1 discovery over a fixture workspace: name and description from the frontmatter, allowed tools as a
 *        string or a list; the workspace's own skills first; a nearer skill masks an ancestor's of the same
 *        name; a folder without SKILL.md is none; a symlinked skill folder counts; a SKILL.md without
 *        frontmatter is listed by its folder name with its first line as description
 *   SK-2 the system-prompt section: every skill's name and description, how to load one; empty without skills;
 *        a long description is cut
 *   SK-3 tomAi_loadSkill: the whole SKILL.md, the folder's absolute path, its files (sub-folders included,
 *        relative, sorted), the allowed tools; an unknown name lists the skills there are
 *   SK-4 the wiring: the tool is registered, selectable, categorised and core (never deferred); the section is
 *        added on direct / Local LLM / VS Code LM only and only when the send carries the tool; on the Agent
 *        SDK the tool is a duplicate of its own Skill tool; the panel's /skill completion uses the same store
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';
import { listSkills, skillsSystemSection, loadSkillImpl, SKILL_DESCRIPTION_MAX_CHARS } from '../../services/skills.js';
import { AVAILABLE_LLM_TOOLS } from '../../utils/constants.js';
import { categorizeTools } from '../../utils/toolCategories.js';
import { DEFAULT_CORE_TOOLS } from '../../utils/toolSelection.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
const ws = path.join(base, 'parent', 'workspace');
const write = (rel: string, text: string): void => {
    const abs = path.join(base, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
};

write('parent/workspace/.claude/skills/review-pr/SKILL.md', [
    '---',
    'name: review-pr',
    'description: Review a pull request against the workspace guidelines.',
    'allowed-tools: tomAi_gitRead, tomAi_readFile',
    '---',
    '',
    '# Review a PR',
    '',
    'Read `checklist.md` first.',
    '',
].join('\n'));
write('parent/workspace/.claude/skills/review-pr/checklist.md', '- tests\n');
write('parent/workspace/.claude/skills/review-pr/scripts/diff.sh', 'git diff\n');
write('parent/workspace/.claude/skills/release/SKILL.md', [
    '---', 'name: release', 'description: Cut a release.', 'allowed-tools:', '  - tomAi_runCommand', '  - tomAi_gitWrite', '---', 'Steps.',
].join('\n'));
write('parent/workspace/.claude/skills/plain/SKILL.md', 'Plain skill without frontmatter.\n\nMore text.\n');
write('parent/workspace/.claude/skills/not-a-skill/README.md', 'no SKILL.md here\n');
write('parent/.claude/skills/release/SKILL.md', '---\nname: release\ndescription: The ancestor one, masked.\n---\n');
write('parent/.claude/skills/fleet-sync/SKILL.md', `---\nname: fleet-sync\ndescription: ${'x'.repeat(SKILL_DESCRIPTION_MAX_CHARS + 50)}\n---\n`);
write('elsewhere/linked/SKILL.md', '---\nname: linked\ndescription: Reached through a symlink.\n---\n');
fs.symlinkSync(path.join(base, 'elsewhere', 'linked'), path.join(ws, '.claude', 'skills', 'linked'));

describe('skills', () => {
    test('SK-1: discovery', () => {
        const skills = listSkills(ws);
        const names = skills.map((s) => s.name);
        assert.deepEqual(names.slice(0, 4), ['linked', 'plain', 'release', 'review-pr'], 'the workspace\'s own first, by name');
        assert.ok(names.includes('fleet-sync'), 'an ancestor\'s skill');
        assert.ok(!names.includes('not-a-skill'));
        assert.equal(names.filter((n) => n === 'release').length, 1);
        const byName = new Map(skills.map((s) => [s.name, s]));
        assert.equal(byName.get('release')!.description, 'Cut a release.', 'the nearer one masks the ancestor\'s');
        assert.deepEqual(byName.get('release')!.allowedTools, ['tomAi_runCommand', 'tomAi_gitWrite']);
        assert.deepEqual(byName.get('review-pr')!.allowedTools, ['tomAi_gitRead', 'tomAi_readFile']);
        assert.equal(byName.get('review-pr')!.description, 'Review a pull request against the workspace guidelines.');
        assert.equal(byName.get('plain')!.description, 'Plain skill without frontmatter.');
        assert.equal(byName.get('linked')!.description, 'Reached through a symlink.');
        assert.equal(byName.get('fleet-sync')!.direct, false);
        assert.equal(byName.get('review-pr')!.direct, true);
    });

    test('SK-2: the system-prompt section', () => {
        const section = skillsSystemSection(listSkills(ws));
        assert.match(section, /^## Skills/);
        assert.match(section, /tomAi_loadSkill/);
        assert.match(section, /^- review-pr: Review a pull request against the workspace guidelines\.$/m);
        assert.match(section, /^- release: Cut a release\.$/m);
        const fleet = section.split('\n').find((l) => l.startsWith('- fleet-sync:'))!;
        assert.ok(fleet.length <= '- fleet-sync: '.length + SKILL_DESCRIPTION_MAX_CHARS + 1, 'a long description is cut');
        assert.match(fleet, /…$/);
        assert.equal(skillsSystemSection([]), '');
    });

    test('SK-3: tomAi_loadSkill', async () => {
        const text = await withTiming('tomAi_loadSkill:typical', () => loadSkillImpl(ws, { name: 'review-pr' }));
        const skillDir = path.join(ws, '.claude', 'skills', 'review-pr');
        assert.ok(text.includes(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')), 'the whole SKILL.md');
        assert.ok(text.includes(skillDir), 'the folder');
        assert.match(text, /Files:\n- SKILL\.md\n- checklist\.md\n- scripts\/diff\.sh/);
        assert.match(text, /Allowed tools: tomAi_gitRead, tomAi_readFile/);
        const unknown = await loadSkillImpl(ws, { name: 'nope' });
        assert.match(unknown, /No skill "nope"/);
        assert.match(unknown, /review-pr/);
        const linked = await loadSkillImpl(ws, { name: 'linked' });
        assert.match(linked, /Reached through a symlink/);
    });

    test('SK-4: the wiring', () => {
        assert.ok((AVAILABLE_LLM_TOOLS as readonly string[]).includes('tomAi_loadSkill'), 'selectable');
        assert.deepEqual(categorizeTools(['tomAi_loadSkill']).map((g) => g.category), ['Skills'], 'categorised');
        assert.ok(DEFAULT_CORE_TOOLS.includes('tomAi_loadSkill'), 'core: never deferred');
        const src = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', rel), 'utf8');
        assert.match(src('tools/tool-executors.ts'), /\.\.\.SKILL_TOOLS/);
        const handler = src('handlers/anthropic-handler.ts');
        assert.match(handler, /'tomAi_loadSkill',/, 'a duplicate of the Agent SDK\'s own Skill tool');
        assert.match(handler, /transport !== 'agentSdk' && tools\.some\(\(t\) => t\.name === LOAD_SKILL_TOOL_NAME\)/);
        assert.match(handler, /systemSegments\.push\(skillsSection\)/);
        assert.match(src('handlers/completion-picker.ts'), /fsSkillStore\(/);
    });
});
