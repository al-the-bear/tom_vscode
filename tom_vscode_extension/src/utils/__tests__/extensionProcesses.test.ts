/**
 * The @TOM VSC view's process logic (vscimpb30): src/utils/extensionProcesses.ts, src/utils/heavySettings.ts and
 * src/services/extensionProcessService.ts.
 *
 *   EP-1 `ps` output and Windows' process list (ConvertTo-Json of Win32_Process) are read
 *   EP-2 the tree below the extension host, depth first, the host itself not included, a cycle survives
 *   EP-3 attribution by command line (lines as they look on mbp): an installed extension's path, the Dart
 *        analysis server and tooling, tsserver of the built-in TypeScript extension, git, tom_bs, the Agent SDK CLI
 *        under global storage, ESLint; unknown processes by their program name
 *   EP-4 paused state from `ps` (T), groups by extension (memory, CPU, paused when all are), the totals text
 *   EP-5 settings: a row from effective and workspace values; the workspace value written for a glob (on, off,
 *        off over an inherited on = false), a list entry, a boolean, an enum ("true" read as true), a number
 *   EP-6 the service with a fake system: pause / resume an extension's processes, refuse the host and processes
 *        of another tree, kill children before parents, Windows: kill only
 *   EP-7 the live system on this machine (not Windows): a child of this process is listed, paused (state T),
 *        resumed and killed
 */

/* eslint-disable @typescript-eslint/naming-convention -- setting keys, globs and Win32_Process property names */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';

import {
    attributeProcess, descendants, formatElapsed, formatMemory, groupByExtension, isPaused,
    parsePsOutput, parseWindowsProcesses, totalsText, type ProcInfo,
} from '../extensionProcesses';
import { HEAVY_SETTINGS, heavySettingRow, heavySettingWrite } from '../heavySettings';
import { ExtensionProcessService, liveProcessSystem, type ProcessSystem } from '../../services/extensionProcessService';

const HOST = 1814;
const PS = [
    ` 1814 56250 R    653808  98.7    05:11:51 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) --type=utility --utility-sub-type=node.mojom.NodeService`,
    ` 1837  1814 S     14336   0.0    05:11:50 /Users/me/.vscode/extensions/peter-nicolai-alexis-kyaw.tom-ai-extension-0.1.0/bin/darwin-arm64/tom_bs`,
    ` 1842  1814 S     54880   0.0    05:11:50 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) /Users/me/.vscode/extensions/formulahendry.auto-rename-tag-0.1.10/packages/server/dist/serverMain.js --node-ipc`,
    ` 2932  1814 S    395264   0.3    05:10:00 /Users/me/Library/Application Support/Code/User/globalStorage/peter-nicolai-alexis-kyaw.tom-ai-extension/providers/anthropic/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude --output-format stream-json`,
    ` 3001  1814 S   1572864  45.0    01:00:00 /Users/me/flutter/bin/cache/dart-sdk/bin/dart language-server --protocol=lsp --client-id=VS-Code`,
    ` 3002  3001 T    204800   0.0    01:00:00 /Users/me/flutter/bin/cache/dart-sdk/bin/dartaotruntime /Users/me/flutter/bin/cache/dart-sdk/bin/snapshots/analysis_server.dart.snapshot`,
    ` 3010  1814 S    307200   2.0    00:30:00 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) /Applications/Visual Studio Code.app/Contents/Resources/app/extensions/node_modules/typescript/lib/tsserver.js --serverMode partialSemantic`,
    `67280  1814 R     12288   4.6       00:01 /Applications/Xcode.app/Contents/Developer/usr/bin/git status -z -uall`,
    `67312 67280 S     12288   4.9       00:01 /Applications/Xcode.app/Contents/Developer/usr/libexec/git-core/git status --porcelain=2`,
    ` 9000     1 S      4096   0.0 21:21:12 /Users/me/flutter/bin/cache/dart-sdk/bin/dart tooling-daemon --machine`,
    'garbage line',
].join('\n');

