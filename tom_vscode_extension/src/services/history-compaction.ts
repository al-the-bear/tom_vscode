/**
 * History compaction — provider-neutral post-exchange compactor.
 *
 * Spec: anthropic_sdk_integration.md §6 (all modes), §6.5 (exported
 * interface), §7.2 (`compaction` / `memoryExtraction` template
 * categories), §7.4 (compaction placeholder values), §8.4 (compaction
 * tool set).
 *
 * Modes:
 *   - none              → return `[]` (handler sends no history)
 *   - full              → return the array unchanged
 *   - last              → keep the last `maxRounds` turns
 *   - summary           → replace everything with a 2-message synthetic
 *                         exchange `[user: summary, assistant: Understood]`
 *   - trim_and_summary  → drop oldest turns until within token budget,
 *                         prepend a single summary message of the drop
 *   - llm_extract       → compress each turn individually (per-turn
 *                         summarisation) and write extracted facts to
 *                         memory via `TwoTierMemoryService`
 *
 * The LLM dispatch is abstracted behind `runCompactionCall()`, which
 * selects between the Anthropic handler (internal, no tool loop, no
 * trail write) and a direct Ollama POST. Callers populate
 * `CompactionOptions.llmProvider` and `llmConfigId` from their config.
 */

import * as http from 'http';
import * as https from 'https';
import * as vscode from 'vscode';
import { loadSendToChatConfig } from '../utils/sendToChatConfig';
import { resolveVariables } from '../utils/variableResolver';
import { TwoTierMemoryService } from './memory-service';
import { TrailService } from './trailService';
import { ANTHROPIC_SUBSYSTEM } from './trailSubsystems';
import {
    logCompactionStart,
    logCompactionEnd,
    logMemoryExtraction,
    logMemoryWrite,
    logError as logCompactionError,
    logWarn as logCompactionWarn,
} from './compaction-log';

// ============================================================================
// Public types (spec §6.5)
// ============================================================================

/**
 * Supported history-compaction modes.
 *
 *  - `sdk-managed`     — Agent SDK only. Continuity is provided by the
 *    SDK's own session-resume mechanism: we persist the session id
 *    returned by the first call and pass it back via `resume` on
 *    subsequent calls. Our `rawTurns` / `compactedSummary` are
 *    maintained in parallel (for the history.md file + dry-run) but
 *    not injected into the user prompt.
 *  - `trim_and_summary` / `full` — works on both transports. On the
 *    direct path they drive `messages[]`. On the Agent SDK path the
 *    compacted summary + raw turns are prepended to the user prompt
 *    via the userMessage template (see the `default-memory-injection`
 *    seed template for an example).
 *  - `summary` / `llm_extract` — direct transport only, retained for
 *    dry-run parity with older workflows.
 *
 * Removed: `none` (threw away context) and `last` (degenerate case of
 * trim_and_summary). Stored configs still referencing them are mapped
 * to `trim_and_summary` at callsite level.
 */
export type HistoryMode =
    | 'sdk-managed'
    | 'full'
    | 'summary'
    | 'trim_and_summary'
    | 'llm_extract';

export type CompactionLlmProvider = 'localLlm' | 'anthropic';

export interface ConversationMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export interface CompactionOptions {
    mode: HistoryMode;
    /** Target token ceiling for the returned history (trim_and_summary). */
    maxHistoryTokens?: number;
    /** Hard cap on the character size of history content injected into
     *  the compaction + memory-extraction prompts. Also exposed to the
     *  compaction template as `${historyMaxChars}` so the LLM targets
     *  output within this size (important for MoE models where headroom
     *  above the working summary matters). Default 24000 when absent. */
    historyMaxChars?: number;
    /** Hard cap on the character size of existing memory content
     *  injected into the memory-extraction prompt. Default 8000. */
    memoryMaxChars?: number;
    /** Raw turn cap — how many user+assistant rounds are kept raw in the
     *  returned history. Applies to both `trim_and_summary` and as the
     *  trailing-tail size in future compaction strategies. */
    maxRounds?: number;
    /**
     * `full` mode max turns. Caps the returned array even in "full" mode
     * so you can't accidentally DoS the model with a gigantic history.
     * Defaults to 200 when absent.
     */
    fullTrailMaxTurns?: number;
    /** Which provider runs the LLM compaction call. */
    llmProvider: CompactionLlmProvider;
    /** Config ID within the selected provider. */
    llmConfigId: string;
    /** `compaction` Global Template Editor entry to use. */
    compactionTemplateId?: string;
    /** `memoryExtraction` template for `llm_extract` mode. */
    memoryTemplateId?: string;
    /** Tool names for the compaction loop (localLlm only; spec §8.4). */
    compactionTools?: string[];
    /** Upper bound on compaction tool rounds (default 1). */
    compactionMaxRounds?: number;
    /** Root of the memory store (only used to seed placeholders). */
    memoryPath?: string;
    /** Quest id for quest-scoped memory writes. */
    questId?: string;
    /** Whether to emit verbose progress lines (currently a no-op hook). */
    trailEnabled?: boolean;
    onProgress?: (msg: string) => void;
    /** Label for the compaction-log channel. Defaults to 'post-exchange'. */
    source?: string;
}

