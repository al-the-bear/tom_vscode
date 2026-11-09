/**
 * The Provider SDKs page (handlers/providerSdks-handler.ts, media/providerSdks/)
 * and its links: the Status Page button, the start-up rule.
 *
 *   PP-1 the rows: installed and this build's versions, the package count for the host, "update to …" only for
 *        an installed provider with a newer release (marked when it is a new major), installed from an update
 *   PP-2 the page (JSDOM): a row per provider with its checkbox; checking / unchecking marks the row and enables
 *        Install / Uninstall, which posts apply with what to install and remove; Check for updates is off while
 *        nothing is installed; the update tag posts update (marked "(new major)"), Update all posts updateAll;
 *        a provider at other versions offers "install this build's versions" (reinstall); the banner while
 *        nothing is installed; the log and the outcome
 *   PP-3 the host: activation sets the folder (<global storage>/providers) and opens the page when no provider
 *        is installed, not when one is; ready answers the state; apply removes a provider (folder and record)
 *   PP-4 the Status Page: the first section names the installed providers and has Provider SDKs, which runs
 *        tomAi.providerSdks; the command is contributed
 */

/* eslint-disable @typescript-eslint/naming-convention -- package names as npm writes them */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JSDOM } from 'jsdom';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
const stubbed = installVscodeStub({});

import { providerRows, initProviderSdks, handleProviderSdksMessage, __setProviderSdksExtensionRootForTests } from '../providerSdks-handler.js';
import { handleStatusAction, setupWorkspaceSectionHtml } from '../statusPage-handler.js';
import { readProviderManifest, type ProviderManifest } from '../../utils/providerSdks.js';
import * as runtime from '../../services/providerRuntime.js';
import { setExtensionPath } from '../handler_shared.js';

const EXT = path.resolve(__dirname, '..', '..', '..');
setExtensionPath(EXT);
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'provider-page-')));
const rootBefore = runtime.getProviderRoot();
after(() => { runtime.setProviderRoot(rootBefore); fs.rmSync(SANDBOX, { recursive: true, force: true }); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

const MANIFEST: ProviderManifest = {
    formatVersion: 1,
    registry: 'http://127.0.0.1:1',
    providers: [{
        id: 'anthropic', name: 'Anthropic', description: 'direct and agent', roots: ['@anthropic-ai/sdk', '@anthropic-ai/claude-agent-sdk'],
        packages: [
            { name: '@anthropic-ai/sdk', version: '0.124.0', path: 'node_modules/@anthropic-ai/sdk', resolved: '', integrity: '' },
            { name: '@anthropic-ai/claude-agent-sdk', version: '0.3.282', path: 'node_modules/@anthropic-ai/claude-agent-sdk', resolved: '', integrity: '' },
            { name: '@anthropic-ai/claude-agent-sdk-darwin-arm64', version: '0.3.282', path: 'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64', resolved: '', integrity: '', os: ['darwin'], cpu: ['arm64'] },
            { name: '@anthropic-ai/claude-agent-sdk-win32-x64', version: '0.3.282', path: 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64', resolved: '', integrity: '', os: ['win32'], cpu: ['x64'] },
        ],
    }, {
        id: 'other', name: 'Other', description: 'a second provider', roots: ['other-sdk'],
        packages: [{ name: 'other-sdk', version: '2.0.0', path: 'node_modules/other-sdk', resolved: '', integrity: '' }],
    }],
};

function page(init: Record<string, unknown>): { w: Win; posted: Array<Record<string, unknown>> } {
    const html = fs.readFileSync(path.join(EXT, 'media', 'providerSdks', 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
    const w = new JSDOM(html, { runScripts: 'outside-only' }).window as Win;
    const posted: Array<Record<string, unknown>> = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))) });
    w.__INIT__ = init;
    w.eval(fs.readFileSync(path.join(EXT, 'media', 'providerSdks', 'main.js'), 'utf8'));
    return { w, posted };
}