describe('the processes of the extension host', () => {
    test('EP-1: reading the process lists', () => {
        const all = parsePsOutput(PS);
        assert.equal(all.length, 10, 'the garbage line is skipped');
        assert.deepEqual(all[1], { pid: 1837, ppid: 1814, state: 'S', rssKb: 14336, cpu: 0, elapsed: '05:11:50', command: '/Users/me/.vscode/extensions/peter-nicolai-alexis-kyaw.tom-ai-extension-0.1.0/bin/darwin-arm64/tom_bs' });
        const now = new Date(Date.UTC(2026, 10, 10, 12, 0, 0));
        const win = parseWindowsProcesses(JSON.stringify([
            { ProcessId: 500, ParentProcessId: 400, WorkingSetSize: 1048576, CommandLine: 'C:\\dart\\bin\\dart.exe language-server', Name: 'dart.exe', CreationDate: `/Date(${now.getTime() - 3_723_000})/` },
            { ProcessId: 501, ParentProcessId: 500, WorkingSetSize: 2048, CommandLine: null, Name: 'conhost.exe', CreationDate: null },
        ]), now);
        assert.deepEqual(win[0], { pid: 500, ppid: 400, state: '', rssKb: 1024, cpu: null, elapsed: '01:02:03', command: 'C:\\dart\\bin\\dart.exe language-server' });
        assert.equal(win[1].command, 'conhost.exe', 'no command line: the name');
        assert.equal(parseWindowsProcesses(JSON.stringify({ ProcessId: 7, ParentProcessId: 1, WorkingSetSize: 0 })).length, 1, 'one object, not an array');
        assert.deepEqual(parseWindowsProcesses('not json'), []);
        assert.equal(formatElapsed(90_061_000), '1-01:01:01');
    });

    test('EP-2: the tree below the host', () => {
        const tree = descendants(parsePsOutput(PS), HOST);
        assert.deepEqual(tree.map((p) => [p.pid, p.depth]), [[1837, 1], [1842, 1], [2932, 1], [3001, 1], [3002, 2], [3010, 1], [67280, 1], [67312, 2]]);
        assert.ok(!tree.some((p) => p.pid === HOST || p.pid === 9000), 'neither the host nor another tree');
        const cycle: ProcInfo[] = [{ pid: 2, ppid: 3, state: 'S', rssKb: 1, cpu: 0, elapsed: '', command: 'a' }, { pid: 3, ppid: 2, state: 'S', rssKb: 1, cpu: 0, elapsed: '', command: 'b' }];
        assert.deepEqual(descendants(cycle, 2).map((p) => p.pid), [3], 'a cycle ends');
    });

    test('EP-3: who started it', () => {
        const owner = (pid: number) => attributeProcess(parsePsOutput(PS).find((p) => p.pid === pid)!.command);
        assert.deepEqual(owner(1837), { extensionId: 'peter-nicolai-alexis-kyaw.tom-ai-extension', label: 'peter-nicolai-alexis-kyaw.tom-ai-extension', kind: 'DartScript bridge (tom_bs)' });
        assert.equal(owner(1842).extensionId, 'formulahendry.auto-rename-tag');
        assert.equal(owner(2932).extensionId, 'peter-nicolai-alexis-kyaw.tom-ai-extension');
        assert.equal(owner(2932).kind, 'Claude Agent SDK');
        assert.deepEqual([owner(3001).extensionId, owner(3001).kind], ['dart-code.dart-code', 'Dart analysis server']);
        assert.deepEqual([owner(3002).extensionId, owner(3002).kind], ['dart-code.dart-code', 'Dart analysis server']);
        assert.deepEqual([owner(3010).extensionId, owner(3010).kind], ['vscode.typescript-language-features', 'TypeScript server'], 'not "node_modules"');
        assert.deepEqual([owner(67280).extensionId, owner(67312).kind], ['vscode.git', 'git']);
        assert.equal(owner(9000).kind, 'Dart tooling');
        assert.equal(attributeProcess('/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/markdown-language-features/dist/serverWorkerMain.js').extensionId, 'vscode.markdown-language-features');
        assert.equal(attributeProcess('node /home/u/.vscode-server/extensions/dbaeumer.vscode-eslint-3.0.10/server/out/eslintServer.js').extensionId, 'dbaeumer.vscode-eslint');
        assert.deepEqual(attributeProcess('/usr/local/bin/mystery --flag'), { extensionId: '', label: 'mystery', kind: 'mystery' });
    });

    test('EP-4: paused, groups and totals', () => {
        assert.equal(isPaused('T'), true);
        assert.equal(isPaused('T+'), true);
        assert.equal(isPaused('S'), false);
        assert.equal(isPaused(''), false);
        const groups = groupByExtension(descendants(parsePsOutput(PS), HOST));
        assert.equal(groups[0].extensionId, 'dart-code.dart-code', 'the largest first');
        assert.equal(groups[0].rssKb, 1572864 + 204800);
        assert.equal(groups[0].cpu, 45);
        assert.equal(groups[0].paused, false, 'one of two paused');
        assert.equal(groups[0].processes.find((p) => p.pid === 3002)?.paused, true);
        assert.deepEqual(groups.find((g) => g.extensionId === 'vscode.git')?.processes.map((p) => p.pid), [67280, 67312]);
        assert.equal(formatMemory(1572864), '1.5 GB');
        assert.equal(formatMemory(14336), '14 MB');
        assert.equal(totalsText(descendants(parsePsOutput(PS), HOST)), '2.5 GB in 8 processes');
        assert.equal(totalsText([]), '0 MB in 0 processes');
    });

    test('EP-5: the heavy settings', () => {
        const def = (id: string) => HEAVY_SETTINGS.find((d) => d.id === id)!;
        const glob = def('search.exclude:**/node_modules/**');
        assert.deepEqual(heavySettingRow(glob, { '**/node_modules/**': true }, undefined).value, true);
        assert.equal(heavySettingRow(glob, { '**/node_modules/**': true }, undefined).inWorkspace, false);
        assert.deepEqual(heavySettingWrite(glob, { '**/x/**': true }, true), { '**/x/**': true, '**/node_modules/**': true });
        assert.deepEqual(heavySettingWrite(glob, { '**/x/**': true, '**/node_modules/**': true }, false), { '**/x/**': true }, 'off: removed');
        assert.deepEqual(heavySettingWrite(glob, undefined, false, { '**/node_modules/**': true }), { '**/node_modules/**': false }, 'inherited on: false');
        const list = def('dart.analysisExcludedFolders:ztmp');
        assert.equal(heavySettingRow(list, ['ztmp'], ['ztmp']).value, true);
        assert.deepEqual(heavySettingWrite(list, ['a'], true), ['a', 'ztmp']);
        assert.deepEqual(heavySettingWrite(list, ['a', 'ztmp'], false), ['a']);
        const bool = def('dart.onlyAnalyzeProjectsWithOpenFiles');
        assert.equal(heavySettingWrite(bool, undefined, true), true);
        assert.equal(heavySettingWrite(bool, undefined, 'yes'), undefined);
        const detection = def('git.autoRepositoryDetection');
        assert.equal(heavySettingWrite(detection, undefined, 'true'), true);
        assert.equal(heavySettingWrite(detection, undefined, 'openEditors'), 'openEditors');
        assert.equal(heavySettingWrite(detection, undefined, 'nope'), undefined);
        assert.equal(heavySettingRow(detection, true, undefined).value, true);
        const depth = def('git.repositoryScanMaxDepth');
        assert.equal(heavySettingWrite(depth, undefined, 2), 2);
        assert.equal(heavySettingWrite(depth, undefined, 1.5), undefined);
        assert.equal(new Set(HEAVY_SETTINGS.map((d) => d.id)).size, HEAVY_SETTINGS.length, 'ids are unique');
    });

    test('EP-6: the service, with a fake system', async () => {
        const sent: Array<[number, string]> = [];
        const fake = (platform: NodeJS.Platform): ProcessSystem => ({
            platform, rootPid: HOST,
            listAll: async () => parsePsOutput(PS),
            signal: (pid, sig) => { sent.push([pid, sig]); },
        });
        const svc = new ExtensionProcessService(fake('darwin'));
        const snap = await svc.snapshot();
        assert.equal(snap.processes.length, 8);
        assert.equal(snap.host?.pid, HOST);
        assert.equal(snap.canPause, true);
        let r = await svc.act('pause', { extensionId: 'dart-code.dart-code' });
        assert.deepEqual([r.done.sort(), sent.map((s) => s[1])], [[3001, 3002], ['SIGSTOP', 'SIGSTOP']]);
        sent.length = 0;
        r = await svc.act('resume', { pids: [3001] });
        assert.deepEqual(sent, [[3001, 'SIGCONT']]);
        sent.length = 0;
        r = await svc.act('pause', { pids: [HOST, 9000, 3010] });
        assert.deepEqual(r.done, [3010]);
        assert.deepEqual(r.refused.map((x) => x.pid), [HOST, 9000], 'the host and another tree are refused');
        sent.length = 0;
        await svc.act('kill', { extensionId: 'vscode.git' });
        assert.deepEqual(sent, [[67312, 'SIGTERM'], [67280, 'SIGTERM']], 'the child first');
        const win = new ExtensionProcessService(fake('win32'));
        assert.equal(win.canPause, false);
        sent.length = 0;
        r = await win.act('pause', { pids: [3001] });
        assert.deepEqual([r.done, sent.length, /Windows/.test(r.refused[0].why)], [[], 0, true]);
        r = await win.act('kill', { pids: [3001] });
        assert.deepEqual(r.done, [3001]);
        const broken = new ExtensionProcessService({ ...fake('darwin'), listAll: async () => { throw new Error('ps failed'); } });
        const empty = await broken.snapshot();
        assert.deepEqual([empty.processes.length, empty.error], [0, 'ps failed']);
    });

    test('EP-7: the live system pauses and resumes a real process', { skip: process.platform === 'win32' }, async () => {
        const child = spawn('sleep', ['30'], { stdio: 'ignore' });
        try {
            const svc = new ExtensionProcessService(liveProcessSystem());
            const state = async (): Promise<string | undefined> => (await svc.snapshot()).processes.find((p) => p.pid === child.pid)?.state;
            assert.ok((await svc.snapshot()).processes.some((p) => p.pid === child.pid), 'a child of the host is listed');
            assert.deepEqual((await svc.act('pause', { pids: [child.pid!] })).done, [child.pid]);
            assert.equal(isPaused((await state()) ?? ''), true, 'stopped');
            assert.deepEqual((await svc.act('resume', { pids: [child.pid!] })).done, [child.pid]);
            assert.equal(isPaused((await state()) ?? 'T'), false, 'running again');
            const exited = new Promise((r) => child.once('exit', r));
            assert.deepEqual((await svc.act('kill', { pids: [child.pid!] })).done, [child.pid]);
            await exited;
        } finally {
            try { child.kill('SIGKILL'); } catch { /* gone */ }
        }
    });
});
