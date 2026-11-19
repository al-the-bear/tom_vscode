/**
 * The queue entry schema (`_ai/schemas/yaml/queue-entry.schema.json`, named in every `*.entry.queue.yaml` by its
 * yaml-language-server line) knows every key the queue writes (vscimpb113). Its `$defs/prompt`, the execution state,
 * the reminder and most nested objects refuse keys they do not list, so an editor would mark a key the writer
 * added without a schema entry as an error.
 *
 *   QS-1 an entry written by the queue (`_queuedPromptToDoc`) from an item with EVERY field set — the fixture is a
 *        `Required<QueuedPrompt>` (and `Required<>` pre-prompt and follow-up), so a field added to the item type does
 *        not compile until the fixture sets it — validates against the schema after the YAML round trip the entry
 *        file goes through
 *   QS-2 a key the schema does not know fails the check: on a prompt, in its execution state, in a nested object
 *   QS-3 every status an item can have is in the schema's status enum
 */

/* eslint-disable @typescript-eslint/naming-convention -- the status names and queue-file keys as they are */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import Ajv from 'ajv';
import * as yaml from 'yaml';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import { PromptQueueManager, type QueuedFollowUpPrompt, type QueuedPrePrompt, type QueuedPrompt, type QueuedPromptStatus } from '../promptQueueManager.js';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCHEMA_FILE = path.resolve(EXT_ROOT, '..', '..', '..', '_ai', 'schemas', 'yaml', 'queue-entry.schema.json');

const AT = '2026-11-15T10:00:00.000Z';

const prePrompt: Required<QueuedPrePrompt> = {
    text: 'before', template: 'T', status: 'sent', repeatCount: 2, resolvedRepeatCount: 2, repeatIndex: 1, answerWaitMinutes: 3,
    reminderTemplateId: 'r', reminderTimeoutMinutes: 5, reminderRepeat: true, reminderEnabled: true,
    transport: 'anthropic', anthropicProfileId: 'p', anthropicConfigId: 'c', answerText: 'pre answer',
};

const followUp: Required<QueuedFollowUpPrompt> = {
    id: 'fu-1', originalText: 'after', template: 'T', reminderTemplateId: 'r', reminderTimeoutMinutes: 5, reminderRepeat: true, reminderEnabled: true,
    repeatCount: 'count', resolvedRepeatCount: 3, repeatIndex: 0, answerWaitMinutes: 1, createdAt: AT,
    transport: 'anthropic', anthropicProfileId: 'p', anthropicConfigId: 'c', answerText: 'fu answer',
};

