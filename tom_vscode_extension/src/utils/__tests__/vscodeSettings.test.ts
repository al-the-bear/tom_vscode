/**
 * The extension's VS Code settings (`tomAi.*`, package.json `contributes.configuration`) and their readers.
 *
 *   SR-1 every contributed setting has a reader in `src/` (`.get('<key>')` / `get<…>('<key>')`)
 *   SR-2 every `tomAi.*` key the code reads is contributed — except `panelStoragePath`, read but not contributed
 *        (qrfix8 decides it)
 *   SR-3 the settings the extension tunes with (src/utils/vscodeSettings.ts): the bridge's request timeout, restart
 *        delay and restart limit, the timer tick, the Guidelines exclusions — their defaults, bounds and the
 *        restart rule (restarts in a row below the limit: the delay; at the limit: none)
 *   SR-4 the removed settings stay removed (no reader, no contribution), and the readers are wired where the
 *        settings say: the bridge client, the timed-request engine, the Guidelines panel's Project list
 */

/* eslint-disable @typescript-eslint/naming-convention -- the keys are setting names (`bridge.requestTimeout`) */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { bridgeSettings, guidelinesExcludeGlobs, nextBridgeRestart, timerTickIntervalMs, TIMER_TICK_DEFAULT_MS } from '../vscodeSettings.js';

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

/** The contributed `tomAi.*` keys, without the `tomAi.` prefix. */
function contributed(): string[] {
    const pkg = JSON.parse(read('package.json'));
    const sections = Array.isArray(pkg.contributes.configuration) ? pkg.contributes.configuration : [pkg.contributes.configuration];
    return sections.flatMap((s: { properties?: Record<string, unknown> }) => Object.keys(s.properties ?? {}))
        .filter((k: string) => k.startsWith('tomAi.')).map((k: string) => k.slice('tomAi.'.length));
}

/** The non-test TypeScript sources of `src/`. */
function sources(): Array<{ file: string; text: string }> {
    const out: Array<{ file: string; text: string }> = [];
    const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { if (e.name !== '__tests__') { walk(p); } } else if (e.name.endsWith('.ts')) { out.push({ file: p, text: fs.readFileSync(p, 'utf-8') }); }
        }
    };
    walk(path.join(ROOT, 'src'));
    return out;
}

/** The keys read as `get('<key>')` / `get<T>('<key>')` in the files that read the `tomAi` settings. */
function readKeys(): Set<string> {
    const keys = new Set<string>();
    for (const { file, text } of sources()) {
        if (!text.includes("getConfiguration('tomAi')") && !file.endsWith('vscodeSettings.ts')) { continue; }
        for (const m of text.matchAll(/\.get(?:<[^>()]*>)?\(\s*'([A-Za-z][\w.]*)'/g)) { keys.add(m[1]); }
        if (file.endsWith('vscodeSettings.ts')) { for (const m of text.matchAll(/\bget\('([A-Za-z][\w.]*)'\)/g)) { keys.add(m[1]); } }
    }
    return keys;
}

describe('VS Code settings and their readers', () => {
    test('SR-1: every contributed setting has a reader', () => {
        const keys = readKeys();
        const unread = contributed().filter((k) => !keys.has(k));
        assert.deepEqual(unread, [], `contributed but read nowhere: ${unread.join(', ')}`);
    });

    test('SR-2: every key read is contributed', () => {
        const declared = new Set(contributed());
        // Files reading `tomAi` settings also call `.get` on other objects; only dotted or known setting keys count.
        const notContributed = [...readKeys()].filter((k) => !declared.has(k)).filter((k) => sources().some(({ text }) =>
            new RegExp(`getConfiguration\\('tomAi'\\)\\s*\\.get(?:<[^>()]*>)?\\(\\s*'${k.replace(/\./g, '\\.')}'`).test(text)));
        assert.deepEqual(notContributed, ['panelStoragePath'], 'read but not contributed (qrfix8 decides panelStoragePath)');
    });

    test('SR-3: defaults, bounds and the restart rule', () => {
        const none = (): undefined => undefined;
        assert.deepEqual(bridgeSettings(none), { requestTimeoutMs: 30_000, restartDelayMs: 5_000, maxRestarts: 10 });
        const values: Record<string, unknown> = { 'bridge.requestTimeout': 120_000, 'bridge.restartDelay': 0, 'bridge.maxRestarts': 2 };
        assert.deepEqual(bridgeSettings((k) => values[k]), { requestTimeoutMs: 120_000, restartDelayMs: 0, maxRestarts: 2 });
        const bad: Record<string, unknown> = { 'bridge.requestTimeout': 10, 'bridge.restartDelay': -1, 'bridge.maxRestarts': 'many' };
        assert.deepEqual(bridgeSettings((k) => bad[k]), { requestTimeoutMs: 30_000, restartDelayMs: 5_000, maxRestarts: 10 }, 'out of bounds: the default');
        const two = bridgeSettings((k) => values[k]);
        assert.deepEqual(nextBridgeRestart(two, 0), { delayMs: 0 });
        assert.deepEqual(nextBridgeRestart(two, 1), { delayMs: 0 });
        assert.equal(nextBridgeRestart(two, 2), null, 'the limit reached: no restart');
        assert.equal(nextBridgeRestart({ ...two, maxRestarts: 0 }, 0), null, '0: never restarted');
        assert.equal(timerTickIntervalMs(none), TIMER_TICK_DEFAULT_MS);
        assert.equal(timerTickIntervalMs(() => 5_000.7), 5_000);
        assert.equal(timerTickIntervalMs(() => 10), TIMER_TICK_DEFAULT_MS, 'below a second: the default');
        assert.deepEqual(guidelinesExcludeGlobs(none), ['tom/zom_*/**']);
        assert.deepEqual(guidelinesExcludeGlobs(() => [' a/** ', '', 3]), ['a/**']);
        assert.deepEqual(guidelinesExcludeGlobs(() => []), [], 'an empty list excludes nothing');
    });

    test('SR-4: removed settings, and where the readers are wired', () => {
        const removed = ['contextApproach', 'maxContextSize', 'autoRunOnSave', 'copilot.model', 'trail.enabled', 'copilot.showNotifications', 'copilot.answerFolder'];
        const declared = contributed();
        for (const k of removed) { assert.ok(!declared.includes(k), `${k} is not contributed`); }
        const all = sources().map((s) => s.text).join('\n');
        assert.doesNotMatch(all, /getCopilotModel|'copilotModel'|showNotifications/, 'no reader or default of a removed setting');
        const bridge = read('src/vscode-bridge.ts');
        assert.match(bridge, /bridgeSettings\(\(key\) => vscode\.workspace\.getConfiguration\('tomAi'\)\.get\(key\)\)/);
        assert.match(bridge, /const next = nextBridgeRestart\(settings, this\.restartsInARow\);/);
        assert.match(bridge, /\}, next\.delayMs\);/);
        assert.match(bridge, /this\.restartsInARow = 0;\n\n\s+if \(message\.error\)/, 'an answer resets the count');
        assert.doesNotMatch(bridge, /defaultRequestTimeoutMs = 30000|\}, 5000\);/, 'no hard-coded timeout or delay');
        assert.match(read('src/managers/timerEngine.ts'), /setInterval\(\(\) => this\.tick\(\), timerTickIntervalMs\(/);
        const ws = read('src/handlers/wsPanel-handler.ts');
        assert.match(ws, /const exclude = guidelinesExcludeGlobs\([\s\S]{0,200}if \(matchesExcludeGlob\(proj\.relativePath, exclude\)\) \{ continue; \}/);
    });
});
