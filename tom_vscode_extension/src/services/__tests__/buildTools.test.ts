/* eslint-disable @typescript-eslint/naming-convention -- PATH and the "*" platform key are external names */
/**
 * The tom build tools bundled as the last fallback (src/services/buildTools.ts, vscimpb83).
 *
 *   BT-1 every tool (buildkit, d4rtgen, reflectiongenerator, testkit) is looked for in the same order:
 *        bridge.executables.<tool>, bridge.binaryPath, the workspace's binaries layer, $TOM_BINARY_PATH/<platform>/,
 *        PATH, then the extension's bin/<platform>/; each hit says where (configured, layer, path, bundled), none is
 *        `missing` with every place looked at; on Windows the files end in .exe
 *   BT-2 the status lists them beside the Dart binaries (dartBinariesStatus.buildTools), a missing one is not in
 *        `missing` (it does not open the page); the help page fills its build tools table
 *   BT-3 the Status Page shows a row per tool with where it was found; the Telegram bk / tk commands run the file the
 *        lookup finds, with the bundled folder first on PATH (buildkit finds d4rtgen and reflectiongenerator there)
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { BUILD_TOOLS, BUILD_TOOL_PURPOSE, buildToolFileName, resolveBuildTool } from '../buildTools.js';
import { dartBinariesStatus, fillHelpPage } from '../dartBinariesStatus.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-tools-'));
const EXT = path.resolve(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(EXT, ...p), 'utf8');

function file(rel: string): string {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '');
    return abs;
}

describe('the tom build tools', () => {
    test('BT-1: one lookup order for every tool, the bundled copy last', () => {
        assert.deepEqual([...BUILD_TOOLS], ['buildkit', 'd4rtgen', 'reflectiongenerator', 'testkit']);
        for (const platform of ['linux-x64', 'win32-x64']) {
            for (const name of BUILD_TOOLS) {
                const f = buildToolFileName(name, platform);
                assert.equal(f, platform === 'win32-x64' ? `${name}.exe` : name);
                const base = `${platform}-${name}`;
                const ws = path.join(tmp, base, 'ws');
                const ext = path.join(tmp, base, 'ext');
                const configured = file(`${base}/cfg/${f}`);
                const binDir = file(`${base}/bindir/${f}`);
                const layer = file(`${base}/ws/tom_binaries/tom/${platform}/${f}`);
                const tbp = file(`${base}/tbp/${platform}/${f}`);
                const onPath = file(`${base}/pathdir/${f}`);
                const bundled = file(`${base}/ext/bin/${platform}/${f}`);
                const env = { PATH: path.join(tmp, base, 'pathdir'), TOM_BINARY_PATH: path.join(tmp, base, 'tbp') };
                const at = (config: object, e: NodeJS.ProcessEnv = env) => {
                    const r = resolveBuildTool(name, ws, config, e, platform, ext);
                    return [r.source, r.path];
                };
                assert.deepEqual(at({ executables: { [name]: { '*': configured } } }), ['configured', configured], `${base}: bridge.executables`);
                assert.deepEqual(at({ binaryPath: { '*': path.dirname(binDir) } }), ['configured', binDir], `${base}: bridge.binaryPath`);
                assert.deepEqual(at({}), ['layer', layer], `${base}: the workspace layer`);
                fs.rmSync(layer);
                assert.deepEqual(at({}), ['layer', tbp], `${base}: $TOM_BINARY_PATH`);
                fs.rmSync(tbp);
                assert.deepEqual(at({}), ['path', onPath], `${base}: PATH`);
                fs.rmSync(onPath);
                assert.deepEqual(at({}), ['bundled', bundled], `${base}: the bundled copy, last`);
                fs.rmSync(bundled);
                const none = resolveBuildTool(name, ws, {}, env, platform, ext);
                assert.equal(none.source, 'missing');
                assert.equal(none.path, undefined);
                assert.deepEqual(none.searched.slice(-2), [`${f} on PATH`, `${path.join(ext, 'bin', platform, f)} (bundled with the extension)`]);
            }
        }
    });

    test('BT-2: the status and the page', () => {
        const platform = `${process.platform}-${process.arch}`;
        const ext = path.join(tmp, 'status-ext');
        const exe = platform.startsWith('win32') ? '.exe' : '';
        file(`status-ext/bin/${platform}/testkit${exe}`);
        const status = dartBinariesStatus(ext, { workspaceRoot: path.join(tmp, 'status-ws') }, { PATH: '' });
        assert.deepEqual(status.buildTools.map((t) => [t.name, t.source]), [
            ['buildkit', 'missing'], ['d4rtgen', 'missing'], ['reflectiongenerator', 'missing'], ['testkit', 'bundled'],
        ]);
        assert.ok(!status.missing.some((m) => (BUILD_TOOLS as readonly string[]).includes(m)), 'not in `missing`');
        const page = fillHelpPage(read('resources', 'dart_binaries', 'missing_dart_binaries.md'), status, ext);
        assert.match(page, /## The tom build tools/);
        assert.match(page, /\| Tool \| For \| Found \| File \|/);
        assert.ok(page.includes(`| \`testkit${exe}\` | ${BUILD_TOOL_PURPOSE.testkit} | bundled | \`${path.join(ext, 'bin', platform, `testkit${exe}`)}\` |`));
        assert.ok(page.includes(`| \`buildkit${exe}\` | ${BUILD_TOOL_PURPOSE.buildkit} | **missing** | — |`));
        assert.doesNotMatch(page, /\{\{buildToolsTable\}\}/);
    });

    test('BT-3: the Status Page and the Telegram commands', () => {
        const sp = read('src', 'handlers', 'statusPage-handler.ts');
        assert.match(sp, /const toolRows = \(status\.buildTools \?\? \[\]\)\.map\(\(t\) =>\s*`<div class="sp-settings-row" data-build-tool="\$\{t\.name\}">/);
        assert.match(sp, /<b>Build tools<\/b> \(bundled as the last fallback\)/);
        assert.match(sp, /const BUILD_TOOL_LABEL: Record<BuildToolSource, string> = \{ configured: 'configured', layer: 'binaries layer', path: 'PATH', bundled: 'bundled', missing: 'missing' \};/);
        const tg = read('src', 'handlers', 'telegram-cmd-handlers.ts');
        assert.match(tg, /const tool = resolveBuildTool\(name, workspaceRoot, currentDartBinariesConfig\(\), process\.env, getCurrentPlatform\(\), dartBinariesExtensionRoot\(\)\);/);
        assert.match(tg, /tool\.source === 'bundled' && tool\.path\s*\?\s*\{ \.\.\.process\.env, PATH: `\$\{path\.dirname\(tool\.path\)\}\$\{path\.delimiter\}/);
        for (const name of ['buildkit', 'testkit']) {
            assert.match(tg, new RegExp(`const shell = buildToolShellCommand\\('${name}', args, getWorkspaceRoot\\(\\) \\?\\? cwd\\);[\\s\\S]{0,200}await execShell\\(shell\\.command, cwd, 0, shell\\.env\\);`));
        }
    });
});
