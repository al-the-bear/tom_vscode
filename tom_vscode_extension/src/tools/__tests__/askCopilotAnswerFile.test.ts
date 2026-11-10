/**
 * tomAi_askCopilot waits for the file its prompt tells Copilot to write (vscimpb28): the registered tool with its
 * live deps (template expansion, the Copilot Queue Wrapper, the answer folder), Copilot played by the stubbed
 * `workbench.action.chat.open`, which writes the answer file the prompt names.
 *
 *   AF-1 with no `copilot.answerFolder` the prompt names `_ai/answers/copilot/<requestId>_answer.json` for the
 *        `${requestId}` it carries; writing that file answers the tool (the wrapper's `generatedMarkdown`)
 *   AF-2 a configured `copilot.answerFolder` is where the prompt points and where the tool reads
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ask-copilot-file-')));
const CONFIG = path.join(WS, '.tom', 'tom_vscode_extension.json');
fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
fs.writeFileSync(CONFIG, '{}\n');

import { installVscodeStub } from './_vscode-stub.js';
const stubbed = installVscodeStub({ workspaceFolders: [WS] });
const commands = stubbed.stub.commands as Record<string, unknown>;

/** What "Copilot" saw: the prompt, the answer file it names, the request id it carries. */
const seen: Array<{ query: string; file: string; requestId: string }> = [];
commands.executeCommand = async (id: string, arg?: { query?: string }) => {
    if (id !== 'workbench.action.chat.open') { return undefined; }
    const query = String(arg?.query ?? '');
    const file = /create a JSON answer file at exactly this path:\n(.+)\n/.exec(query)?.[1] ?? '';
    const requestId = /Request ID for this prompt: (\S+)/.exec(query)?.[1] ?? '';
    seen.push({ query, file, requestId });
    // Copilot writes its answer where it was told to.
    setTimeout(() => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ requestId, generatedMarkdown: `answer to ${requestId}` }));
    }, 10);
    return undefined;
};

import { ASK_COPILOT_TOOL } from '../tool-executors.js';
import { TrailService } from '../../services/trailService.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';

TrailService.init({} as never);
TomAiConfiguration.init({} as never);

after(() => { stubbed.restore(); fs.rmSync(WS, { recursive: true, force: true }); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const ask = async (): Promise<Json> => JSON.parse(await ASK_COPILOT_TOOL.execute({ prompt: 'what is 2+2?', timeoutMs: 15_000 }));

describe('tomAi_askCopilot reads the file its prompt names', () => {
    test('AF-1: the default answer folder', async () => {
        seen.length = 0;
        const r = await ask();
        assert.equal(seen.length, 1);
        const { file, requestId } = seen[0];
        assert.match(requestId, /^[0-9a-f]+_[0-9a-f]+$/);
        assert.equal(file, path.join(WS, '_ai', 'answers', 'copilot', `${requestId}_answer.json`));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.response, `answer to ${requestId}`);
        assert.equal(r.requestId, requestId);
    });

    test('AF-2: a configured answer folder', async () => {
        fs.writeFileSync(CONFIG, JSON.stringify({ copilot: { answerFolder: 'replies/copilot' } }));
        seen.length = 0;
        const r = await ask();
        const { file, requestId } = seen[0];
        assert.equal(file, path.join(WS, 'replies', 'copilot', `${requestId}_answer.json`));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.response, `answer to ${requestId}`);
        fs.writeFileSync(CONFIG, '{}\n');
    });
});