export interface CompactionResult {
    /** Compacted message array. */
    history: ConversationMessage[];
    /** Which mode ran. */
    modeRun: HistoryMode;
    /** Turns kept from the input (for diagnostics). */
    keptTurnCount: number;
    /** Turns dropped from the input. */
    droppedTurnCount: number;
    /** The summary text, when one was produced. */
    summary?: string;
}

// ============================================================================
// Token estimation
// ============================================================================

const CHARS_PER_TOKEN = 4;

function estimateTokens(s: string): number {
    return Math.ceil(s.length / CHARS_PER_TOKEN);
}

function historyTokens(history: ConversationMessage[]): number {
    return history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

/**
 * Rough context-window size (in tokens) for known Anthropic models.
 *
 * Used only for the compaction log's "X% of context" hint — we don't
 * enforce anything on the basis of this number. The Anthropic API
 * doesn't expose per-model limits; this table is hand-maintained. An
 * unknown model returns `undefined` and the hint is hidden.
 */
function estimateModelContextTokens(model?: string): number | undefined {
    if (!model) { return undefined; }
    // Claude 4.x: 200k native context across Opus / Sonnet / Haiku.
    if (/^claude-(opus|sonnet|haiku)-4-\d+/i.test(model)) { return 200_000; }
    return undefined;
}

function formatHistoryForTemplate(history: ConversationMessage[]): string {
    return history
        .map((m) => `[${m.role}] ${m.content}`)
        .join('\n\n');
}

// ============================================================================
// Template expansion
// ============================================================================

interface CompactionTemplateEntry {
    id: string;
    template: string;
}

interface MemoryExtractionTemplateEntry {
    id: string;
    template: string;
    targetFile: string;
    scope: 'quest' | 'shared' | 'both';
}

function resolveCompactionTemplate(id?: string): CompactionTemplateEntry | undefined {
    const cfg = loadSendToChatConfig();
    const templates = cfg?.compaction?.templates ?? [];
    if (id) {
        const found = templates.find((t) => t.id === id);
        if (found) return { id: found.id, template: found.template };
    }
    // Fall back to the first available template if no ID matches.
    if (templates.length > 0) {
        return { id: templates[0].id, template: templates[0].template };
    }
    return undefined;
}

function resolveMemoryExtractionTemplate(id?: string): MemoryExtractionTemplateEntry | undefined {
    const cfg = loadSendToChatConfig();
    const templates = cfg?.compaction?.memoryExtractionTemplates ?? [];
    if (id) {
        const found = templates.find((t) => t.id === id);
        if (found) return {
            id: found.id,
            template: found.template,
            targetFile: found.targetFile,
            scope: found.scope,
        };
    }
    if (templates.length > 0) {
        const t = templates[0];
        return { id: t.id, template: t.template, targetFile: t.targetFile, scope: t.scope };
    }
    return undefined;
}

function expandTemplate(template: string, extraVars: Record<string, string>): string {
    return resolveVariables(template, { values: extraVars, enableJsExpressions: true });
}

/**
 * Upper bounds for template variables that grow unbounded over a long-
 * running session. The memory-extraction pass injects the full memory
 * file + the full compacted summary, and both can blow past a 24 GB
 * VRAM budget on local LLMs once a quest has been running a while.
 * Keep the most recent portion of each (memory's recent entries are
 * what matter for dedup decisions; old entries have already been
 * seen and recorded).
 *
 * Values are intentionally conservative defaults — make them config
 * knobs later if a user hits them. 8 KB each ≈ 2 K tokens, fine for
 * even a 4 K-ctx model and still large enough to be useful.
 */
// Fallback values when the compaction section doesn't supply them.
// Kept separate from the schema defaults so the service works even when
// loaded without config (e.g. unit tests). The config flow threads the
// current values in via CompactionOptions.historyMaxChars /
// .memoryMaxChars, which take precedence.
const DEFAULT_HISTORY_MAX_CHARS = 24000;
const DEFAULT_MEMORY_MAX_CHARS = 8000;

/**
 * Keep only the tail (most recent content) when the string exceeds
 * `maxChars`. Prefix with a short marker so the LLM sees that it was
 * given a partial view and doesn't conclude from missing content that
 * something has been forgotten.
 */
function tailBounded(text: string, maxChars: number, kind: string): string {
    if (!text || text.length <= maxChars) { return text || ''; }
    const keep = text.slice(-maxChars);
    // Trim to the start of the next line so bullets aren't chopped in
    // half — the LLM's parser gets confused by half-lines more than
    // by a frank truncation marker.
    const nl = keep.indexOf('\n');
    const body = nl > 0 ? keep.slice(nl + 1) : keep;
    return `[…${kind} truncated: showing last ${body.length} of ${text.length} chars…]\n${body}`;
}

/**
 * Keep only the head (first `maxChars`) of a string. Used for memory
 * files: entries are prepended (newest on top), so trimming the TAIL
 * drops the oldest entries — the intended behaviour. Mirrors
 * `tailBounded`'s "trim to a line boundary" hygiene so bullet lines
 * aren't chopped mid-entry.
 */
function headBounded(text: string, maxChars: number, kind: string): string {
    if (!text || text.length <= maxChars) { return text || ''; }
    const keep = text.slice(0, maxChars);
    // Trim back to the end of the last complete line so a bullet or
    // heading isn't cut in half.
    const nl = keep.lastIndexOf('\n');
    const body = nl > 0 ? keep.slice(0, nl) : keep;
    return `${body}\n[…${kind} truncated: showing first ${body.length} of ${text.length} chars (older entries dropped)…]`;
}

// ============================================================================
// LLM dispatch — internal, no tool loop, no trail write
// ============================================================================

async function runCompactionCall(
    options: CompactionOptions,
    systemPrompt: string,
    userPrompt: string,
    trailCategory: 'compaction' | 'memory' = 'compaction',
): Promise<string> {
    if (options.llmProvider === 'anthropic') {
        return runAnthropicCompaction(options, systemPrompt, userPrompt, trailCategory);
    }
    return runOllamaCompaction(options, systemPrompt, userPrompt, trailCategory);
}

async function runAnthropicCompaction(
    options: CompactionOptions,
    systemPrompt: string,
    userPrompt: string,
    trailCategory: 'compaction' | 'memory' = 'compaction',
): Promise<string> {
    // Lazy import to avoid a cycle — the Anthropic handler imports the
    // compaction module for its post-exchange `compactHistoryAsync` call.
    const { AnthropicHandler } = await import('../handlers/anthropic-handler.js');
    const handler = AnthropicHandler.instance;
    const section = loadSendToChatConfig()?.anthropic;
    const cfg = section?.configurations?.find((c) => c.id === options.llmConfigId)
        ?? section?.configurations?.find((c) => c.isDefault)
        ?? section?.configurations?.[0];
    if (!cfg) {
        throw new Error(`No anthropic configuration available for compaction (llmConfigId=${options.llmConfigId})`);
    }

    const subsystem = { ...ANTHROPIC_SUBSYSTEM, category: trailCategory };
    const windowId = vscode.env.sessionId;
    const requestId = `${trailCategory}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const questId = options.questId;

    TrailService.instance.writeRawPrompt(
        subsystem,
        `SYSTEM:\n${systemPrompt}\n\nUSER:\n${userPrompt}`,
        windowId,
        requestId,
        questId,
    );

    const result = await handler.runInternalCall({
        systemPrompt,
        userPrompt,
        model: cfg.model,
        maxTokens: cfg.maxTokens ?? 2048,
        temperature: cfg.temperature,
    });

    TrailService.instance.writeRawAnswer(
        subsystem,
        result,
        windowId,
        requestId,
        questId,
    );

    return result;
}

async function runOllamaCompaction(
    options: CompactionOptions,
    systemPrompt: string,
    userPrompt: string,
    trailCategory: 'compaction' | 'memory' = 'compaction',
): Promise<string> {
    const cfg = loadSendToChatConfig();
    const localCfg = cfg?.localLlm?.configurations?.find((c) => c.id === options.llmConfigId)
        ?? cfg?.localLlm?.configurations?.find((c) => c.isDefault)
        ?? cfg?.localLlm?.configurations?.[0];
    if (!localCfg || !localCfg.ollamaUrl || !localCfg.model) {
        throw new Error(`No complete Ollama configuration for compaction (llmConfigId=${options.llmConfigId})`);
    }

    // Trail — write to localllm-compaction/{quest}/ so both Ollama and
    // Anthropic compaction calls are visible in the same viewer category.
    const subsystem = { type: 'localLlm' as const, configName: `compaction-${trailCategory}` };
    const windowId = vscode.env.sessionId;
    const requestId = `${trailCategory}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const questId = options.questId;
    TrailService.instance.writeRawPrompt(
        subsystem,
        `MODEL: ${localCfg.model}\nSYSTEM:\n${systemPrompt}\n\nUSER:\n${userPrompt}`,
        windowId,
        requestId,
        questId,
    );

    const body = JSON.stringify({
        model: localCfg.model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        stream: false,
        options: { temperature: localCfg.temperature ?? 0.3 },
    });
    const url = new URL(localCfg.ollamaUrl.replace(/\/$/, '') + '/api/chat');
    const lib = url.protocol === 'https:' ? https : http;
    const result = await new Promise<string>((resolve, reject) => {
        const req = lib.request(
            {
                method: 'POST',
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(body),
                },
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c) => chunks.push(Buffer.from(c)));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                        reject(new Error(`Ollama compaction HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
                        return;
                    }
                    try {
                        const json = JSON.parse(text) as { message?: { content?: string } };
                        resolve(json.message?.content ?? '');
                    } catch (e) {
                        reject(new Error(`Ollama compaction JSON parse: ${(e as Error).message}`));
                    }
                });
            },
        );
        req.on('error', reject);
        req.write(body);
        req.end();
    });

    TrailService.instance.writeRawAnswer(subsystem, result, windowId, requestId, questId);

    return result;
}

// ============================================================================
// Mode implementations
// ============================================================================

/**
 * `full` mode — keep the history as-is, bounded by `fullTrailMaxTurns`
 * (defaults to 200) so a runaway session can't blow the context window
 * when the user chose "no compaction".
 */
function runFull(history: ConversationMessage[], options: CompactionOptions): CompactionResult {
    const cap = Math.max(1, options.fullTrailMaxTurns ?? 200);
    const keep = Math.min(history.length, cap);
    const kept = history.slice(-keep);
    return {
        history: kept,
        modeRun: 'full',
        keptTurnCount: kept.length,
        droppedTurnCount: history.length - kept.length,
    };
}

async function runSummary(
    history: ConversationMessage[],
    options: CompactionOptions,
): Promise<CompactionResult> {
    if (history.length === 0) {
        return { history: [], modeRun: 'summary', keptTurnCount: 0, droppedTurnCount: 0 };
    }
    const tpl = resolveCompactionTemplate(options.compactionTemplateId);
    if (!tpl) {
        options.onProgress?.('summary: no compaction template configured — falling back to `full`');
        return runFull(history, options);
    }
    // Batch summary uses the same placeholder vocabulary as the
    // incremental path — `existingSummary` is empty, `lastTurn` carries
    // the full history. This keeps the default compaction template
    // reusable for dry runs without branching.
    const historyText = formatHistoryForTemplate(history);
    const budget = options.maxHistoryTokens ?? 8000;
    const userPrompt = expandTemplate(tpl.template, {
        existingSummary: '(empty — batch summary of the whole history)',
        lastTurn: historyText,
        lastTurnCharCount: String(historyText.length),
        maxHistorySize: String(budget * CHARS_PER_TOKEN),
        maxHistoryTokens: String(budget),
    });
    const summary = (await runCompactionCall(options, 'You compact conversation history.', userPrompt)).trim()
        || '(empty summary)';
    return {
        history: [
            { role: 'user', content: `[Context from earlier]\n${summary}` },
            { role: 'assistant', content: 'Understood.' },
        ],
        modeRun: 'summary',
        keptTurnCount: 2,
        droppedTurnCount: history.length,
        summary,
    };
}

async function runTrimAndSummary(
    history: ConversationMessage[],
    options: CompactionOptions,
): Promise<CompactionResult> {
    const budget = options.maxHistoryTokens ?? 8000;
    const total = historyTokens(history);
    if (total <= budget) {
        return runFull(history, options);
    }
    // Walk from newest to oldest until adding one more turn would exceed
    // budget; everything older is overflow.
    let used = 0;
    let splitIdx = history.length;
    for (let i = history.length - 1; i >= 0; i--) {
        const t = estimateTokens(history[i].content);
        if (used + t > budget) {
            break;
        }
        used += t;
        splitIdx = i;
    }
    const overflow = history.slice(0, splitIdx);
    const kept = history.slice(splitIdx);
    if (overflow.length === 0) {
        return { history: kept, modeRun: 'trim_and_summary', keptTurnCount: kept.length, droppedTurnCount: 0 };
    }
    const tpl = resolveCompactionTemplate(options.compactionTemplateId);
    let summary = '';
    if (tpl) {
        // Same placeholder vocabulary as the incremental path:
        // `existingSummary` carries context (empty for trim_and_summary),
        // `lastTurn` carries what's being summarised (the overflow).
        const overflowText = formatHistoryForTemplate(overflow);
        const userPrompt = expandTemplate(tpl.template, {
            existingSummary: `(empty — compacting ${overflow.length} overflow messages)`,
            lastTurn: overflowText,
            lastTurnCharCount: String(overflowText.length),
            maxHistorySize: String(budget * CHARS_PER_TOKEN),
            maxHistoryTokens: String(budget),
        });
        summary = (await runCompactionCall(options, 'You compact conversation history.', userPrompt)).trim();
    } else {
        options.onProgress?.('trim_and_summary: no compaction template — using raw overflow as summary');
        summary = overflow.map((m) => `[${m.role}] ${m.content.slice(0, 120)}`).join('\n');
    }
    return {
        history: [
            { role: 'user', content: `[Context from earlier]\n${summary || '(empty summary)'}` },
            { role: 'assistant', content: 'Understood.' },
            ...kept,
        ],
        modeRun: 'trim_and_summary',
        keptTurnCount: kept.length,
        droppedTurnCount: overflow.length,
        summary,
    };
}

async function runLlmExtract(
    history: ConversationMessage[],
    options: CompactionOptions,
): Promise<CompactionResult> {
    if (history.length === 0) {
        return { history: [], modeRun: 'llm_extract', keptTurnCount: 0, droppedTurnCount: 0 };
    }
    const tpl = resolveMemoryExtractionTemplate(options.memoryTemplateId);
    if (!tpl) {
        options.onProgress?.('llm_extract: no memoryExtraction template configured — skipping extraction');
        // With no extraction template, behave like trim_and_summary so the
        // caller still gets a size-bounded history back.
        return runTrimAndSummary(history, options);
    }
    // Pair user/assistant turns into exchanges and extract from the
    // most recent complete exchange only. The older turns are trimmed
    // via `last` semantics so the returned history stays bounded.
    const pairs: ConversationMessage[][] = [];
    for (let i = 0; i < history.length - 1; i++) {
        if (history[i].role === 'user' && history[i + 1].role === 'assistant') {
            pairs.push([history[i], history[i + 1]]);
            i++;
        }
    }
    const latest = pairs[pairs.length - 1];
    if (latest) {
        try {
            const memorySvc = TwoTierMemoryService.instance;
            const scope = tpl.scope === 'shared' ? 'shared' : 'quest';
            const existing = memorySvc.read(scope, tpl.targetFile, options.questId);
            const recentHistoryText = formatHistoryForTemplate(latest);
            const memoryFilePath = memorySvc.filePath(scope, tpl.targetFile, options.questId);
            const memoryCap = options.memoryMaxChars ?? DEFAULT_MEMORY_MAX_CHARS;
            const historyCap = options.historyMaxChars ?? DEFAULT_HISTORY_MAX_CHARS;
            const userPrompt = expandTemplate(tpl.template, {
                recentHistory: recentHistoryText,
                existingMemory: headBounded(existing, memoryCap, 'existing memory'),
                memoryFilePath,
                memoryScope: scope,
                historyMaxChars: String(historyCap),
                memoryMaxChars: String(memoryCap),
            });
            const rawExtracted = (await runCompactionCall(options, 'You extract key facts for memory.', userPrompt, 'memory')).trim();
            // Same bullet-only filter as in runIncrementalMemoryExtraction —
            // the llm_extract rebuild path uses a different template,
            // but the "empty OR bullets only" output contract is the
            // same, so prose slips through here too.
            const extracted = rawExtracted
                .split(/\r?\n/)
                .map((ln) => ln.trim())
                .filter((ln) => /^[-*+]\s+\S/.test(ln))
                .join('\n')
                .trim();
            if (!extracted && rawExtracted) {
                logCompactionWarn(`memory extraction produced non-bullet prose — discarded (template=${tpl.id}, first120=${rawExtracted.slice(0, 120).replace(/\n/g, ' ')})`);
            }
            const memoryTemplateName = loadSendToChatConfig()?.compaction?.memoryExtractionTemplates?.find((t) => t.id === tpl.id)?.name;
            const memoryModel = options.llmProvider === 'anthropic'
                ? loadSendToChatConfig()?.anthropic?.configurations?.find((c) => c.id === options.llmConfigId)?.model
                : loadSendToChatConfig()?.localLlm?.configurations?.find((c) => c.id === options.llmConfigId)?.model;
            logMemoryExtraction({
                templateId: tpl.id,
                templateName: memoryTemplateName,
                provider: options.llmProvider,
                configId: options.llmConfigId,
                model: memoryModel,
                scope: tpl.scope,
                targetFile: tpl.targetFile,
                outputChars: extracted.length,
                questId: options.questId,
            });
            if (extracted) {
                if (tpl.scope === 'both') {
                    memorySvc.prepend('quest', tpl.targetFile, extracted, options.questId);
                    memorySvc.prepend('shared', tpl.targetFile, extracted, options.questId);
                    logMemoryWrite(`quest:${tpl.targetFile}`, Buffer.byteLength(extracted, 'utf8'), 'prepend');
                    logMemoryWrite(`shared:${tpl.targetFile}`, Buffer.byteLength(extracted, 'utf8'), 'prepend');
                } else {
                    memorySvc.prepend(scope, tpl.targetFile, extracted, options.questId);
                    logMemoryWrite(`${scope}:${tpl.targetFile}`, Buffer.byteLength(extracted, 'utf8'), 'prepend');
                }
            } else {
                logCompactionWarn(`memory extraction returned empty output (template=${tpl.id})`);
            }
        } catch (e) {
            options.onProgress?.(`llm_extract: memory write failed: ${e instanceof Error ? e.message : String(e)}`);
            logCompactionError('memory extraction failed', e);
        }
    }
    // Return the trimmed-last history so the next prompt isn't drowned
    // in turns we've already distilled into memory.
    const rounds = Math.max(1, options.maxRounds ?? 1);
    const keep = Math.min(history.length, rounds * 2);
    const kept = history.slice(-keep);
    return {
        history: kept,
        modeRun: 'llm_extract',
        keptTurnCount: kept.length,
        droppedTurnCount: history.length - kept.length,
    };
}

// ============================================================================
// Incremental (every-turn) compaction + memory extraction
// ============================================================================

/**
 * Incremental compaction: integrate the last user/assistant exchange
 * into the existing compacted summary. Returns the NEW summary (or
 * empty string on failure). Callers assign it to their session state
 * atomically.
 *
 * Template placeholders: `${existingSummary}`, `${lastTurn}`,
 * `${maxHistoryTokens}`, `${maxHistorySize}` (char target = tokens × 4),
 * `${historyMaxChars}` (hard cap on injected history size — use this
 * to steer the LLM toward a summary that fits), `${lastTurnCharCount}`.
 */
export async function runIncrementalCompaction(params: {
    existingSummary: string;
    lastTurn: ConversationMessage[];
    llmProvider: CompactionLlmProvider;
    llmConfigId: string;
    compactionTemplateId?: string;
    maxHistoryTokens?: number;
    historyMaxChars?: number;
    questId?: string;
}): Promise<string> {
    const tpl = resolveCompactionTemplate(params.compactionTemplateId);
    if (!tpl) { return params.existingSummary; }
    const budget = params.maxHistoryTokens ?? 8000;
    const historyCap = params.historyMaxChars ?? DEFAULT_HISTORY_MAX_CHARS;
    const lastTurnText = formatHistoryForTemplate(params.lastTurn);
    // Trim the existing summary before feeding it back in — on a long
    // session, the summary itself can outgrow the MoE model's working
    // context. Prefer the newest portion (tail) since that's the part
    // that integrates with the new turn.
    const boundedExisting = tailBounded(params.existingSummary, historyCap, 'existing summary');
    const userPrompt = expandTemplate(tpl.template, {
        existingSummary: boundedExisting || '(empty — this is the first turn of the session)',
        lastTurn: lastTurnText,
        lastTurnCharCount: String(params.lastTurn.reduce((n, m) => n + (m.content?.length ?? 0), 0)),
        maxHistorySize: String(budget * CHARS_PER_TOKEN),
        maxHistoryTokens: String(budget),
        historyMaxChars: String(historyCap),
    });
    const options: CompactionOptions = {
        mode: 'trim_and_summary',
        llmProvider: params.llmProvider,
        llmConfigId: params.llmConfigId,
        compactionTemplateId: params.compactionTemplateId,
        maxHistoryTokens: budget,
        historyMaxChars: historyCap,
        questId: params.questId,
        source: 'every-turn',
    };
    return (await runCompactionCall(options, 'You compact conversation history.', userPrompt)).trim();
}

/**
 * Every-turn memory extraction. Input: last exchange + current
 * compacted summary + existing memory file. Output is handled by the
 * underlying compaction LLM call and appended to the quest (or shared)
 * memory file by the service.
 *
 * Template placeholders: `${lastTurn}`, `${compactedSummary}`,
 * `${existingMemory}`, `${memoryFilePath}`, `${memoryScope}`.
 */
export async function runIncrementalMemoryExtraction(params: {
    lastTurn: ConversationMessage[];
    compactedSummary: string;
    llmProvider: CompactionLlmProvider;
    llmConfigId: string;
    memoryTemplateId?: string;
    historyMaxChars?: number;
    memoryMaxChars?: number;
    questId?: string;
}): Promise<void> {
    const tpl = resolveMemoryExtractionTemplate(params.memoryTemplateId);
    if (!tpl) { return; }
    const memorySvc = TwoTierMemoryService.instance;
    const scope = tpl.scope === 'shared' ? 'shared' : 'quest';
    const existing = memorySvc.read(scope, tpl.targetFile, params.questId);
    const memoryFilePath = memorySvc.filePath(scope, tpl.targetFile, params.questId);
    const historyCap = params.historyMaxChars ?? DEFAULT_HISTORY_MAX_CHARS;
    const memoryCap = params.memoryMaxChars ?? DEFAULT_MEMORY_MAX_CHARS;
    const userPrompt = expandTemplate(tpl.template, {
        lastTurn: formatHistoryForTemplate(params.lastTurn),
        compactedSummary: tailBounded(params.compactedSummary, historyCap, 'compacted summary'),
        // Memory files are prepended newest-first, so keeping the HEAD
        // preserves the newest entries — the opposite of the tail-keep
        // behaviour we use for summaries. Older entries at the bottom
        // of the file fall off cleanly when the cap is exceeded.
        existingMemory: headBounded(existing, memoryCap, 'existing memory'),
        memoryFilePath,
        memoryScope: scope,
        historyMaxChars: String(historyCap),
        memoryMaxChars: String(memoryCap),
    });
    const options: CompactionOptions = {
        mode: 'trim_and_summary',
        llmProvider: params.llmProvider,
        llmConfigId: params.llmConfigId,
        memoryTemplateId: params.memoryTemplateId,
        questId: params.questId,
        source: 'every-turn',
    };
    const rawExtracted = (await runCompactionCall(
        options,
        'You extract durable facts worth remembering.',
        userPrompt,
        'memory',
    )).trim();
    // Defensive post-filter: the prompt instructs the model to emit
    // ONLY bullet lines or an empty response, but some models (esp.
    // smaller local ones) still produce prose like "Nothing new
    // worth remembering." Drop every line that isn't a markdown
    // bullet so that kind of output never makes it into the memory
    // file. If the filter empties the output, treat as empty.
    const extracted = rawExtracted
        .split(/\r?\n/)
        .map((ln) => ln.trim())
        .filter((ln) => /^[-*+]\s+\S/.test(ln))
        .join('\n')
        .trim();
    if (!extracted) {
        if (rawExtracted) {
            logCompactionWarn(`memory extraction produced non-bullet prose — discarded (template=${tpl.id}, first120=${rawExtracted.slice(0, 120).replace(/\n/g, ' ')})`);
        } else {
            logCompactionWarn(`memory extraction returned empty output (template=${tpl.id})`);
        }
        return;
    }
    const model = params.llmProvider === 'anthropic'
        ? loadSendToChatConfig()?.anthropic?.configurations?.find((c) => c.id === params.llmConfigId)?.model
        : loadSendToChatConfig()?.localLlm?.configurations?.find((c) => c.id === params.llmConfigId)?.model;
    logMemoryExtraction({
        templateId: tpl.id,
        templateName: loadSendToChatConfig()?.compaction?.memoryExtractionTemplates?.find((t) => t.id === tpl.id)?.name,
        provider: params.llmProvider,
        configId: params.llmConfigId,
        model,
        scope: tpl.scope,
        targetFile: tpl.targetFile,
        outputChars: extracted.length,
        questId: params.questId,
    });
    // Prepend newest entries on top of the memory file. Combined with
    // headBounded at read-time, older entries at the bottom fall off
    // cleanly when the file outgrows memoryMaxChars.
    if (tpl.scope === 'both') {
        memorySvc.prepend('quest', tpl.targetFile, extracted, params.questId);
        memorySvc.prepend('shared', tpl.targetFile, extracted, params.questId);
        logMemoryWrite(`quest:${tpl.targetFile}`, Buffer.byteLength(extracted, 'utf8'), 'prepend');
        logMemoryWrite(`shared:${tpl.targetFile}`, Buffer.byteLength(extracted, 'utf8'), 'prepend');
    } else {
        memorySvc.prepend(scope, tpl.targetFile, extracted, params.questId);
        logMemoryWrite(`${scope}:${tpl.targetFile}`, Buffer.byteLength(extracted, 'utf8'), 'prepend');
    }
}

// ============================================================================
// Trail-based rebuild
// ============================================================================

/**
 * Parse the last N exchanges from the quest's compact trail files
 * (`<quest>.anthropic.prompts.md` + `.answers.md`) and return them as
 * paired user/assistant strings, most recent last.
 *
 * Entries have a `=== PROMPT <requestId> <timestamp> <seq> ===` header;
 * we walk headers from newest to oldest until we hit `n` or run out.
 */
export function loadLastNTrailExchanges(
    questId: string,
    n: number,
): Array<{ user: string; assistant: string }> {
    const limit = Math.max(1, n);
    try {
        // Resolve the trail summary file paths via TrailService.
        const prompts = TrailService.instance.getSummaryFilePath('prompts', { type: 'anthropic' as const }, questId);
        const answers = TrailService.instance.getSummaryFilePath('answers', { type: 'anthropic' as const }, questId);
        if (!prompts || !answers) { return []; }
        const fsMod = require('fs') as typeof import('fs');
        const readEntries = (file: string): Map<string, string> => {
            const out = new Map<string, string>();
            if (!fsMod.existsSync(file)) { return out; }
            const text = fsMod.readFileSync(file, 'utf-8');
            // Entries are prepended newest-first. Header:
            //   === PROMPT <id> <iso> <seq> === / === ANSWER <id> <iso> <seq> ===
            const lines = text.split(/\r?\n/);
            let currentId = '';
            let buf: string[] = [];
            const flush = (): void => {
                if (currentId) {
                    const body = buf.join('\n').replace(/\n+TEMPLATE:[\s\S]*$/, '').trim();
                    if (body && !out.has(currentId)) { out.set(currentId, body); }
                }
                buf = [];
            };
            for (const line of lines) {
                const headerMatch = line.match(/^===\s*(?:PROMPT|ANSWER)\s+(\S+)\s+\S+\s+\d+\s*===$/);
                if (headerMatch) {
                    flush();
                    currentId = headerMatch[1];
                    continue;
                }
                if (currentId) { buf.push(line); }
            }
            flush();
            return out;
        };
        const promptMap = readEntries(prompts);
        const answerMap = readEntries(answers);
        // Iterate in insertion order — the prepend pattern means the
        // first entries in each file are the newest.
        const out: Array<{ user: string; assistant: string }> = [];
        for (const [id, user] of promptMap.entries()) {
            const assistant = answerMap.get(id) ?? '';
            if (!user && !assistant) { continue; }
            out.push({ user, assistant });
            if (out.length >= limit) { break; }
        }
        // Reverse so callers get chronological order (oldest first).
        return out.reverse();
    } catch {
        return [];
    }
}

// ============================================================================
// Public entry point (spec §6.5)
// ============================================================================

export async function compactHistory(
    history: ConversationMessage[],
    options: CompactionOptions,
): Promise<ConversationMessage[]> {
    const result = await compactHistoryDetailed(history, options);
    return result.history;
}

/** Same as `compactHistory` but returns the detailed `CompactionResult`. */
export async function compactHistoryDetailed(
    history: ConversationMessage[],
    options: CompactionOptions,
): Promise<CompactionResult> {
    const startedAt = Date.now();
    const totalChars = history.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
    // Best-effort template name lookup for the log line.
    let templateName: string | undefined;
    if (options.compactionTemplateId) {
        const entry = loadSendToChatConfig()?.compaction?.templates?.find((t) => t.id === options.compactionTemplateId);
        templateName = entry?.name;
    }
    const model = options.llmProvider === 'anthropic'
        ? loadSendToChatConfig()?.anthropic?.configurations?.find((c) => c.id === options.llmConfigId)?.model
        : loadSendToChatConfig()?.localLlm?.configurations?.find((c) => c.id === options.llmConfigId)?.model;

    const inputTokens = historyTokens(history);
    const contextLimit = estimateModelContextTokens(model);
    const contextWindowPct = contextLimit ? (inputTokens / contextLimit) * 100 : undefined;
    logCompactionStart({
        mode: options.mode,
        provider: options.llmProvider,
        configId: options.llmConfigId,
        model,
        templateId: options.compactionTemplateId,
        templateName,
        turnCount: history.length,
        totalChars,
        estimatedTokens: inputTokens,
        contextWindowPct,
        maxHistoryTokens: options.maxHistoryTokens,
        maxRounds: options.maxRounds,
        fullTrailMaxTurns: options.fullTrailMaxTurns,
        questId: options.questId,
        source: options.source ?? 'post-exchange',
    });

    let result: CompactionResult;
    try {
        // Back-compat for stored configs that still reference 'none' or
        // 'last' — map them onto trim_and_summary so a session save from
        // a previous version still works.
        const mode = (options.mode as unknown as string) === 'none' || (options.mode as unknown as string) === 'last'
            ? 'trim_and_summary'
            : options.mode;
        switch (mode) {
            case 'sdk-managed':
                // Agent SDK manages continuity via resume. Our compacted
                // summary is still kept up to date in parallel (so the
                // history.md file is always readable) — but this call
                // path just passes the history through so the next turn
                // doesn't stall on a no-op LLM call.
                result = runFull(history, options); break;
            case 'full':             result = runFull(history, options); break;
            case 'summary':          result = await runSummary(history, options); break;
            case 'trim_and_summary': result = await runTrimAndSummary(history, options); break;
            case 'llm_extract':      result = await runLlmExtract(history, options); break;
            default: {
                options.onProgress?.(`compactHistory: unknown mode "${options.mode}" — passing through`);
                logCompactionWarn(`unknown mode "${options.mode}" — passing through`);
                result = runFull(history, options);
            }
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        options.onProgress?.(`compactHistory failed: ${msg}`);
        logCompactionError('compactHistory failed', e);
        // On error, return the input unchanged so the next exchange
        // doesn't lose context.
        result = runFull(history, options);
    }

    const outputChars = result.history.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
    const outputTokens = historyTokens(result.history);
    logCompactionEnd({
        keptTurnCount: result.keptTurnCount,
        droppedTurnCount: result.droppedTurnCount,
        modeRun: result.modeRun,
        outputChars,
        outputTokens,
        durationMs: Date.now() - startedAt,
    });
    return result;
}

void vscode; // imported for API-surface parity with sibling services
