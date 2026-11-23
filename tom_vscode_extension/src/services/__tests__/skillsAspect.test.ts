/**
 * The skills list as an aspect (gsel21; guideline_sectioning.md D-13): `${skills-list}`, the aspect `skills`
 * (choice `all`, default), the send's value of the placeholder (services/skills.ts skillsListFor).
 *
 *   SA-1 `${skills-list}` resolves to the block the system prompt carried before (heading, instruction, one line
 *        per skill)
 *   SA-2 a direct send carrying tomAi_loadSkill with `skills: all` (the default) gets exactly that block in its
 *        system segment; without the tool, on the Agent SDK and on Copilot none (as before)
 *   SA-3 `skills` removed on a level: no skills list on direct and Agent SDK; tomAi_loadSkill still loads
 *   SA-4 the aspect in `_ai/aspect_guidelines/skills/` reads: placement system, default all, text `${skills-list}`
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import { listSkills, loadSkillImpl, skillsListFor, skillsSystemSection, SKILLS_LIST_PLACEHOLDER } from '../skills';
import { aspectsForSend, readAspectSections } from '../aspectGuidelinesStore';
import { resolveVariables } from '../../utils/variableResolver';
import type { AspectLevelChoices, AspectTransport } from '../../utils/aspectGuidelines';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-aspect-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const put = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
    fs.writeFileSync(path.join(base, rel), text);
};
const ws = path.join(base, 'ws');
put('ws/.claude/skills/review-pr/SKILL.md', '---\nname: review-pr\ndescription: Review a pull request.\n---\nSteps.\n');
put('ws/.claude/skills/release/SKILL.md', '---\nname: release\ndescription: Cut a release.\n---\nSteps.\n');
// The aspect as `_ai/aspect_guidelines/skills/` holds it.
/** The workspace's own `_ai/aspect_guidelines/skills/`, found above the extension (undefined outside a workspace). */
function liveAspect(): string | undefined {
    for (let dir = __dirname; dir !== path.dirname(dir); dir = path.dirname(dir)) {
        const candidate = path.join(dir, '_ai', 'aspect_guidelines', 'skills');
        if (fs.existsSync(path.join(candidate, 'aspect.yaml'))) { return candidate; }
    }
    return undefined;
}
const store = path.join(base, 'aspect_guidelines');
put('aspect_guidelines/skills/aspect.yaml', 'name: Skills\nplacement: system\ndefault: all\nchoices:\n  - all\n');
put('aspect_guidelines/skills/all.md', '${skills-list}\n');

const BLOCK = skillsSystemSection(listSkills(ws));

function send(transport: AspectTransport, tools: string[], choices: AspectLevelChoices = {}): string {
    const values = { workspaceFolder: ws, [SKILLS_LIST_PLACEHOLDER]: skillsListFor(transport, tools, ws) };
    return aspectsForSend(store, transport, { systemSegments: ['Profile.'], userContent: 'Go.' }, choices, (t) => resolveVariables(t, { values })).systemSegments.join('\n\n');
}

describe('the skills list as an aspect (gsel21)', () => {
    test('SA-1: ${skills-list}', () => {
        assert.match(BLOCK, /^## Skills\n\nSkills are task guides kept in `\.claude\/skills\/`\. When a task matches/);
        assert.match(BLOCK, /^- review-pr: Review a pull request\.$/m);
        assert.equal(resolveVariables('${skills-list}', { values: { workspaceFolder: ws } }), BLOCK, 'the placeholder alone: the block');
        assert.equal(resolveVariables('${skills-list}', { values: { workspaceFolder: path.join(base, 'none') } }), '', 'no skills: nothing');
    });

    test('SA-2: skills: all carries the block where it went before', () => {
        const direct = send('direct', ['tomAi_loadSkill', 'tomAi_readFile']);
        assert.ok(direct.includes(BLOCK), 'the same block');
        assert.equal(direct, `Profile.\n\n## Aspect guidelines\n\n### Skills: all\n\n${BLOCK}`);
        assert.equal(send('direct', ['tomAi_readFile']), 'Profile.', 'a send without tomAi_loadSkill: none, as before');
        assert.equal(send('agentSdk', ['tomAi_loadSkill']), 'Profile.', 'the Agent SDK loads skills itself: none, as before');
        assert.equal(send('localLlm', ['tomAi_loadSkill']).includes(BLOCK), true, 'the other own-loop transports: the block');
        assert.equal(skillsListFor('copilot', ['tomAi_loadSkill'], ws), '', 'Copilot: none');
        assert.equal(send('direct', ['tomAi_loadSkill'], { window: { skills: 'all' } }).includes(BLOCK), true, 'chosen explicitly: the same');
    });

    test('SA-3: skills removed carries none; tomAi_loadSkill still works', async () => {
        for (const level of ['workspace', 'questDefault', 'window', 'run', 'roleType', 'role', 'item', 'todo'] as const) {
            assert.equal(send('direct', ['tomAi_loadSkill'], { [level]: { skills: 'remove' } }), 'Profile.', `direct, removed on ${level}`);
            assert.equal(send('agentSdk', ['tomAi_loadSkill'], { [level]: { skills: 'remove' } }), 'Profile.', `Agent SDK, removed on ${level}`);
        }
        assert.match(await loadSkillImpl(ws, { name: 'release' }), /Cut a release/, 'the tool loads a skill either way');
    });

    test('SA-4: the aspect in _ai', () => {
        const live = liveAspect();
        const dir = live ? path.dirname(live) : store;
        const s = readAspectSections(dir).sections.find((x) => x.id === 'skills');
        assert.ok(s, 'the aspect skills exists');
        assert.deepEqual([s!.placement, s!.defaultOption, s!.options.map((o) => [o.name, o.text.trim()])], ['system', 'all', [['all', '${skills-list}']]]);
    });
});
