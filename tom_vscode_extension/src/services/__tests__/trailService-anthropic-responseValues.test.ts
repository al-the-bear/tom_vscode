/**
 * Bug 1 regression: `#TODO=` references must be recoverable from the Anthropic
 * answer path, exactly as they are from the Copilot path.
 *
 * Before the fix, an Anthropic answer with `responseValues` metadata was written
 * as a `### metadata json` block whose nested `responseValues` object the trail
 * loader rendered as `[object Object]` — so the todo-log panel could never
 * extract the TODO reference. The fix routes the anthropic subsystem through the
 * same human-readable `variables:` block the copilot path uses.
 *
 * This test drives `writeSummaryAnswer` against a stubbed workspace and asserts
 * the on-disk answer file carries a `variables:` block (not a `### metadata json`
 * wrapper) and that the shared extractor recovers the TODO reference from it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

let trailConfig: unknown = {};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trailsvc-anthropic-'));

installVscodeStub({
    workspaceFolders: [tmpRoot],
    moduleOverrides: {
        '../utils/tomAiConfiguration': {
            TomAiConfiguration: { instance: { getTrail: (): unknown => trailConfig } },
        },
    },
});

describe('TrailService.writeSummaryAnswer — anthropic responseValues', () => {
    it('writes a human-readable variables: block carrying the TODO ref', async () => {
        trailConfig = {};
        const { TrailService } = await import('../trailService.js');
        const { ANTHROPIC_SUBSYSTEM } = await import('../trailSubsystems.js');
        const { extractTodoResponseValues } = await import('../../utils/responseValues.js');
        TrailService.init({} as never);

        const ref = '_ai/quests/tom_specs/som_api_languages.tom_specs.todo.yaml/AA1';
        TrailService.instance.writeSummaryAnswer(
            ANTHROPIC_SUBSYSTEM,
            'Implemented the thing.',
            { requestId: 'req-1', model: 'claude-sonnet-4-6', responseValues: { TODO: ref } },
            'demo_quest',
        );

        const file = TrailService.instance.getSummaryFilePath('answers', ANTHROPIC_SUBSYSTEM, 'demo_quest');
        assert.ok(file, 'expected a resolved answers file path');
        const body = fs.readFileSync(file as string, 'utf-8');

        assert.match(body, /\nvariables:\n - TODO = /, 'expected a variables: block');
        assert.doesNotMatch(body, /### metadata/, 'must not use the raw json metadata wrapper');
        assert.deepEqual(extractTodoResponseValues(body), { TODO: ref });
    });

    it('omits the metadata block entirely when no displayable metadata is present', async () => {
        trailConfig = {};
        const { TrailService } = await import('../trailService.js');
        const { ANTHROPIC_SUBSYSTEM } = await import('../trailSubsystems.js');
        TrailService.init({} as never);

        TrailService.instance.writeSummaryAnswer(
            ANTHROPIC_SUBSYSTEM,
            'Plain answer with no todo.',
            { requestId: 'req-2', model: 'claude-sonnet-4-6' },
            'demo_quest_2',
        );

        const file = TrailService.instance.getSummaryFilePath('answers', ANTHROPIC_SUBSYSTEM, 'demo_quest_2');
        const body = fs.readFileSync(file as string, 'utf-8');
        assert.doesNotMatch(body, /### metadata/);
        assert.doesNotMatch(body, /\nvariables:/);
        assert.match(body, /Plain answer with no todo\./);
    });
});
