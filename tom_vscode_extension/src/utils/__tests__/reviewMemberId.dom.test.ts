/**
 * Team review: the current user's member id (ccparity_f_teamreview-1; src/utils/reviewAuthors.ts reviewMemberId,
 * the MD Browser, the Status Page's Team review section).
 *
 *   RM-1 the setting: `review.memberId` read as a member id (`[a-z0-9_]+`, trimmed); anything else is unset
 *   RM-2 the MD Browser marks the user's own lines: comment blocks they wrote, marks attributed to them
 *        (`{@id}`), individual answers listing them (`**Answer (alexis, bob):**`); nobody else's; nothing
 *        without a member id; the Whose list says "(you)"
 *   RM-3 the MD Browser host signs comments with the member id (else the OS user) and sends it to the webview
 *   RM-4 the Status Page: a Team review section with the member id; Save posts it; the host stores
 *        `review.memberId` (a bad id refused, empty removes it); schema and config type say the same
 *   RM-5 the spec tools: tomAi_specSetAnswer and the marked edits take `author`, defaulting to the member id
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { REVIEW_MEMBER_ID_PATTERN, reviewMemberId } from '../reviewAuthors.js';

const ROOT = join(__dirname, '..', '..', '..');
const asset = (file: string): string => readFileSync(join(ROOT, 'media', 'markdownBrowser', file), 'utf-8');
const src = (...p: string[]): string => readFileSync(join(ROOT, 'src', ...p), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function browser(): Win {
    const body = asset('index.html').split('<body>')[1].split('<script')[0].replace(/\{\{[a-zA-Z]+\}\}/g, '');
    const w = new JSDOM(`<!DOCTYPE html><head><style>${asset('style.css')}</style></head><body>${body}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true }).window as Win;
    w.acquireVsCodeApi = () => ({ postMessage: () => undefined, setState: () => undefined });
    w.eval(readFileSync(join(ROOT, 'node_modules', 'marked', 'lib', 'marked.umd.js'), 'utf-8'));
    w.eval(readFileSync(join(ROOT, 'media', 'shared', 'mdOverlay.js'), 'utf-8'));
    w.eval(readFileSync(join(ROOT, 'media', 'shared', 'mdQuestions.js'), 'utf-8'));
    w.eval(asset('blocks.js'));
    w.eval(asset('teamReview.js'));
    w.eval(asset('main.js'));
    return w;
}
const show = (w: Win, text: string, memberId?: string): void => {
    w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'mdContent', content: text, filePath: '/ws/review.md', relativePath: 'review.md', crlf: false, ...(memberId !== undefined ? { memberId } : {}) } }));
};

const DOC = [
    '# Review',
    '',
    'The retention period is {~~30~>15~~}{@alexis} days, archived {~~monthly~>weekly~~}{@bob}.',
    '',
    '> ⬆️ **C-1** (alexis): mine',
    '',
    '> ⬆️ **C-2** (bob): his',
    '',
    '> **❓ BQ-1 — retention:** How long?',
    '> - (a) 30 days',
    '> - **(b)** 15 days',
    '>',
    '> **Answer (alexis, bob):** (b)',
    '>',
    '> **Answer (carol):** (a)',
    '>',
    '> **Answer:** (b)',
    '',
].join('\n');

describe('team review: the user\'s member id', () => {
    test('RM-1: the setting', () => {
        assert.equal(reviewMemberId({ review: { memberId: ' alexis ' } }), 'alexis');
        for (const bad of ['Alexis', 'a-b', 'a b', '', 7]) {
            assert.equal(reviewMemberId({ review: { memberId: bad } }), '', String(bad));
        }
        assert.equal(reviewMemberId(null), '');
        assert.equal(REVIEW_MEMBER_ID_PATTERN.test('agent_spec_author'), true);
    });

    test('RM-2: the MD Browser marks the user\'s own lines', () => {
        const w = browser();
        try {
            show(w, DOC, 'alexis');
            const own = [...w.document.querySelectorAll('.mdb-own')];
            const texts = own.map((el: Win) => el.textContent.trim());
            assert.ok(texts.some((t: string) => /C-1.*mine/.test(t)), `the comment: ${JSON.stringify(texts)}`);
            assert.ok(!texts.some((t: string) => /C-2/.test(t)), 'not bob\'s comment');
            assert.ok(own.some((el: Win) => el.matches('.mdb-rm') && /30|15/.test(el.textContent)), 'the mark attributed to alexis');
            assert.ok(!own.some((el: Win) => el.matches('.mdb-rm') && /monthly|weekly/.test(el.textContent)), 'not bob\'s mark');
            assert.ok(texts.some((t: string) => /^Answer \(alexis, bob\):/.test(t)), 'the shared answer line');
            assert.ok(!texts.some((t: string) => /Answer \(carol\)/.test(t) || /^Answer: \(b\)$/.test(t)), 'not carol\'s, not the team answer');
            const whose = w.document.getElementById('navAuthors');
            if (whose) {
                w.document.getElementById('navKindBtn')?.click();
                assert.match(whose.textContent, /alexis \(you\)/);
            }
            show(w, DOC, '');
            assert.equal(w.document.querySelectorAll('.mdb-own').length, 0, 'no member id: nothing marked');
        } finally { w.close(); }
    });

    test('RM-3: the MD Browser host', () => {
        const host = src('handlers', 'markdownBrowser-handler.ts');
        assert.match(host, /author: reviewMemberId\(loadSendToChatConfig\(\)\) \|\| currentCommentAuthor\(COMMENT_AUTHOR_FORM\),\s*memberId: reviewMemberId\(loadSendToChatConfig\(\)\),/);
    });

    test('RM-4: the Status Page', () => {
        const sp = src('handlers', 'statusPage-handler.ts');
        assert.match(sp, /data-collapse="teamReview"[\s\S]{0,1600}id="sp-review-memberId" value="\$\{escapeHtml\(status\.reviewMemberId\)\}"[\s\S]{0,200}data-status-action="updateReviewMemberId"/);
        assert.match(sp, /case 'updateReviewMemberId': \{[\s\S]{0,300}REVIEW_MEMBER_ID_PATTERN\.test\(id\)[\s\S]{0,500}stcConfig\.review = \{ \.\.\.\(stcConfig\.review \?\? \{\}\), memberId: id \}; \} else \{ delete stcConfig\.review; \}/);
        assert.match(readFileSync(join(ROOT, 'media', 'statusPage', 'listeners.js'), 'utf8'), /action === 'updateReviewMemberId'\) \{\s*msgData\.memberId = \(document\.getElementById\('sp-review-memberId'\)/);
        const schema = JSON.parse(src('config', 'tom_vscode_extension.schema.json'));
        assert.equal(schema.properties.review.properties.memberId.pattern, '^[a-z0-9_]*$');
        assert.match(src('utils', 'sendToChatConfig.ts'), /review\?: \{ memberId\?: string \};/);
    });

    test('RM-5: the spec tools', () => {
        const annotations = src('tools', 'spec-annotation-tools.ts');
        assert.match(annotations, /const author = memberAuthorFor\(deps, input\.author\);\s*notes\.setAnswer\(id, input\.answer, author \? \{ author \} : \{\}\);/);
        const edits = src('tools', 'spec-edit-tools.ts');
        assert.equal((edits.match(/writeMarked\(ctx, input\.path, [^)]*, memberAuthorFor\(deps, input\.author\)\)/g) ?? []).length, 2, 'setContent and setFormField');
        assert.match(src('tools', 'spec-tool-common.ts'), /memberAuthor: \(\) => \{[\s\S]{0,300}reviewMemberId\(loadSendToChatConfig\(\)\)/);
    });
});
