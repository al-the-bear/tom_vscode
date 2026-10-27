/**
 * The queue manager's wiring of the done-notification, the inbox and the heartbeat
 * (src/managers/promptQueueManager.ts imports vscode, so its source is read, as in queueSessionWiring.test.ts).
 *
 *   DW-1 every completion path goes through _afterItemDone, which queues the next template iteration or, after
 *        the last, finishes the item; the hook runs before the queue decides whether to advance
 *   DW-2 the three errors that will not recover finish the item (no API key, a refused request, an exhausted
 *        retry schedule); a usage limit being waited out and a scheduled retry do not
 *   DW-3 the inbox is taken up at start, on the inbox watcher and in the health check; a new session is created
 *        before the item is queued; a refused item is queued as an error and still notifies
 *   DW-4 the fields are written to and read from the entry meta; the editor and the update tool reach them
 *   DW-5 the heartbeat is written every 30 s with the pid and both servers; the panel marks a stale window gone
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** out/utils/__tests__ -> project root is three levels up. */
function source(...parts: string[]): string {
    return readFileSync(join(__dirname, '..', '..', '..', ...parts), 'utf-8');
}

function body(src: string, signature: string): string {
    const start = src.indexOf(signature);
    assert.ok(start >= 0, `${signature} not found`);
    return src.slice(start, src.indexOf('\n    }\n', start));
}

describe('queue done-notification wiring', () => {
    const queue = source('src', 'managers', 'promptQueueManager.ts');

    test('DW-1: completion paths', () => {
        const hooks = queue.match(/await this\._afterItemDone\(/g) ?? [];
        assert.equal(hooks.length, 6, 'answer-wait, answer-file, resume, continue, sendItem, resend');
        assert.equal((queue.match(/await this\._enqueueNextTemplateIterationIfNeeded\(/g) ?? []).length, 1, 'only inside the hook');
        const hook = body(queue, 'private async _afterItemDone(');
        assert.ok(hook.indexOf('_enqueueNextTemplateIterationIfNeeded') < hook.indexOf('_itemFinished'), 'the next iteration first');
        assert.match(hook, /if \(nextIteration\) \{ return; \}/, 'not finished while an iteration follows');
        const finished = body(queue, 'private async _itemFinished(');
        assert.match(finished, /planDoneNotification\(/);
        assert.match(finished, /applyPlanToItem\(/);
        assert.match(finished, /position: plan\.position/);
        assert.match(finished, /notificationOf: plan\.notificationOf/);
        assert.match(finished, /_deleteTemporarySession\(item\.session\)/);
        const deletion = body(queue, 'private _deleteTemporarySession(');
        assert.match(deletion, /deleteSession\(folder, name\)/, 'the session file');
        assert.match(deletion, /fs\.rmSync\(sessionHistoryFolder\(folder, name\)/, 'and its history folder');
    });

    test('DW-2: errors', () => {
        const marked = body(queue, 'private _markItemError(');
        const waiting = marked.slice(marked.indexOf('if (clause)'), marked.indexOf('isMissingApiKeyFailure'));
        assert.doesNotMatch(waiting, /_itemFinished/, 'a usage limit is waited out');
        const retry = marked.slice(marked.indexOf("if (decision.kind === 'retry')"), marked.indexOf('// Schedule exhausted'));
        assert.doesNotMatch(retry, /_itemFinished/, 'a scheduled retry is not the end');
        const refused = marked.slice(marked.indexOf('isUnretryableRequestError(searchText)'), marked.indexOf('// Generic (non-rate-limit) failure'));
        assert.match(refused, /_itemFinished\(item, \{ kind: 'error'/, 'a refused request');
        assert.match(marked.slice(marked.indexOf('// Schedule exhausted')), /_itemFinished\(item, \{ kind: 'error'/, 'an exhausted schedule');
        assert.match(body(queue, 'private _failForMissingApiKey('), /_itemFinished\(item, \{ kind: 'error'/, 'no API key');
    });

    test('DW-3: the inbox', () => {
        const init = body(queue, 'static init(');
        assert.match(init, /onInboxChanged\(\(\) => \{ void m\.takeInbox\(\); \}\)/);
        assert.match(init, /void m\.takeInbox\(\);/, 'files written while no window ran');
        assert.match(body(queue, 'private async runHealthCheck('), /await this\.takeInbox\(\);/);
        const take = body(queue, 'async takeInbox(');
        assert.ok(take.indexOf('claimInboxFile(') < take.indexOf('parseInboxItem('), 'claimed before it is read');
        assert.ok(take.indexOf('_queueInboxItem(') < take.indexOf('fs.rmSync(claimed'), 'deleted once queued');
        assert.match(take, /listStaleClaims\(/);
        assert.match(take, /rejectClaimedFile\(/);
        const convert = body(queue, 'private async _queueInboxItem(');
        assert.ok(convert.indexOf('createSession(folder') < convert.indexOf('this.enqueue('), 'the session exists before the first send');
        assert.match(convert, /applyErrorTransition\(item, `Sent by \$\{inbox\.from\.quest\}/);
        assert.match(convert, /await this\._itemFinished\(item, \{ kind: 'error'/, 'the sender is told');
        const storage = source('src', 'storage', 'queueFileStorage.ts');
        assert.match(storage, /createFileSystemWatcher\(new vscode\.RelativePattern\(folder, `\$\{fullPrefix\}\*\$\{INBOX_SUFFIX\}`\)\)/);
    });

    test('DW-4: persistence and editing', () => {
        assert.match(queue, /\.\.\.doneNotificationMetaFromYaml\(meta as Record<string, unknown>\)/);
        assert.match(queue, /\.\.\.doneNotificationMetaToYaml\(item\)/);
        const update = body(queue, 'updateItemDoneNotification(');
        assert.match(update, /item\.status === 'sent'/, 'until the item is finished');
        const editor = source('src', 'handlers', 'queueEditor-handler.ts');
        assert.match(editor, /case 'updateDoneNotification':/);
        assert.match(editor, /case 'setDoneNotificationDisabled':/);
        const bridge = source('src', 'handlers', 'tomScriptingBridge-handler.ts');
        assert.match(bridge.slice(bridge.indexOf("case 'queue.addVce'")), /doneNotificationPrompt: params\.doneNotificationPrompt/);
    });

    test('DW-5: heartbeat', () => {
        const ext = source('src', 'extension.ts');
        assert.match(ext, /setInterval\(\(\) => \{ void beat\(\); \}, HEARTBEAT_INTERVAL_MS\)/);
        const beat = ext.slice(ext.indexOf('const beat = async'), ext.indexOf('void beat();'));
        assert.match(beat, /pid: process\.pid/);
        assert.match(beat, /getCliServerStatus\(\)/);
        assert.match(beat, /mcpServer: getMcpServerStatus\(\)/);
        const panel = source('src', 'handlers', 'windowStatusPanel-handler.ts');
        assert.match(panel, /gone: !!s\.heartbeat && !isWindowAlive\(s, now\)/);
        assert.match(panel, /servers: serverSummary\(s\)/);
    });
});
