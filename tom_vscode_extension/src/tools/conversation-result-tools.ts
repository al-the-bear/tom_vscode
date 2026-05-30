/**
 * AI Conversation — result-file tools.
 *
 * Two LLMs talking in the AI Conversation panel need a way to
 * **produce an outcome document** that survives the conversation.
 * Both participants share one markdown file per conversation; either
 * can read its current contents or write/append to it.
 *
 * **Default location**: `{workspace}/_ai/ai_conversation/
 * {sanitisedConversationId}.result.md`.  `conversationId` defaults to
 * `"current"`.  The file is created on first write.
 *
 * **`conversationId` sanitisation**: any character outside
 * `[a-zA-Z0-9._-]` is replaced with `_` to prevent path traversal /
 * filesystem weirdness.  The sanitised id is what the file is named
 * after.
 *
 * These tools are **the only write capability** exposed to AI
 * Conversation today — every other mutating tool is off by default.
 * Rationale: AI Conversation is experimental (bot-to-bot) and we
 * don't want either participant editing the workspace until the
 * mode is proven reliable.
 *
 * ## Coverage entry #31 refactor (audit notes)
 *
 *   - Old impls touched `vscode.workspace.workspaceFolders[0]` +
 *     `fs.*` directly — untestable without a workspace.  Carve-out
 *     introduces a narrow `ResultFileStore` dep so unit tests can
 *     drive an on-disk fixture (`os.tmpdir()`) without needing a
 *     workspace at all.
 *   - **Mixed envelopes unified**: both tools now return
 *     `{ok, ...}` / `{ok: false, error, ...}` consistently.
 *   - **Append semantics documented + tested**: the impl reads the
 *     existing file, prepends `\n` only when the existing content
 *     doesn't end with one, then writes back.  This is a read-
 *     modify-write — subject to a race if two writers concurrently
 *     append to the same `conversationId`.  Bot-to-bot conversations
 *     are turn-based so the race is normally moot; the description
 *     calls it out so the model knows to use distinct
 *     `conversationId` for genuinely parallel conversations.
 *   - **Multi-conversation isolation**: each `conversationId` maps
 *     to its own file.  Passing the same id from two parallel
 *     conversations will clobber.  Documented + tested.
 *   - **conversationId sanitisation** documented in the description
 *     (was a silent transformation).
 */

import { SharedToolDefinition } from './shared-tool-registry';
import * as path from 'path';

// ===========================================================================
// Narrow dep
// ===========================================================================

export interface ResultFileStore {
    /** Absolute path to the workspace folder, or undefined. */
    workspaceRoot(): string | undefined;
    /** AI folder name (typically `_ai`). */
    aiFolderName(): string;
    fileExists(absolutePath: string): boolean;
    /** Read the file; throws on I/O error. */
    readFile(absolutePath: string): { content: string; size: number; modified: Date };
    /** Write the file; ensures the parent dir exists. */
    writeFile(absolutePath: string, content: string): void;
    /** Mirror of `fs.statSync(p).size`. */
    fileSize(absolutePath: string): number;
}

// ===========================================================================
// JSON envelopes
// ===========================================================================

function ok<T extends object>(extra: T): string { return JSON.stringify({ ok: true, ...extra }); }
function err(message: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ ok: false, error: message, ...extra });
}

// ===========================================================================
// Path resolution + sanitisation
// ===========================================================================

const CONVERSATION_DIR = 'ai_conversation';
const DEFAULT_CONVERSATION_ID = 'current';

