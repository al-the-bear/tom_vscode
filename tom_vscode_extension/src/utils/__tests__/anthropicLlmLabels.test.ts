/**
 * The ANTHROPIC/LLM labels (CC-46 (a)): what the user reads says ANTHROPIC/LLM,
 * the ids underneath keep `anthropic`.
 *
 *   AL-1 the @CHAT subpanel is titled Anthropic/LLM (shown upper-case by the accordion), its section id `anthropic`
 *   AL-2 the Status Page sections say Anthropic/LLM; no section title says plain Anthropic
 *   AL-3 the SESSIONS view says the `chat` session is the ANTHROPIC/LLM panel's; a command title names
 *        Anthropic only as the panel, "Anthropic/LLM" (the Send to Anthropic/LLM commands)
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { IMPLICIT_SESSIONS } from '../sessionsViewRows.js';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('ANTHROPIC/LLM labels', () => {
    test('AL-1: the @CHAT subpanel', () => {
        const main = read('media/chatPanel/main.js');
        assert.match(main, /\{ id: 'anthropic', icon: '[^']*', title: 'Anthropic\/LLM' \}/);
        assert.match(read('media/shared/accordion.css'), /\.header-expanded \.title \{[^}]*text-transform: uppercase/);
        assert.match(read('media/shared/accordion.css'), /\.header-collapsed \.title \{[^}]*text-transform: uppercase/);
    });

    test('AL-2: the Status Page sections', () => {
        const titles = [...read('src/handlers/statusPage-handler.ts').matchAll(/class="sp-section-title">(.*?)<\/span>\s*$/gm)].map((m) => m[1]);
        assert.ok(titles.some((t) => t.includes('🔁 Anthropic/LLM Transport Retry')));
        assert.ok(titles.some((t) => t.includes('🤖 Anthropic/LLM — Configurations')));
        assert.deepEqual(titles.filter((t) => /Anthropic(?!\/LLM)/.test(t)), []);
    });

    test('AL-3: the SESSIONS view and the commands', () => {
        assert.equal(IMPLICIT_SESSIONS.find((r) => r.name === 'chat')?.usedBy, 'the ANTHROPIC/LLM panel');
        const pkg = JSON.parse(read('package.json'));
        const titles = (pkg.contributes.commands as Array<{ title: string }>).map((c) => c.title);
        const bare = titles.filter((t) => /anthropic/i.test(t.replace(/Anthropic\/LLM/g, '')));
        assert.deepEqual(bare, [], 'Anthropic only as the panel name Anthropic/LLM');
        assert.ok(titles.includes('@T: Send to Anthropic/LLM'));
    });
});
