/**
 * The compaction and memory-extraction model pickers above the prompt queue
 * (dapieff13, DA-24): the Status Page's History Compaction choices and keys.
 *
 *   CP-1 the state: every Anthropic configuration (with its transport), then every Local LLM one; the chosen
 *        models encoded as the Status Page writes them; '' when none (a legacy shared pair still read)
 *   CP-2 the write: compaction.compactionModel / compaction.memoryExtractionModel; '' or a value no target reads
 *        clears it; nothing else in the config changes; false when nothing changed
 *   CP-3 the queue editor: both pickers drawn from the state with the Status Page's "not set" entry, the chosen
 *        one selected (a value without its configuration still shown); a change posts `setCompactionModel`;
 *        a new state (after a change on the Status Page) moves them
 *   CP-4 the hosts: the queue editor writes through setCompactionModel, saves, and refreshes the Status Page;
 *        the Status Page shows the same state (compactionPickerState) and refreshes the queue editor on save
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { compactionPickerState, setCompactionModel, type CompactionPickerConfig } from '../compactionTarget.js';

const ROOT = join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf-8');

const CONFIG = (): CompactionPickerConfig => ({
    compaction: { compactionModel: 'anthropic:haiku-agent', maxHistoryTokens: 10000 } as never,
    anthropic: { configurations: [{ id: 'haiku-agent', name: 'Haiku 5.5', transport: 'agentSdk' }, { id: 'opus-direct', name: 'Opus 5.5' }] },
    localLlm: { configurations: [{ id: 'qwen', name: 'Qwen 3' }] },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function editor(t: { after(fn: () => void): void }, state: Record<string, unknown>): { window: Win; posted: Array<Record<string, unknown>> } {
    const html = read('media', 'queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const window = dom.window as Win;
    t.after(() => window.close());
    const posted: Array<Record<string, unknown>> = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push({ ...m }), setState: () => undefined, getState: () => undefined });
    window.__INIT__ = { state: { items: [], autoSend: false, context: { quest: 'q', role: '', activeProjects: [] }, ...state } };
    window.eval([read('media', 'shared', 'queueEntryUtils.js'), read('media', 'shared', 'queueEntryRenderFunctions.js'),
        read('media', 'shared', 'queueEntryMessageHandlers.js'), read('media', 'queueEditor', 'main.js')].join('\n;\n'));
    return { window, posted };
}

describe('compaction model pickers above the queue', () => {
    test('CP-1: the state', () => {
        const s = compactionPickerState(CONFIG());
        assert.deepEqual(s.choices, [
            { value: 'anthropic:haiku-agent', label: 'Haiku 5.5 (Agent SDK)' },
            { value: 'anthropic:opus-direct', label: 'Opus 5.5 (direct API)' },
            { value: 'localLlm:qwen', label: 'Qwen 3 (Local LLM)' },
        ]);
        assert.deepEqual([s.compactionModel, s.memoryExtractionModel], ['anthropic:haiku-agent', '']);
        assert.equal(compactionPickerState({ compaction: { llmProvider: 'anthropic', llmConfigId: 'old' } }).memoryExtractionModel, 'anthropic:old', 'the legacy shared pair');
        assert.deepEqual(compactionPickerState(undefined), { compactionModel: '', memoryExtractionModel: '', choices: [] });
    });

    test('CP-2: the write', () => {
        const c = CONFIG();
        assert.equal(setCompactionModel(c, 'memory', 'localLlm:qwen'), true);
        assert.equal(c.compaction?.memoryExtractionModel, 'localLlm:qwen');
        assert.equal(setCompactionModel(c, 'memory', 'localLlm:qwen'), false, 'unchanged');
        assert.equal(setCompactionModel(c, 'compaction', ''), true);
        assert.equal('compactionModel' in (c.compaction ?? {}), false, "'' clears it");
        assert.equal(setCompactionModel(c, 'memory', 'nonsense'), true);
        assert.equal('memoryExtractionModel' in (c.compaction ?? {}), false, 'a value no target reads clears it');
        assert.equal((c.compaction as { maxHistoryTokens?: number }).maxHistoryTokens, 10000, 'the rest stays');
        const empty: CompactionPickerConfig = {};
        assert.equal(setCompactionModel(empty, 'compaction', 'anthropic:x'), true);
        assert.deepEqual(empty, { compaction: { compactionModel: 'anthropic:x' } });
    });

    test('CP-3: the queue editor', (t) => {
        const state = { ...compactionPickerState(CONFIG()), memoryExtractionModel: 'anthropic:gone' };
        const { window, posted } = editor(t, { compactionPickers: state });
        const pick = (id: string): Win => window.document.getElementById(id);
        assert.deepEqual([...pick('compactionModelPick').options].map((o: Win) => o.textContent),
            ['(not set — no compaction)', 'Haiku 5.5 (Agent SDK)', 'Opus 5.5 (direct API)', 'Qwen 3 (Local LLM)']);
        assert.equal(pick('compactionModelPick').value, 'anthropic:haiku-agent');
        assert.equal(pick('memoryModelPick').value, 'anthropic:gone');
        assert.match(pick('memoryModelPick').selectedOptions[0].textContent, /not configured/);
        assert.equal(pick('memoryModelPick').options[0].textContent, '(not set — no memory extraction)');
        pick('memoryModelPick').value = 'localLlm:qwen';
        pick('memoryModelPick').dispatchEvent(new window.Event('change'));
        assert.deepEqual(posted.pop(), { type: 'setCompactionModel', purpose: 'memory', value: 'localLlm:qwen' });
        window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'state', items: [], context: { quest: 'q', role: '', activeProjects: [] },
            compactionPickers: { ...state, compactionModel: 'anthropic:opus-direct', memoryExtractionModel: '' } } }));
        assert.deepEqual([pick('compactionModelPick').value, pick('memoryModelPick').value], ['anthropic:opus-direct', ''], 'a change elsewhere shows here');
    });

    test('CP-4: the hosts', () => {
        const queue = read('src', 'handlers', 'queueEditor-handler.ts');
        assert.match(queue, /case 'setCompactionModel': \{[\s\S]*?setCompactionModel\(config as unknown as CompactionPickerConfig, purpose,[\s\S]*?saveSendToChatConfig\(config\);[\s\S]*?refreshStatusPage\(\);[\s\S]*?sendState\(\);/);
        assert.match(queue, /compactionPickers: \(\(\) => \{\s*try \{ return compactionPickerState\(loadSendToChatConfig\(\)/);
        const status = read('src', 'handlers', 'statusPage-handler.ts');
        assert.match(status, /compactionPickerState\(sendToChatConfig as unknown as CompactionPickerConfig\)/);
        assert.match(status, /saveSendToChatConfig\(stcConfig\);\n\s+\/\/ The prompt queue editor shows the two model pickers too\.\n\s+void import\('\.\/queueEditor-handler\.js'\)\.then\(\(m\) => m\.refreshQueueEditorState\(\)\);/);
    });
});