/** Replace anything outside `[a-zA-Z0-9._-]` with `_`. */
export function sanitiseConversationId(raw: string): string {
    return raw.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function resolveResultFile(store: ResultFileStore, rawId: string): { absolute: string; relative: string; conversationId: string } | undefined {
    const root = store.workspaceRoot();
    if (!root) { return undefined; }
    const conversationId = sanitiseConversationId(rawId || DEFAULT_CONVERSATION_ID);
    const dir = path.join(root, store.aiFolderName(), CONVERSATION_DIR);
    const absolute = path.join(dir, `${conversationId}.result.md`);
    const relative = path.relative(root, absolute);
    return { absolute, relative, conversationId };
}

// ===========================================================================
// `tomAi_readConversationResult`
// ===========================================================================

export interface ReadConversationResultInput {
    conversationId?: string;
}

export async function readConversationResultImpl(store: ResultFileStore, input: ReadConversationResultInput): Promise<string> {
    try {
        const rawId = input.conversationId ?? DEFAULT_CONVERSATION_ID;
        const resolved = resolveResultFile(store, rawId);
        if (!resolved) { return err('No workspace open.'); }
        if (!store.fileExists(resolved.absolute)) {
            return ok({
                conversationId: resolved.conversationId,
                rawConversationId: rawId,
                exists: false,
                size: 0,
                content: '',
                path: resolved.relative,
                note: 'Result file does not exist yet. Call tomAi_writeConversationResult to create it.',
            });
        }
        const { content, size, modified } = store.readFile(resolved.absolute);
        return ok({
            conversationId: resolved.conversationId,
            rawConversationId: rawId,
            exists: true,
            size,
            modified: modified.toISOString(),
            path: resolved.relative,
            content,
        });
    } catch (e) {
        return err(`readConversationResult failed: ${(e as Error).message}`);
    }
}

export const READ_CONVERSATION_RESULT_DESCRIPTION =
    'Read the current AI Conversation result document. **File location**: ' +
    '`{workspace}/_ai/ai_conversation/{sanitisedConversationId}.result.md`. ' +
    '**`conversationId` sanitisation**: any character outside ' +
    '`[a-zA-Z0-9._-]` is replaced with `_` — the sanitised id is what the ' +
    'file is named after and is echoed back as `conversationId` in the ' +
    'response (with the original passed-in value in `rawConversationId`). ' +
    'Default `conversationId: "current"`. Returns ' +
    '`{ok, exists, content, size, modified, path}`. When the file does ' +
    'not exist yet, `exists: false` + empty content (NOT an error) so the ' +
    'caller can pick up where the conversation left off without special-' +
    'casing.';

export const READ_CONVERSATION_RESULT_TOOL: SharedToolDefinition<ReadConversationResultInput> = {
    name: 'tomAi_readConversationResult',
    displayName: 'Read Conversation Result',
    description: READ_CONVERSATION_RESULT_DESCRIPTION,
    tags: ['aiConversation', 'result', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            conversationId: {
                type: 'string',
                description: 'Conversation identifier. Defaults to "current". Sanitised: `[^a-zA-Z0-9._-]` → `_`.',
            },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// `tomAi_writeConversationResult`
// ===========================================================================

export type WriteMode = 'replace' | 'append';

export interface WriteConversationResultInput {
    content: string;
    mode?: WriteMode;
    conversationId?: string;
}

export async function writeConversationResultImpl(store: ResultFileStore, input: WriteConversationResultInput): Promise<string> {
    try {
        if (typeof input.content !== 'string') {
            return err('`content` is required and must be a string.');
        }
        const rawId = input.conversationId ?? DEFAULT_CONVERSATION_ID;
        const resolved = resolveResultFile(store, rawId);
        if (!resolved) { return err('No workspace open.'); }
        const mode: WriteMode = input.mode === 'append' ? 'append' : 'replace';
        if (mode === 'append' && store.fileExists(resolved.absolute)) {
            const existing = store.readFile(resolved.absolute).content;
            const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
            store.writeFile(resolved.absolute, existing + separator + input.content);
        } else {
            store.writeFile(resolved.absolute, input.content);
        }
        return ok({
            conversationId: resolved.conversationId,
            rawConversationId: rawId,
            mode,
            size: store.fileSize(resolved.absolute),
            path: resolved.relative,
        });
    } catch (e) {
        return err(`writeConversationResult failed: ${(e as Error).message}`);
    }
}

export const WRITE_CONVERSATION_RESULT_DESCRIPTION =
    'Write or append to the AI Conversation result document. **Modes**: ' +
    '`"replace"` (default) overwrites the file with `content`; ' +
    '`"append"` reads the existing file, adds `content` after a ' +
    '`\\n` separator (only inserted when the existing file does not ' +
    'already end with one), then writes the combined result back. ' +
    '**Append is read-modify-write — NOT atomic.** Bot-to-bot ' +
    'conversations are turn-based so concurrent writes are unusual; if ' +
    'you genuinely need parallel conversations, pass distinct ' +
    '`conversationId` values so each one writes to its own file. ' +
    '**Multi-conversation isolation**: each `conversationId` maps to a ' +
    'separate file — `conversationId: "alpha"` and ' +
    '`conversationId: "beta"` never see each other. Default ' +
    '`conversationId: "current"`. This is the **only mutation tool** ' +
    'available to AI Conversation participants.';

export const WRITE_CONVERSATION_RESULT_TOOL: SharedToolDefinition<WriteConversationResultInput> = {
    name: 'tomAi_writeConversationResult',
    displayName: 'Write Conversation Result',
    description: WRITE_CONVERSATION_RESULT_DESCRIPTION,
    tags: ['aiConversation', 'result', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        required: ['content'],
        properties: {
            content: { type: 'string', description: 'Markdown content to write or append.' },
            mode: {
                type: 'string',
                enum: ['replace', 'append'],
                description: '`replace` (default) overwrites; `append` adds after a `\\n` separator.',
            },
            conversationId: {
                type: 'string',
                description: 'Conversation identifier. Defaults to "current". Sanitised: `[^a-zA-Z0-9._-]` → `_`.',
            },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// Live vscode bridge
// ===========================================================================

import * as vscode from 'vscode';
import * as fs from 'fs';
import { WsPaths } from '../utils/workspacePaths';

const liveStore: ResultFileStore = {
    workspaceRoot() { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; },
    aiFolderName() { return WsPaths.aiFolder; },
    fileExists(p) {
        try { return fs.existsSync(p) && fs.statSync(p).isFile(); }
        catch { return false; }
    },
    readFile(p) {
        const content = fs.readFileSync(p, 'utf8');
        const stat = fs.statSync(p);
        return { content, size: stat.size, modified: stat.mtime };
    },
    writeFile(p, content) {
        const dir = path.dirname(p);
        if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
        fs.writeFileSync(p, content, 'utf8');
    },
    fileSize(p) {
        try { return fs.statSync(p).size; }
        catch { return 0; }
    },
};

READ_CONVERSATION_RESULT_TOOL.execute  = (input) => readConversationResultImpl(liveStore, input);
WRITE_CONVERSATION_RESULT_TOOL.execute = (input) => writeConversationResultImpl(liveStore, input);

// ===========================================================================
// Master list
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CONVERSATION_RESULT_TOOLS: SharedToolDefinition<any>[] = [
    READ_CONVERSATION_RESULT_TOOL,
    WRITE_CONVERSATION_RESULT_TOOL,
];
