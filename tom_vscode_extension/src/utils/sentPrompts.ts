/**
 * The prompts as sent, per queue item (the Recent Prompts panel's *As sent*
 * view, handlers/recentPromptsPanel-handler.ts).
 *
 * Every stage the queue dispatches — a pre-prompt, a main prompt of an
 * iteration, a continuation, a follow-up, a resend — gets a record on its
 * item (`sentPrompts`, stored as `execution.sent-prompts`): its label, when it
 * went out, and the user message and system prompt exactly as the transport
 * sent them (templates, wrappers and placeholders applied; the Anthropic
 * handler reports them through `onPromptComposed`). The two texts are kept
 * once each in the queue folder's `sent-prompts/` (one file per text, named by
 * its hash): a system prompt shared by many stages is stored once, and the
 * queue files stay small. The panel's default view shows the user's prompt as
 * queued; the records are for prompt analysis (token use, what the system
 * prompt held).
 *
 * vscode-free.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** The folder of the texts, in the queue folder. */
export const SENT_PROMPTS_FOLDER = 'sent-prompts';

/** The most records an item keeps (the oldest go). */
export const MAX_SENT_RECORDS = 200;

/** The store is pruned of texts no item names once it holds more than this many files. */
export const SENT_PROMPTS_PRUNE_AT = 400;

/** One stage as sent. */
export interface SentPromptRecord {
    /** What it was, e.g. `Pre-prompt 1`, `Main prompt — todo abc1`, `Follow-up 2`, `Resend`. */
    label: string;
    /** ISO time it went out. */
    sentAt: string;
    /** The user message as sent: its text's reference in the store. */
    promptRef?: string;
    /** The system prompt as sent: its text's reference in the store. */
    systemRef?: string;
    /** Their lengths in characters (the panel shows them without loading the texts). */
    promptChars?: number;
    systemChars?: number;
}

const REF_PATTERN = /^[0-9a-f]{20}$/;

/** The reference of a text: the first 20 hex digits of its SHA-256. */
export function sentTextRef(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 20);
}

/** Keep `text` in the store (once) and answer its reference. */
export function storeSentText(queueFolder: string, text: string): string {
    const ref = sentTextRef(text);
    const dir = path.join(queueFolder, SENT_PROMPTS_FOLDER);
    const file = path.join(dir, `${ref}.md`);
    if (!fs.existsSync(file)) {
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, text, 'utf8');
        fs.renameSync(tmp, file);
    }
    return ref;
}

/** A stored text by its reference; undefined for an unknown or malformed reference. */
export function readSentText(queueFolder: string, ref: string): string | undefined {
    if (!REF_PATTERN.test(ref)) { return undefined; }
    try { return fs.readFileSync(path.join(queueFolder, SENT_PROMPTS_FOLDER, `${ref}.md`), 'utf8'); } catch { return undefined; }
}

/** `records` with `record` appended, at most {@link MAX_SENT_RECORDS} (the oldest dropped). */
export function appendSentRecord(records: readonly SentPromptRecord[] | undefined, record: SentPromptRecord, max = MAX_SENT_RECORDS): SentPromptRecord[] {
    const next = [...(records ?? []), record];
    return next.length > max ? next.slice(next.length - max) : next;
}

/** The record with the texts of a composed prompt filled in (stored first). */
export function withComposedTexts(queueFolder: string, record: SentPromptRecord, sent: { systemPrompt: string; userMessage: string }): SentPromptRecord {
    return {
        ...record,
        promptRef: storeSentText(queueFolder, sent.userMessage),
        promptChars: sent.userMessage.length,
        ...(sent.systemPrompt ? { systemRef: storeSentText(queueFolder, sent.systemPrompt), systemChars: sent.systemPrompt.length } : {}),
    };
}

/** Every reference the records name. */
export function referencedSentTexts(records: Iterable<SentPromptRecord>): Set<string> {
    const refs = new Set<string>();
    for (const r of records) {
        if (r.promptRef) { refs.add(r.promptRef); }
        if (r.systemRef) { refs.add(r.systemRef); }
    }
    return refs;
}

/**
 * Delete the stored texts no record names, once the store holds more than
 * `pruneAt` files. Answers the number deleted.
 */
export function pruneSentTexts(queueFolder: string, referenced: ReadonlySet<string>, pruneAt = SENT_PROMPTS_PRUNE_AT): number {
    const dir = path.join(queueFolder, SENT_PROMPTS_FOLDER);
    let names: string[];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')); } catch { return 0; }
    if (names.length <= pruneAt) { return 0; }
    let deleted = 0;
    for (const name of names) {
        if (referenced.has(name.slice(0, -3))) { continue; }
        try { fs.unlinkSync(path.join(dir, name)); deleted++; } catch { /* gone already */ }
    }
    return deleted;
}

/** Records from their stored YAML form (`execution.sent-prompts`); unreadable entries are dropped. */
export function sentRecordsFromYaml(raw: unknown): SentPromptRecord[] | undefined {
    if (!Array.isArray(raw)) { return undefined; }
    const out: SentPromptRecord[] = [];
    for (const e of raw) {
        if (!e || typeof e !== 'object') { continue; }
        const o = e as Record<string, unknown>;
        if (typeof o.label !== 'string' || typeof o['sent-at'] !== 'string') { continue; }
        out.push({
            label: o.label,
            sentAt: o['sent-at'],
            ...(typeof o['prompt-ref'] === 'string' ? { promptRef: o['prompt-ref'] } : {}),
            ...(typeof o['system-ref'] === 'string' ? { systemRef: o['system-ref'] } : {}),
            ...(typeof o['prompt-chars'] === 'number' ? { promptChars: o['prompt-chars'] } : {}),
            ...(typeof o['system-chars'] === 'number' ? { systemChars: o['system-chars'] } : {}),
        });
    }
    return out.length ? out : undefined;
}

/** Records in their stored YAML form. */
export function sentRecordsToYaml(records: readonly SentPromptRecord[]): Array<Record<string, unknown>> {
    return records.map((r) => ({
        label: r.label,
        'sent-at': r.sentAt,
        ...(r.promptRef ? { 'prompt-ref': r.promptRef } : {}),
        ...(r.systemRef ? { 'system-ref': r.systemRef } : {}),
        ...(r.promptChars !== undefined ? { 'prompt-chars': r.promptChars } : {}),
        ...(r.systemChars !== undefined ? { 'system-chars': r.systemChars } : {}),
    }));
}

/** What the label of a stage is built from (a subset of a queue item). */
export interface SentStageSource {
    lastDispatched?: { kind: 'prePrompt' | 'main' | 'followUp'; prePromptIndex?: number; followUpIndex?: number };
    repeatTodoId?: string;
    iterationSeq?: number;
}

/** The label of the stage an item is about to send (its `lastDispatched`, set right before every dispatch). */
export function sentStageLabel(item: SentStageSource): string {
    const last = item.lastDispatched;
    if (!last) { return 'Prompt'; }
    if (last.kind === 'prePrompt') { return `Pre-prompt ${(last.prePromptIndex ?? 0) + 1}`; }
    if (last.kind === 'followUp') { return `Follow-up ${(last.followUpIndex ?? 0) + 1}`; }
    if (item.repeatTodoId) { return `Main prompt — todo ${item.repeatTodoId}`; }
    return item.iterationSeq && item.iterationSeq > 1 ? `Main prompt (iteration ${item.iterationSeq})` : 'Main prompt';
}
