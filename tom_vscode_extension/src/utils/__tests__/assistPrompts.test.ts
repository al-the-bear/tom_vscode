/**
 * The Assist prompts (ccparity_i_assist-3): one template category, the
 * template each use runs chosen on the Status Page (src/utils/assistPrompts.ts).
 *
 *   AP-1 each use resolves its chosen template; without a choice (or with one that is gone) its default template;
 *        without that the built-in text
 *   AP-2 filling: the use's placeholders once (a value is never expanded again), a missing value empty, another
 *        use's placeholder left as written
 *   AP-3 the five defaults are seeded by id, once, an edited one kept, the choices untouched
 *   AP-4 the out-of-budget prompt is the template's: the built-in default is the text the code built (stopped
 *        profile, model, session, time, message, live trail, original prompt); a chosen template replaces it;
 *        the queue passes the config's section
 *   AP-5 the three prompts that write a note (Explain in detail, Explain a decision, Grill me at a decision) ask
 *        for every file as a Markdown link relative to the note, which the MD Browser follows; a default still
 *        holding the text without that rule is brought to the current one
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    ASSIST_PROMPT_INFO, ASSIST_PROMPT_USES, buildAssistPrompt, ensureDefaultAssistPrompts, fillAssistPrompt, resolveAssistPrompt,
    type AssistPromptsSection,
} from '../assistPrompts';
import { outOfBudgetPrompt, type OutOfBudgetMark } from '../outOfBudget';

const ROOT = join(__dirname, '..', '..', '..');

describe('Assist prompts', () => {
    test('AP-1: each use resolves its chosen template', () => {
        assert.deepEqual([...ASSIST_PROMPT_USES], ['grillMe', 'explainInDetail', 'explainDecision', 'grillMeDecision', 'finishReviewRound', 'outOfBudget']);
        assert.deepEqual(ASSIST_PROMPT_USES.map((u) => ASSIST_PROMPT_INFO[u].label),
            ['Grill me', 'Explain in detail', 'Explain a decision', 'Grill me at a decision', 'Finish review round', 'Out of budget']);
        const config: { assistPrompts?: AssistPromptsSection } = {};
        ensureDefaultAssistPrompts(config);
        const section = config.assistPrompts!;
        for (const use of ASSIST_PROMPT_USES) {
            // No choice: the use's default template.
            const d = resolveAssistPrompt(section, use);
            assert.deepEqual([d.id, d.source, d.template], [ASSIST_PROMPT_INFO[use].defaultId, 'default', ASSIST_PROMPT_INFO[use].defaultBody], use);
            // A chosen template.
            section.templates!.push({ id: `${use}-mine`, name: `Mine for ${use}`, template: `my ${use}` });
            (section.selected ??= {})[use] = `${use}-mine`;
        }
        for (const use of ASSIST_PROMPT_USES) {
            const r = resolveAssistPrompt(section, use);
            assert.deepEqual([r.id, r.name, r.template, r.source], [`${use}-mine`, `Mine for ${use}`, `my ${use}`, 'selected'], use);
        }
        // A choice whose template is gone: the default again; no templates at all: the built-in text.
        assert.equal(resolveAssistPrompt({ selected: { grillMe: 'gone' }, templates: section.templates }, 'grillMe').source, 'default');
        const builtIn = resolveAssistPrompt(undefined, 'explainDecision');
        assert.deepEqual([builtIn.id, builtIn.source, builtIn.template], ['explain-decision', 'builtIn', ASSIST_PROMPT_INFO.explainDecision.defaultBody]);
    });

    test('AP-2: filling the placeholders', () => {
        const body = 'Q ${questionId} in ${file}: ${questionBlock} | ${noteFile} | ${quest}';
        assert.equal(
            fillAssistPrompt('grillMe', body, { questionId: 'CC-1', file: 'a.md', questionBlock: 'has ${questionId} inside' }),
            'Q CC-1 in a.md: has ${questionId} inside | ${noteFile} | ${quest}',
            'once; another use\'s placeholder and the prompt\'s own stay');
        assert.equal(fillAssistPrompt('grillMe', '[${file}]', {}), '[]', 'a missing value is empty');
        assert.equal(buildAssistPrompt({ selected: { finishReviewRound: 'x' }, templates: [{ id: 'x', name: 'X', template: 'Finish ${step} of ${process}' }] },
            'finishReviewRound', { step: 's2', process: 'tom_specs' }), 'Finish s2 of tom_specs');
        // Every default uses only its own placeholders.
        for (const use of ASSIST_PROMPT_USES) {
            const used = [...ASSIST_PROMPT_INFO[use].defaultBody.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]);
            assert.ok(used.length > 0, use);
            for (const p of used) { assert.ok(p in ASSIST_PROMPT_INFO[use].placeholders, `${use}: \${${p}} is declared`); }
        }
    });

    test('AP-3: seeding the defaults', () => {
        const config: { assistPrompts?: AssistPromptsSection } = { assistPrompts: { selected: { grillMe: 'mine' }, templates: [{ id: 'grill-me', name: 'Grill me', template: 'edited' }] } };
        assert.equal(ensureDefaultAssistPrompts(config), true);
        assert.deepEqual(config.assistPrompts!.templates!.map((t) => t.id), ['grill-me', 'explain-in-detail', 'explain-decision', 'grill-me-decision', 'finish-review-round', 'out-of-budget']);
        assert.equal(config.assistPrompts!.templates![0].template, 'edited', 'an existing one is kept');
        assert.deepEqual(config.assistPrompts!.selected, { grillMe: 'mine' }, 'the choices stay');
        assert.equal(ensureDefaultAssistPrompts(config), false, 'once');
        const seeded = src('src', 'extension.ts');
        assert.match(seeded, /if \(ensureDefaultAssistPrompts\(stcConfig\)\)/, 'seeded at activation');
    });

    test('AP-5: notes link their files', () => {
        for (const use of ['explainInDetail', 'explainDecision', 'grillMeDecision'] as const) {
            const body = ASSIST_PROMPT_INFO[use].defaultBody;
            assert.match(body, /Name every file as a Markdown link relative to the note/, use);
            // The text before the rule, as a workspace seeded it: seeding replaces it.
            const before = body.replace(/\n {3}Name every file as a Markdown link[^\n]*/, '');
            assert.notEqual(before, body);
            const config: { assistPrompts?: AssistPromptsSection } = {
                assistPrompts: { templates: [{ id: ASSIST_PROMPT_INFO[use].defaultId, name: 'x', template: before }] },
            };
            ensureDefaultAssistPrompts(config);
            const seeded = config.assistPrompts!.templates!.find((t) => t.id === ASSIST_PROMPT_INFO[use].defaultId)!;
            assert.equal(seeded.template, body, `${use}: an unedited earlier default is replaced`);
        }
    });

    test('AP-4: the out-of-budget prompt is the template\'s', () => {
        const mark: OutOfBudgetMark = {
            profileId: 'opus-direct', profileName: 'Opus — Direct', model: 'claude-opus-5-5', session: 'p2',
            message: 'Your credit balance is too low.', at: '2026-11-07T10:00:00.000Z',
        };
        const opts = { quest: 'q', toProfileName: 'Opus — SDK', runsInSession: 'default', originalPrompt: 'Do todo x' };
        const builtIn = outOfBudgetPrompt(mark, opts);
        assert.equal(builtIn, [
            '**Out of budget — continuing on profile "Opus — SDK".**',
            '',
            'The prompt below was running on profile "Opus — Direct" (opus-direct, model claude-opus-5-5) in session "p2" and stopped at 2026-11-07T10:00:00.000Z: Your credit balance is too low.',
            'It is sent again on profile "Opus — SDK". It runs in session "default": session "p2" keeps its conversation where profile "Opus — SDK" cannot continue it.',
            '',
            'What the stopped run had already done is in that session\'s live trail, `_ai/quests/q/history/sessions/p2/live-trail.md`; changes it made and did not commit are in the working trees (`git status`). Read them first and continue the work from where it stopped — do not start it over.',
            '',
            '---',
            '',
            'Do todo x',
        ].join('\n'));
        assert.equal(outOfBudgetPrompt(mark, opts, { templates: [] }), builtIn, 'no template: the built-in text');
        const chosen: AssistPromptsSection = {
            selected: { outOfBudget: 'short' },
            templates: [{ id: 'short', name: 'Short', template: '${stoppedProfile}/${stoppedModel}/${stoppedSession}/${stoppedAt}/${budgetMessage}/${liveTrail} → ${toProfile}\n${originalPrompt}' }],
        };
        assert.equal(outOfBudgetPrompt(mark, opts, chosen),
            'Opus — Direct/claude-opus-5-5/p2/2026-11-07T10:00:00.000Z/Your credit balance is too low./`_ai/quests/q/history/sessions/p2/live-trail.md` → Opus — SDK\nDo todo x');
        assert.match(outOfBudgetPrompt({ ...mark, model: undefined }, opts), /\(opus-direct, model unknown\)/);
        assert.match(src('src', 'managers', 'promptQueueManager.ts'), /originalPrompt: resolveResendText\(last, item\.expandedText\),\n {8}\}, config\?\.assistPrompts\);/);
    });
});

function src(...p: string[]): string {
    return readFileSync(join(ROOT, ...p), 'utf-8');
}