describe('the Provider SDKs page', () => {
    test('PP-1: the rows', () => {
        const host = { os: 'darwin', cpu: 'arm64' };
        const none = providerRows(MANIFEST, { formatVersion: 1, providers: {} }, [], host);
        assert.deepEqual(none.map((r) => [r.id, r.installed, r.installedLabel, r.pinnedLabel, r.packageCount, r.updateLabel]), [
            ['anthropic', false, '', 'sdk 0.124.0, claude-agent-sdk 0.3.282', 3, undefined],
            ['other', false, '', 'other-sdk 2.0.0', 1, undefined],
        ]);
        const state = { formatVersion: 1 as const, providers: { anthropic: { roots: { '@anthropic-ai/sdk': '0.124.0', '@anthropic-ai/claude-agent-sdk': '0.3.282' }, packages: {}, installedAt: '', source: 'pinned' as const } } };
        const updates = [
            { id: 'anthropic', roots: [], updateAvailable: true, majorChange: true, latestLabel: 'sdk 1.6.0, claude-agent-sdk 0.3.319' },
            { id: 'other', roots: [], updateAvailable: true, majorChange: false, latestLabel: 'other-sdk 2.1.0' },
        ];
        const rows = providerRows(MANIFEST, state, updates, host);
        assert.equal(rows[0].installedLabel, 'sdk 0.124.0, claude-agent-sdk 0.3.282');
        assert.equal(rows[0].updateLabel, 'sdk 1.6.0, claude-agent-sdk 0.3.319');
        assert.equal(rows[0].updateMajor, true);
        assert.equal(rows[0].updated, false);
        assert.equal(rows[1].updateLabel, undefined, 'not installed: no update tag');
        const updated = providerRows(MANIFEST, { formatVersion: 1, providers: { anthropic: { ...state.providers.anthropic, source: 'update' } } }, [], host);
        assert.equal(updated[0].updated, true);
    });

    test('PP-2: the page', (t) => {
        const rows = [
            { id: 'anthropic', name: 'Anthropic', description: 'd', installed: true, installedLabel: 'sdk 1.6.0, claude-agent-sdk 0.3.319', pinnedLabel: 'sdk 0.124.0, claude-agent-sdk 0.3.282', updateLabel: 'sdk 1.7.0, claude-agent-sdk 0.4.0', updateMajor: true, packageCount: 10, updated: true },
            { id: 'other', name: 'Other', description: 'd2', installed: false, installedLabel: '', pinnedLabel: 'other-sdk 2.0.0', packageCount: 1, updated: false },
        ];
        const { w, posted } = page({ type: 'state', rows, busy: false, folder: '/gs/providers', platform: 'darwin-arm64', log: ['(1/2) a'], message: { kind: 'info', text: 'Install: done.' }, noneInstalled: false });
        t.after(() => w.close());
        const doc = w.document;
        assert.equal(doc.querySelectorAll('#psRows tr').length, 2);
        const checks = [...doc.querySelectorAll('.ps-check')] as Win[];
        assert.deepEqual(checks.map((c) => c.checked), [true, false]);
        assert.equal(doc.getElementById('psApply').disabled, true, 'nothing changed');
        assert.equal(doc.getElementById('psUpdateAll').disabled, false, 'an update is there');
        assert.equal(doc.getElementById('psCheck').disabled, false);
        assert.equal(doc.getElementById('psNone').hidden, true);
        assert.match(doc.getElementById('psMessage').textContent, /Install: done\./);
        assert.match(doc.getElementById('psLog').textContent, /\(1\/2\) a/);
        assert.equal(doc.getElementById('psFolder').textContent, '/gs/providers');
        const upd = doc.querySelector('.ps-update');
        assert.match(upd.textContent, /update to sdk 1\.7\.0, claude-agent-sdk 0\.4\.0 \(new major\)/);
        assert.ok(upd.classList.contains('major'));
        upd.click();
        assert.deepEqual(posted.pop(), { type: 'update', id: 'anthropic' });
        doc.getElementById('psUpdateAll').click();
        assert.deepEqual(posted.pop(), { type: 'updateAll' });
        doc.getElementById('psCheck').click();
        assert.deepEqual(posted.pop(), { type: 'checkUpdates' });
        doc.querySelector('.ps-reinstall').click();
        assert.deepEqual(posted.pop(), { type: 'reinstall', id: 'anthropic' });
        // Uncheck Anthropic, check Other: both marked, Install / Uninstall applies both.
        checks[0].checked = false; checks[0].dispatchEvent(new w.Event('change', { bubbles: true }));
        let fresh = [...doc.querySelectorAll('.ps-check')] as Win[];
        fresh[1].checked = true; fresh[1].dispatchEvent(new w.Event('change', { bubbles: true }));
        assert.match(doc.getElementById('psRows').textContent, /to uninstall[\s\S]*to install/);
        assert.equal(doc.getElementById('psApply').disabled, false);
        doc.getElementById('psApply').click();
        assert.deepEqual(posted.pop(), { type: 'apply', install: ['other'], remove: ['anthropic'] });
        // Checking a box back to what is installed is no change.
        fresh = [...doc.querySelectorAll('.ps-check')] as Win[];
        fresh[0].checked = false; fresh[0].dispatchEvent(new w.Event('change', { bubbles: true }));
        fresh = [...doc.querySelectorAll('.ps-check')] as Win[];
        fresh[0].checked = true; fresh[0].dispatchEvent(new w.Event('change', { bubbles: true }));
        assert.equal(doc.getElementById('psApply').disabled, true);
        // Nothing installed: the banner; no update check; busy: every control off.
        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'state', rows: [rows[1]], busy: false, noneInstalled: true, log: [] } }));
        assert.equal(doc.getElementById('psNone').hidden, false);
        assert.equal(doc.getElementById('psCheck').disabled, true);
        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'state', rows, busy: true, noneInstalled: false, log: [] } }));
        assert.ok([...doc.querySelectorAll('button, .ps-check')].every((b: Win) => b.disabled), 'busy');
        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'log', line: '(2/2) b' } }));
        assert.match(doc.getElementById('psLog').textContent, /\(2\/2\) b/);
        assert.equal(posted[0]?.type, 'ready', 'the page asked for the state');
    });

    test('PP-3: the host', async () => {
        __setProviderSdksExtensionRootForTests(EXT);
        const panels = (): Win[] => ((stubbed.stub.window as Record<string, unknown>).__webviewPanels as Win[]).filter((p) => p.viewType === 'tomAi.providerSdks');
        const ctx = (dir: string): Win => ({ extensionPath: EXT, globalStorageUri: { fsPath: dir }, subscriptions: [] as unknown[] });
        // Nothing installed: the page opens at start.
        const empty = path.join(SANDBOX, 'gs-empty');
        initProviderSdks(ctx(empty));
        assert.equal(runtime.getProviderRoot(), path.join(empty, 'providers'));
        assert.equal(panels().length, 1, 'opened at start');
        const panel = panels()[0];
        await handleProviderSdksMessage({ type: 'ready' });
        const st = panel.webview.__posted.filter((m: Win) => m.type === 'state').pop();
        assert.equal(st.noneInstalled, true);
        assert.deepEqual(st.rows.map((r: Win) => r.id), readProviderManifest(EXT).providers.map((p) => p.id));
        panel.dispose();
        // One installed: it does not open.
        const gs = path.join(SANDBOX, 'gs-installed');
        const root = path.join(gs, 'providers');
        fs.mkdirSync(path.join(root, 'anthropic', 'node_modules'), { recursive: true });
        fs.writeFileSync(path.join(root, 'providers-state.json'), JSON.stringify({ formatVersion: 1, providers: { anthropic: { roots: { '@anthropic-ai/sdk': '0.124.0' }, packages: {}, installedAt: '', source: 'pinned' } } }));
        initProviderSdks(ctx(gs));
        assert.equal(panels().filter((p) => p.visible).length, 0, 'an installed provider: no page at start');
        // Uninstall through the page.
        await handleProviderSdksMessage({ type: 'apply', install: [], remove: ['anthropic'] });
        assert.equal(fs.existsSync(path.join(root, 'anthropic')), false);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'providers-state.json'), 'utf8')).providers, {});
    });

    test('PP-4: the Status Page and the command', async () => {
        const html = setupWorkspaceSectionHtml(['anthropic']);
        assert.match(html, /Provider SDKs — installed: anthropic/);
        assert.match(html, /data-status-action="openProviderSdks"/);
        assert.match(setupWorkspaceSectionHtml([]), /installed: none/);
        const runs = (): number => stubbed.spies.byMethod('commands.executeCommand').filter((c) => c.args[0] === 'tomAi.providerSdks').length;
        const before = runs();
        await handleStatusAction('openProviderSdks', {});
        assert.equal(runs(), before + 1);
        const pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
        assert.ok(pkg.contributes.commands.some((c: { command: string }) => c.command === runtime.PROVIDER_SDKS_COMMAND));
    });
});