/** An item with every field set: a new field of QueuedPrompt does not compile until it is set here. */
const ITEM: Required<QueuedPrompt> = {
    id: 'item-1', template: 'T', answerWrapper: true, originalText: 'do ${repeatTodoId}', expandedText: 'do x1_a', status: 'sending', type: 'timed',
    timedEntryId: 'te-1', chatSource: 'panel', chatWindowId: 'w-1', createdAt: AT, sentAt: AT, error: 'an error',
    reminderTemplateId: 'r', reminderTimeoutMinutes: 10, reminderRepeat: true, reminderEnabled: true, reminderQueued: true, reminderSentCount: 2, lastReminderAt: AT,
    requestId: 'req-1', expectedRequestId: 'req-2', prePrompts: [prePrompt], followUps: [followUp], followUpIndex: 1,
    repeatCount: 'x*', resolvedRepeatCount: 3, repeatIndex: 1, repeatTodoId: 'x1_a', repeatPrefix: 'pre', repeatSuffix: 'suf',
    templateRepeatCount: 2, templateRepeatIndex: 1, answerWaitMinutes: 4,
    backgroundWaitLimitMinutes: 30,
    backgroundWait: { since: AT, limitMinutes: 30, limitFrom: AT, unlimited: true, items: [{ id: 'b1', kind: 'bash', description: 'build', command: 'make', outputFile: '/tmp/o' }] } as never,
    answerBackgroundLeft: true,
    waitingFor: { reason: 'pub.dev', details: 'limit', since: AT, until: AT },
    blockedOn: 'todo x2 waits for x1 (in-progress)',
    blockedTodo: 'x2',
    skippedTodos: ['x3'],
    ignoreBlockTodos: ['x4'],
    waitMessages: [{ at: AT, into: 'waitFor', text: 'still there?', answer: 'yes', resumed: true }, { at: AT, into: 'background', text: 'status?' }],
    softInterrupt: { requestedAt: Date.parse(AT), heldAt: Date.parse(AT), kind: 'tool', tool: 'Bash', heldResult: 'ok' },
    turnSessionId: 'sid-1', interruptNote: true, heldConversationFile: '/q/held/item-1.conversation.json',
    resumeAfterWait: true, walkContinuations: 2, needsAttention: 'not completed', pauseAfter: true, sendBetween: true, yieldAfterIteration: true,
    transport: 'anthropic', anthropicProfileId: 'p', anthropicConfigId: 'c',
    session: 'work', sessionCreate: { basedOn: 'default', mode: 'per-prompt', profile: 'p' },
    runId: 'run-1', iterationSeq: 2,
    processRun: { quest: 'q1', state: { process: 'p', phase: 'a', step: 'b' } as never, proceedId: 'pr-1', level: 0, run: 'chg1' },
    run: 'chg1',
    processMove: { kind: 'proceed', level: 0, label: 'Proceed', to: 'phase/step' } as never,
    processItem: true, reloadPrompt: { windowId: 'w-1' }, answerText: 'answer',
    lastDispatched: { kind: 'followUp', prePromptIndex: 0, followUpIndex: 0, expandedText: 'after', transport: 'anthropic', anthropicProfileId: 'p', anthropicConfigId: 'c', iterationKey: 'k', dispatchedAt: AT },
    warning: { kind: 'rate_limit', message: 'slow down', at: AT },
    outOfBudget: { profileId: 'p', session: 's', message: 'no credit', at: AT } as never,
    budgetFallback: { fromProfileId: 'p', toProfileId: 'q' } as never,
    waitingUntil: AT, waitingResetLabel: '3pm (UTC)',
    sendWait: { kind: 'rate_limit', until: AT, attempt: 2 },
    sendUsage: { totals: { input: 1, output: 2 }, stages: 1 } as never,
    retryAttempt: 2, retryUntil: AT, awaitingAnswer: true,
    inFlightRepetition: { stage: 'main', prevRepeatIndex: 0 } as never,
    todoClaim: { questId: 'q1', todoId: 'x1_a', priorStatus: 'not-started', claimedAt: AT, released: true } as never,
    todoIdPattern: 'x*',
    queuedBy: { quest: 'q1', run: 'r1', session: 'work' },
    itemKind: 'prefix',
    groupSelection: { checked: ['x2_a'], unchecked: ['x3_a'] },
    walkedTodos: ['x1_a'],
    openAsk: { tool: 'tomAi_askUser', input: { questions: ['Which one?'], title: 'Pick' }, windowId: 'w1', startedAt: AT },
    repetitionAnswers: [{ key: 'x1_a', text: 'done', at: AT, backgroundLeft: true, continuations: 1, earlier: ['first'] }],
    doneNotificationPrompt: 'tell me', doneNotificationDisabled: true, doneNotificationQueuedFor: 'chg1', doneNotificationQuest: 'q2', doneNotificationRun: 'r2',
    doneNotificationPosted: { quest: 'q2', run: 'r2', file: 'f.yaml', waiting: true, at: AT },
    notificationOf: 'item-0',
    from: { quest: 'q0', run: 'r0', windowId: 'w-0', host: 'mbp', sentAt: AT },
    temporarySession: true,
};

