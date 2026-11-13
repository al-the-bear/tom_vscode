/* eslint-disable @typescript-eslint/naming-convention -- TOM_BINARY_PATH, HOME and the "*" platform key are external names */
/**
 * Where the binaries folder is when `bridge.binaryPath` names none
 * (utils/executableResolver.ts, resolveBinaryPath).
 *
 *   BP-1 the workspace's binaries layer when it exists, else $TOM_BINARY_PATH/<platform>/, else the layer's path;
 *        never ~/.tom/bin, where no binary is installed and an old copy must not be picked up
 *        (build_tom build_cleanup1002); a configured folder wins over all of them
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { getCurrentPlatform, resolveBinaryPath } from '../executableResolver.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'binarypath-'));
const platform = getCurrentPlatform();
const dirOf = (p: string): string => p + path.sep;

describe('resolveBinaryPath', () => {
    test('BP-1: layer, then $TOM_BINARY_PATH, never ~/.tom/bin; configured first', () => {
        const ws = path.join(tmp, 'ws');
        const layer = path.join(ws, 'tom_binaries', 'tom', platform);
        const tbp = path.join(tmp, 'tbp');
        const env = { TOM_BINARY_PATH: tbp, HOME: path.join(tmp, 'home') };
        fs.mkdirSync(path.join(tmp, 'home', '.tom', 'bin', platform), { recursive: true });

        // No layer yet: $TOM_BINARY_PATH/<platform>/.
        assert.equal(resolveBinaryPath(undefined, ws, env), dirOf(path.join(tbp, platform)));
        // With a layer: the layer.
        fs.mkdirSync(layer, { recursive: true });
        assert.equal(resolveBinaryPath(undefined, ws, env), dirOf(layer));
        // Neither the layer nor the variable: the layer's path, not ~/.tom/bin.
        fs.rmSync(layer, { recursive: true });
        const none = resolveBinaryPath(undefined, ws, { HOME: path.join(tmp, 'home') });
        assert.equal(none, dirOf(layer));
        assert.ok(!none.includes(path.join('.tom', 'bin')), none);
        // A configured folder wins.
        assert.equal(resolveBinaryPath({ '*': path.join(tmp, 'cfg') }, ws, env), dirOf(path.join(tmp, 'cfg')));
    });
});
