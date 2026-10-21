/**
 * tomAi_readOutputChannel (vscimpa20) over a fixture log folder laid out as
 * VS Code writes it: `exthost/output_logging_<start>/<n>-<channel>.log`.
 *
 *   OC-1 without `channel`: the runs newest first, the channels of run 0 in creation order with size and last write
 *   OC-2 a channel is found by its name (any case), by part of it, or by its file name; an unknown or ambiguous
 *        one is refused with the candidates
 *   OC-3 `grep` keeps lines containing the text (any case) or matching a regex; an invalid regex is refused;
 *        `context` adds lines around each match, `--` between groups
 *   OC-4 `maxLines` returns the last lines and says `truncated`; out-of-range values are refused
 *   OC-5 `run: 1` reads the run before the last reload; a run that does not exist is refused with the runs
 *   OC-6 no log location recorded, or no output_logging folder: an error that says which
 *   OC-7 the log location comes from context.logUri (`…/exthost/<extension id>`)
 *   OC-8 a file over 32 MB is read from its end
 *   OC-9 the tool is read-only, selectable and filed under Diagnostics
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { withTiming } from './_timing.js';
import { READ_OUTPUT_CHANNEL_TOOL, readOutputChannelImpl } from '../output-channel-tools.js';
import { MAX_CHANNEL_BYTES, getExthostFolder, setExtensionLogUri } from '../../utils/outputChannelLogs.js';
import { AVAILABLE_LLM_TOOLS } from '../../utils/constants.js';
import { categorizeTools } from '../../utils/toolCategories.js';

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'output-channels-')));
const EXTHOST = path.join(ROOT, 'window8', 'exthost');
const OLD_RUN = 'output_logging_20261019T213119';
const RUN = 'output_logging_20261020T183956';

function put(run: string, file: string, lines: string[]): void {
    fs.mkdirSync(path.join(EXTHOST, run), { recursive: true });
    fs.writeFileSync(path.join(EXTHOST, run, file), lines.map((l) => `${l}\n`).join(''));
}

const QUEUE = [
    '2026-10-20T21:57:44.100Z Sending prompt 1b87e54c',
    '2026-10-20T21:57:44.287Z Error: Anthropic client not available — set the configured API key env var',
    '2026-10-20T21:57:44.300Z Retry 1/7 in 30s',
    '2026-10-20T21:59:08.000Z Sending prompt 1b87e54c',
    '2026-10-20T21:59:08.100Z Error: Anthropic client not available — set the configured API key env var',
    '2026-10-20T21:59:08.200Z Retry 2/7 in 60s',
    '2026-10-20T23:46:01.000Z Removed 1b87e54c',
];
put(RUN, '12-Tom Prompt Queue.log', QUEUE);
put(RUN, '18-Tom AI Compaction and Memory Extraction.log', [
    '[21:57:44.287] info              history scope: quest=vscode_extension session=vsd4-prep folder=/ws/_ai/quests/vscode_extension/history/sessions/vsd4-prep',
    '[23:46:09.012] info              history scope: quest=vscode_extension session=default folder=/ws/_ai/quests/vscode_extension/history',
]);
put(RUN, '19-Tom AI Anthropic Chat.log', ['[00:23:21] TURN START']);
put(RUN, '20-Tom AI Anthropic Chat Responses.log', ['[00:23:22] answer']);
put(RUN, '2-Tom AI Chat Log.log', []);
put(OLD_RUN, '12-Tom Prompt Queue.log', ['2026-10-19T21:31:20.000Z queue started (the run before the reload)']);
fs.mkdirSync(path.join(EXTHOST, 'Anthropic.claude-code'), { recursive: true });

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const call = (input: Record<string, unknown>, exthost: string | undefined = EXTHOST): Record<string, any> =>
    JSON.parse(readOutputChannelImpl(input, exthost));

describe('tomAi_readOutputChannel', () => {
    test('OC-1: the runs and the channels of this one', async () => {
        const r = await withTiming('tomAi_readOutputChannel:typical', async () => call({}));
        assert.equal(r.ok, true);
        assert.deepEqual(r.runs.map((x: any) => [x.index, x.folder, x.started]),
            [[0, RUN, '2026-10-20 18:39:56'], [1, OLD_RUN, '2026-10-19 21:31:19']]);
        assert.deepEqual(r.channels.map((c: any) => c.name), [
            'Tom AI Chat Log', 'Tom Prompt Queue', 'Tom AI Compaction and Memory Extraction',
            'Tom AI Anthropic Chat', 'Tom AI Anthropic Chat Responses',
        ], 'creation order, by the number in the file name');
        const queue = r.channels.find((c: any) => c.name === 'Tom Prompt Queue');
        assert.equal(queue.file, '12-Tom Prompt Queue.log');
        assert.equal(queue.bytes, fs.statSync(path.join(EXTHOST, RUN, queue.file)).size);
        assert.match(queue.modified, /^\d{4}-\d\d-\d\dT/);
    });

    test('OC-2: finding a channel', async () => {
        const byName = await withTiming('tomAi_readOutputChannel:grep', async () => call({ channel: 'tom prompt queue' }));
        assert.equal(byName.channel, 'Tom Prompt Queue');
        assert.equal(byName.totalLines, QUEUE.length);
        assert.equal(call({ channel: 'compaction' }).channel, 'Tom AI Compaction and Memory Extraction');
        // "Tom AI Anthropic Chat" is a name, and part of another: the exact name wins.
        assert.equal(call({ channel: 'Tom AI Anthropic Chat' }).channel, 'Tom AI Anthropic Chat');
        assert.equal(call({ channel: '20-Tom AI Anthropic Chat Responses.log' }).channel, 'Tom AI Anthropic Chat Responses');
        const ambiguous = call({ channel: 'anthropic' });
        assert.equal(ambiguous.ok, false);
        assert.deepEqual(ambiguous.candidates, ['Tom AI Anthropic Chat', 'Tom AI Anthropic Chat Responses']);
        const unknown = call({ channel: 'nothing like it' });
        assert.equal(unknown.ok, false);
        assert.ok(unknown.candidates.includes('Tom Prompt Queue'), 'names the channels there are');
    });

    test('OC-3: grep, regex and context', () => {
        const grep = call({ channel: 'queue', grep: 'API KEY' });
        assert.equal(grep.matchedLines, 2);
        assert.equal(grep.text, `2: ${QUEUE[1]}\n--\n5: ${QUEUE[4]}`, 'line numbers are the file\'s');
        const scope = call({ channel: 'compaction', grep: 'session=vsd4-prep' });
        assert.match(scope.text, /history scope: .*folder=.*history\/sessions\/vsd4-prep/);
        const regex = call({ channel: 'queue', grep: 'retry [12]/7', regex: true });
        assert.equal(regex.matchedLines, 2);
        assert.equal(call({ channel: 'queue', grep: '(', regex: true }).ok, false, 'an invalid regex is refused');
        const ctx = call({ channel: 'queue', grep: 'Retry 1/7', context: 1 });
        assert.equal(ctx.text, `2: ${QUEUE[1]}\n3: ${QUEUE[2]}\n4: ${QUEUE[3]}`);
        const groups = call({ channel: 'queue', grep: 'Sending', context: 0 });
        assert.equal(groups.text, `1: ${QUEUE[0]}\n--\n4: ${QUEUE[3]}`, 'groups that do not touch are separated');
    });

    test('OC-4: maxLines keeps the last lines', () => {
        const r = call({ channel: 'queue', maxLines: 2 });
        assert.equal(r.returnedLines, 2);
        assert.equal(r.truncated, true);
        assert.equal(r.text, `6: ${QUEUE[5]}\n7: ${QUEUE[6]}`);
        assert.equal(call({ channel: 'queue' }).truncated, false);
        for (const maxLines of [0, 2001, 1.5]) { assert.equal(call({ channel: 'queue', maxLines }).ok, false, `maxLines ${maxLines}`); }
        assert.equal(call({ channel: 'queue', context: 21 }).ok, false);
    });

    test('OC-5: an earlier run', () => {
        const r = call({ channel: 'Tom Prompt Queue', run: 1 });
        assert.match(r.text, /the run before the reload/);
        assert.equal(r.run.folder, OLD_RUN);
        const missing = call({ channel: 'Tom Prompt Queue', run: 2 });
        assert.equal(missing.ok, false);
        assert.equal(missing.runs.length, 2);
    });

    test('OC-6: nothing to read', () => {
        assert.match(JSON.parse(readOutputChannelImpl({}, undefined)).error, /context\.logUri/);
        const empty = path.join(ROOT, 'empty', 'exthost');
        fs.mkdirSync(empty, { recursive: true });
        assert.match(call({}, empty).error, /No output_logging_\* folder/);
    });

    test('OC-7: the window\'s exthost folder comes from context.logUri', async () => {
        setExtensionLogUri(path.join(EXTHOST, 'peter-nicolai-alexis-kyaw.tom-ai-extension'));
        assert.equal(getExthostFolder(), EXTHOST);
        const r = JSON.parse(String(await READ_OUTPUT_CHANNEL_TOOL.execute({ channel: 'queue', grep: 'Removed' })));
        assert.equal(r.matchedLines, 1);
        setExtensionLogUri(undefined);
        assert.equal(getExthostFolder(), undefined);
    });

    test('OC-8: a file over the limit is read from its end', () => {
        const run = 'output_logging_20261021T000000';
        fs.mkdirSync(path.join(EXTHOST, run), { recursive: true });
        const file = path.join(EXTHOST, run, '1-Big.log');
        const line = `${'x'.repeat(1023)}\n`;
        fs.writeFileSync(file, line.repeat(Math.ceil(MAX_CHANNEL_BYTES / line.length) + 16) + 'the last line\n');
        try {
            const r = call({ channel: 'Big', maxLines: 1 });
            assert.equal(r.readFromEnd, true);
            assert.match(r.text, /: the last line$/);
        } finally {
            fs.rmSync(path.join(EXTHOST, run), { recursive: true, force: true });
        }
    });

    test('OC-9: read-only, selectable, under Diagnostics', () => {
        assert.equal(READ_OUTPUT_CHANNEL_TOOL.readOnly, true);
        assert.ok((AVAILABLE_LLM_TOOLS as readonly string[]).includes('tomAi_readOutputChannel'));
        assert.equal(categorizeTools(['tomAi_readOutputChannel'])[0].category, 'Diagnostics');
    });
});