/** The entry file's document as the queue writes it, through the YAML round trip of `writeEntry`. */
function written(item: QueuedPrompt): Record<string, unknown> {
    const writer = (PromptQueueManager.prototype as unknown as { _queuedPromptToDoc(this: unknown, i: QueuedPrompt, q?: string, o?: number): unknown })._queuedPromptToDoc;
    const doc = writer.call(Object.create(PromptQueueManager.prototype), item, 'q1', 3);
    return yaml.parse(yaml.stringify(doc, { lineWidth: 120 })) as Record<string, unknown>;
}

function validator(t: { skip(msg: string): void }): ((doc: unknown) => string[]) | undefined {
    if (!fs.existsSync(SCHEMA_FILE)) { t.skip(`no _ai checkout (${SCHEMA_FILE})`); return undefined; }
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    const validate = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8')));
    return (doc) => (validate(doc) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}${e.params && 'additionalProperty' in e.params ? ` (${String(e.params.additionalProperty)})` : ''}`));
}

describe('the queue entry schema knows every key the queue writes', () => {
    test('QS-1: an entry with every field set validates', (t) => {
        const check = validator(t);
        if (!check) { return; }
        const doc = written(ITEM);
        const prompts = doc['prompt-queue'] as Array<Record<string, unknown>>;
        assert.deepEqual(prompts.map((p) => p.type), ['main', 'preprompt', 'followup'], 'a main prompt, a pre-prompt, a follow-up');
        // The fixture reaches the writer's optional branches (spot checks: a key of each kind).
        for (const key of ['soft-interrupt', 'background-wait', 'waiting-for', 'wait-messages', 'todo-claim', 'repetition-answers', 'process-run', 'process-move', 'reload-prompt', 'session', 'reminder', 'execution']) {
            assert.ok(key in prompts[0], `the main prompt carries ${key}`);
        }
        assert.ok('last-dispatched' in (prompts[0].execution as object));
        assert.deepEqual(check(doc), []);
        // The session as a bare name too (the other branch of its oneOf).
        assert.deepEqual(check(written({ ...ITEM, sessionCreate: undefined } as never)), []);
    });

    test('QS-2: a key the schema does not know fails', (t) => {
        const check = validator(t);
        if (!check) { return; }
        const withKey = (mutate: (doc: Record<string, unknown>) => void): string[] => {
            const doc = written(ITEM);
            mutate(doc);
            return check(doc);
        };
        const main = (doc: Record<string, unknown>): Record<string, unknown> => (doc['prompt-queue'] as Array<Record<string, unknown>>)[0];
        assert.match(withKey((d) => { main(d)['brand-new-field'] = 1; }).join('\n'), /\/prompt-queue\/0 must NOT have additional properties \(brand-new-field\)/);
        assert.match(withKey((d) => { (main(d).execution as Record<string, unknown>)['new-exec'] = 1; }).join('\n'), /execution must NOT have additional properties \(new-exec\)/);
        assert.match(withKey((d) => { (main(d)['soft-interrupt'] as Record<string, unknown>).extra = 1; }).join('\n'), /soft-interrupt must NOT have additional properties \(extra\)/);
        assert.match(withKey((d) => { (d['prompt-queue'] as Array<Record<string, unknown>>)[1]['pre-new'] = 1; }).join('\n'), /\/prompt-queue\/1 must NOT have additional properties \(pre-new\)/);
    });

    test('QS-3: every status', (t) => {
        const check = validator(t);
        if (!check) { return; }
        // A status added to the type and not to this record does not compile (the record must name each one).
        const all: Record<QueuedPromptStatus, true> = {
            staged: true, pending: true, sending: true, sent: true, error: true, waiting: true, retry: true,
            'decision-needed': true, 'todo-blocked': true, interrupted: true, chat: true, 'chat-sent': true,
        };
        for (const status of Object.keys(all) as QueuedPromptStatus[]) {
            assert.deepEqual(check(written({ ...ITEM, status })), [], status);
        }
    });
});
