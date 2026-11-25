/**
 * The raw trail's file limit (src/utils/rawTrailLimit.ts): one key, `trail.raw.maxRawFiles`, read by the trail
 * service's prune and shown and saved by the Status Page.
 *
 *   RL-1 the key: `trail.raw.maxRawFiles`, else the flat `trail.maxRawFiles` of an older config, else 1000; a
 *        value that is no whole number ≥ 1 is not taken; the save writes it under `raw` and drops the flat key
 *   RL-2 the value the Status Page saves is the limit TrailService.pruneRawTrailDir applies — with a `trail.raw`
 *        section (the case where the flat key was ignored before) and without one; an older config's flat key
 *        holds until a save moves it
 *   RL-3 the Status Page reads and writes through the helper (both save paths, the shown value); the compiled
 *        defaults set no `raw.maxRawFiles` (they would shadow an older config's flat key)
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
import { RAW_TRAIL_DEFAULT_MAX_FILES, rawTrailMaxFiles, setRawTrailMaxFiles } from '../../utils/rawTrailLimit.js';

let trailConfig: Record<string, unknown> = {};
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-trail-limit-'));

installVscodeStub({
    workspaceFolders: [tmpRoot],
    moduleOverrides: {
        '../utils/tomAiConfiguration': {
            TomAiConfiguration: { instance: { getTrail: (): unknown => trailConfig } },
        },
    },
});

const SRC = path.join(__dirname, '..', '..', '..', 'src');

describe('the raw trail file limit', () => {
    test('RL-1: the key', () => {
        assert.equal(RAW_TRAIL_DEFAULT_MAX_FILES, 1000);
        assert.equal(rawTrailMaxFiles(undefined), 1000);
        assert.equal(rawTrailMaxFiles({ raw: { maxRawFiles: 300 } }), 300);
        assert.equal(rawTrailMaxFiles({ maxRawFiles: 200 }), 200, 'an older config\'s flat key');
        assert.equal(rawTrailMaxFiles({ raw: { maxRawFiles: 300 }, maxRawFiles: 200 }), 300, 'raw wins');
        assert.equal(rawTrailMaxFiles({ raw: { enabled: true }, maxRawFiles: 200 }), 200, 'a raw section without the key: the flat one');
        assert.equal(rawTrailMaxFiles({ raw: { maxRawFiles: 0 } }), 1000);
        const saved = setRawTrailMaxFiles({ maxRawFiles: 200, raw: { enabled: true } } as Record<string, unknown>, 50);
        assert.deepEqual(saved, { raw: { enabled: true, maxRawFiles: 50 } }, 'under raw, the flat key dropped, raw kept');
        assert.deepEqual(setRawTrailMaxFiles({ maxRawFiles: 200 } as Record<string, unknown>, Number.NaN), { maxRawFiles: 200 }, 'an invalid value changes nothing');
    });

    test('RL-2: the saved value is the limit the prune applies', async () => {
        const { TrailService } = await import('../trailService.js');
        const { ANTHROPIC_SUBSYSTEM } = await import('../trailSubsystems.js');
        TrailService.init({} as never);
        const svc = TrailService.instance;
        let n = 0;
        const filesAfterWrites = (quest: string, writes: number): number => {
            for (let i = 0; i < writes; i++) { svc.writeRawPrompt(ANTHROPIC_SUBSYSTEM, `p${n++}`, 'w', `r${n}`, quest); }
            return fs.readdirSync(svc.getSubsystemPath(ANTHROPIC_SUBSYSTEM, quest), { withFileTypes: true }).filter((e) => e.isFile()).length;
        };

        // With a raw section (as the root config has): the page's value used to be ignored.
        trailConfig = setRawTrailMaxFiles({ raw: { enabled: true, paths: {} }, maxRawFiles: 1000 }, 4);
        assert.equal(filesAfterWrites('q1', 9), 4, 'with a trail.raw section');

        // Without one.
        trailConfig = setRawTrailMaxFiles({}, 3);
        assert.equal(filesAfterWrites('q2', 8), 3, 'without a trail.raw section');

        // An older config's flat key holds until a save moves it.
        trailConfig = { raw: { enabled: true }, maxRawFiles: 5 };
        assert.equal(filesAfterWrites('q3', 9), 5, 'the flat key of an older config');
    });

    test('RL-3: the Status Page and the defaults', () => {
        const page = fs.readFileSync(path.join(SRC, 'handlers', 'statusPage-handler.ts'), 'utf8');
        assert.match(page, /setRawTrailMaxFiles\(stcConfig\.trail, message\.maxRawFiles\);/, 'the Trail section saves through the helper');
        assert.match(page, /setRawTrailMaxFiles\(stcConfig\.trail, s\.trailMaxRawFiles\);/, 'the compaction settings save through it');
        assert.match(page, /maxRawFiles: rawTrailMaxFiles\(sendToChatConfig\?\.trail\),/, 'the page shows the value the prune uses');
        assert.doesNotMatch(page, /stcConfig\.trail\.maxRawFiles =/);
        assert.match(fs.readFileSync(path.join(SRC, 'services', 'trailService.ts'), 'utf8'), /maxRawFiles: rawTrailMaxFiles\(trail\),/);
        assert.doesNotMatch(fs.readFileSync(path.join(SRC, 'utils', 'tomAiConfiguration.ts'), 'utf8'), /maxRawFiles/);
    });
});
