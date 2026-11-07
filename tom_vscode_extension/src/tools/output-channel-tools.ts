/**
 * `tomAi_readOutputChannel` — read this window's output channels.
 *
 * VS Code offers no API to read an output channel, so live checks used to end
 * with "the output channel's lines are for the user to look at". They are not
 * out of reach: VS Code writes every channel of the extension host to disk
 * (`utils/outputChannelLogs.ts`), and this tool reads those files — the queue's
 * sends and retries, the Anthropic turns, the compaction log's `history scope:`
 * lines, the debug log — and every other extension's channel in the window.
 */

import { SharedToolDefinition } from './shared-tool-registry';
import {
    getExthostFolder,
    listOutputChannels,
    listOutputLogRuns,
    matchOutputChannel,
    readOutputChannel,
    lineFilter,
} from '../utils/outputChannelLogs';
import * as path from 'path';

export interface ReadOutputChannelInput {
    channel?: string;
    grep?: string;
    regex?: boolean;
    context?: number;
    maxLines?: number;
    run?: number;
}

export const READ_OUTPUT_CHANNEL_DEFAULT_LINES = 200;
export const READ_OUTPUT_CHANNEL_MAX_LINES = 2000;
const MAX_CONTEXT = 20;

const fail = (error: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ ok: false, error, ...extra });

/** The tool's answer for `input`, reading under the window's `exthost` folder. Exported for testing. */
export function readOutputChannelImpl(input: ReadOutputChannelInput, exthost: string | undefined): string {
    if (!exthost) {
        return fail('The window\'s log folder is not known: the extension has not recorded context.logUri (not activated in a VS Code window).');
    }
    const runs = listOutputLogRuns(exthost);
    if (runs.length === 0) {
        return fail(`No output_logging_* folder under ${exthost}: VS Code has not written this window's output channels to disk.`);
    }
    const runIndex = input.run ?? 0;
    if (!Number.isInteger(runIndex) || runIndex < 0 || runIndex >= runs.length) {
        return fail(`run must be a whole number from 0 (this extension host) to ${runs.length - 1}.`, { runs: runs.map(describeRun) });
    }
    const run = runs[runIndex];
    const channels = listOutputChannels(run.folder);

    if (!input.channel) {
        return JSON.stringify({
            ok: true,
            run: describeRun(run),
            runs: runs.map(describeRun),
            channels,
            hint: 'Read one with `channel` (its name, part of it, or its file name).',
        }, null, 2);
    }

    const match = matchOutputChannel(channels, input.channel);
    if (!match.ok) { return fail(match.error, { candidates: match.candidates, run: describeRun(run) }); }

    const maxLines = input.maxLines ?? READ_OUTPUT_CHANNEL_DEFAULT_LINES;
    if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > READ_OUTPUT_CHANNEL_MAX_LINES) {
        return fail(`maxLines must be a whole number from 1 to ${READ_OUTPUT_CHANNEL_MAX_LINES}.`);
    }
    const context = input.context ?? 0;
    if (!Number.isInteger(context) || context < 0 || context > MAX_CONTEXT) {
        return fail(`context must be a whole number from 0 to ${MAX_CONTEXT}.`);
    }
    try {
        lineFilter(input.grep, input.regex);
    } catch (e) {
        return fail(`Invalid regular expression: ${(e as Error).message}`);
    }

    const file = path.join(run.folder, match.channel.file);
    const read = readOutputChannel(file, { grep: input.grep, regex: input.regex, context, maxLines });
    return JSON.stringify({
        ok: true,
        channel: match.channel.name,
        file,
        run: describeRun(run),
        modified: match.channel.modified,
        totalLines: read.totalLines,
        matchedLines: read.matchedLines,
        returnedLines: read.returnedLines,
        truncated: read.truncated,
        ...(read.readFromEnd ? { readFromEnd: true } : {}),
        text: read.text,
    }, null, 2);
}

function describeRun(run: { index: number; started: string; folder: string }): Record<string, unknown> {
    return { index: run.index, started: run.started, folder: path.basename(run.folder) };
}

export const READ_OUTPUT_CHANNEL_DESCRIPTION =
    'Read this window\'s output channels (the extension\'s — Tom Prompt Queue, Tom AI Anthropic Chat, Tom Tool Log, … — and every other extension\'s) from the files VS Code writes. Without `channel`: the channels and runs. With `channel` (name, part of it, or file name): the last `maxLines` (default 200) as `<line>: <text>`; `grep` (`regex: true` for a regular expression), `context`; `run` 1 = the run before the last reload. Filter by text, not time: the channels\' timestamps differ. Read-only.';

export const READ_OUTPUT_CHANNEL_TOOL: SharedToolDefinition<ReadOutputChannelInput> = {
    name: 'tomAi_readOutputChannel',
    displayName: 'Read Output Channel',
    description: READ_OUTPUT_CHANNEL_DESCRIPTION,
    tags: ['diagnostics', 'logs', 'tom-ai-chat'],
    readOnly: true,
    canBeReferencedInPrompt: true,
    inputSchema: {
        type: 'object',
        properties: {
            channel: { type: 'string', description: 'Channel name (any case), part of it, or its file name. Omit to list the channels.' },
            grep: { type: 'string', description: 'Keep lines containing this text (any case), or matching it with `regex`.' },
            regex: { type: 'boolean', description: 'Read `grep` as a JavaScript regular expression (case-insensitive). Default false.' },
            context: { type: 'number', description: 'Lines kept around each match, 0–20. Default 0.' },
            maxLines: { type: 'number', description: `Most lines returned, the last ones. Default ${READ_OUTPUT_CHANNEL_DEFAULT_LINES}, max ${READ_OUTPUT_CHANNEL_MAX_LINES}.` },
            run: { type: 'number', description: 'Extension-host run: 0 = this one (default), 1 = before the last reload, …' },
        },
    },
    execute: async (input) => readOutputChannelImpl(input ?? {}, getExthostFolder()),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const OUTPUT_CHANNEL_TOOLS: SharedToolDefinition<any>[] = [
    READ_OUTPUT_CHANNEL_TOOL,
];
