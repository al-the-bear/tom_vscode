/**
 * Trail Logger - Comprehensive logging of AI interactions
 * 
 * Writes timestamped files to configurable trail folders for debugging
 * and audit purposes. Each new prompt/conversation clears the trail.
 * 
 * Trail folders:
 *   - _ai/local/trail/     - Local LLM interactions
 *   - _ai/conversation/trail/ - Bot conversation interactions
 *   - _ai/tomai/trail/     - Tom AI chat interactions  
 *   - _ai/copilot/trail/   - Copilot interactions
 *   - _ai/trail/escalation/<trailId>/ - Escalation tool interactions
 * 
 * File naming pattern:
 *   <YYYYMMDD>_<HHMMSS>_<NNN>_<type>_<detail>.md|.json
 *   
 * Step types and formats:
 *   - prompt_to_<model>              .md    Prompt sent to model
 *   - response_partial_from_<model>  .md    Response before tool call
 *   - response_final_from_<model>    .md    Final response
 *   - toolrequest_<toolname>         .json  Tool invocation request
 *   - toolresult_<toolname>          .json  Tool execution result
 *   - continuation_to_<model>        .md    Continuation after tool result
 *   - copilot_answer                 .json  Copilot answer file content
 *   - summarization_prompt_<model>   .md    Summarization prompt
 *   - summarization_response_<model> .md    Summarization response
 *   - error                          .md    Error details
 * 
 * Examples:
 *   20260212_175442_001_prompt_to_ollama.md
 *   20260212_175459_002_response_partial_from_ollama.md
 *   20260212_175459_003_toolrequest_tom_websearch.json
 *   20260212_175501_004_toolresult_tom_websearch.json
 *   20260212_175501_005_continuation_to_ollama.md
 *   20260212_175551_018_response_final_from_ollama.md
 *   20260212_103015_007_prompt_to_copilot.md
 *   20260212_103045_008_copilot_answer.json
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getConfigPath } from './handler_shared';
import { WsPaths } from '../utils/workspacePaths';
import { FsUtils } from '../utils/fsUtils';
import { TomAiConfiguration } from '../utils/tomAiConfiguration';

// Trail types
export type TrailType = 'local' | 'conversation' | 'tomai' | 'copilot';

// Sequence counters per trail type (reset on clear)
const sequenceCounters: Record<TrailType, number> = {
    local: 0,
    conversation: 0,
    tomai: 0,
    copilot: 0
};

// Trail enabled flags (loaded from config)
let trailConfig: {
    enabled: boolean;
    paths: Record<TrailType, string>;
} = {
    enabled: false,
    paths: {
        local: WsPaths.aiRelative('trailLocal'),
        conversation: WsPaths.aiRelative('trailConversation'),
        tomai: WsPaths.aiRelative('trailTomai'),
        copilot: WsPaths.aiRelative('trailCopilot')
    }
};

/**
 * Load trail configuration from tom_vscode_extension.json
 */
export function loadTrailConfig(): void {
    try {
        let trail: Record<string, unknown> | undefined;
        try {
            trail = TomAiConfiguration.instance.getTrail() as Record<string, unknown>;
        } catch {
            const configPath = getConfigPath();
            const raw = configPath ? FsUtils.safeReadJson<Record<string, unknown>>(configPath) : undefined;
            trail = raw?.trail as Record<string, unknown> | undefined;
        }

        if (trail) {
            const rawSection = ((trail.raw ?? trail) as Record<string, unknown>);
            const paths = (rawSection.paths ?? {}) as Record<string, unknown>;

            trailConfig.enabled = rawSection.enabled === true;
            if (paths) {
                if (typeof paths.local === 'string') { trailConfig.paths.local = paths.local; }
                if (typeof paths.localLlm === 'string') { trailConfig.paths.local = paths.localLlm; }

                if (typeof paths.conversation === 'string') { trailConfig.paths.conversation = paths.conversation; }
                else if (typeof paths.lmApi === 'string') { trailConfig.paths.conversation = paths.lmApi; }

                if (typeof paths.tomai === 'string') { trailConfig.paths.tomai = paths.tomai; }
                else if (typeof paths.lmApi === 'string') { trailConfig.paths.tomai = paths.lmApi; }

                if (typeof paths.copilot === 'string') { trailConfig.paths.copilot = paths.copilot; }
            }
        }
    } catch (e) {
        console.error('[TrailLogger] Failed to load config:', e);
    }
}

/**
 * Check if trail logging is enabled
 */
export function isTrailEnabled(): boolean {
    loadTrailConfig();
    return trailConfig.enabled;
}

/**
 * Get the full trail folder path for a type
 */
function getTrailFolder(type: TrailType): string | null {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return null;
    }

    const configured = trailConfig.paths[type];
    if (path.isAbsolute(configured)) {
        return configured;
    }

    return path.join(workspaceFolder.uri.fsPath, configured);
}

/**
 * Generate timestamp string for filenames (YYYYMMDD_HHMMSS)
 */
function getTimestamp(): string {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    return `${y}${m}${d}_${h}${min}${s}`;
}

/**
 * Get next sequence number for a trail type
 */
function getNextSequence(type: TrailType): string {
    sequenceCounters[type]++;
    return String(sequenceCounters[type]).padStart(3, '0');
}

/**
 * Clear trail folder for a new session
 */
export function clearTrail(type: TrailType): void {
    if (!isTrailEnabled()) {
        return;
    }
    
    const folder = getTrailFolder(type);
    if (!folder) {
        return;
    }
    
    try {
        if (FsUtils.fileExists(folder)) {
            // Remove all files in the folder
            const files = fs.readdirSync(folder);
            for (const file of files) {
                const filePath = path.join(folder, file);
                if (fs.statSync(filePath).isFile()) {
                    fs.unlinkSync(filePath);
                }
            }
        } else {
            // Create the folder
            FsUtils.ensureDir(folder);
        }
        
        // Reset sequence counter
        sequenceCounters[type] = 0;
        
        console.log(`[TrailLogger] Cleared trail for ${type}`);
    } catch (e) {
        console.error(`[TrailLogger] Failed to clear trail for ${type}:`, e);
    }
}

/**
 * Write a trail file
 */
export function writeTrailFile(
    type: TrailType,
    filename: string,
    content: string,
    isJson: boolean = false
): string | null {
    if (!isTrailEnabled()) {
        return null;
    }
    
    const folder = getTrailFolder(type);
    if (!folder) {
        return null;
    }
    
    try {
        // Ensure folder exists
        FsUtils.ensureDir(folder);
        
        const timestamp = getTimestamp();
        const seq = getNextSequence(type);
        const ext = isJson ? '.json' : '.md';
        const fullFilename = `${timestamp}_${seq}_${filename}${ext}`;
        const filePath = path.join(folder, fullFilename);
        
        fs.writeFileSync(filePath, content, 'utf-8');
        console.log(`[TrailLogger] Wrote ${fullFilename}`);
        
        return filePath;
    } catch (e) {
        console.error(`[TrailLogger] Failed to write trail file:`, e);
        return null;
    }
}

// ============================================================================
// Convenience functions for specific file types
// ============================================================================

/**
 * Log a prompt being sent to an AI
 */
export function logPrompt(
    type: TrailType,
    target: string,
    prompt: string,
    systemPrompt?: string,
    metadata?: Record<string, unknown>
): void {
    let content = `# Prompt to ${target}\n\n`;
    
    if (metadata) {
        content += `## Metadata\n\n\`\`\`json\n${JSON.stringify(metadata, null, 2)}\n\`\`\`\n\n`;
    }
    
    if (systemPrompt) {
        content += `## System Prompt\n\n${systemPrompt}\n\n`;
    }
    
    content += `## User Prompt\n\n${prompt}\n`;
    
    writeTrailFile(type, `prompt_to_${target.toLowerCase().replace(/\s+/g, '_')}`, content);
}

/**
 * Log a response received from an AI
 */
export function logResponse(
    type: TrailType,
    source: string,
    response: string,
    isFinal: boolean = true,
    metadata?: Record<string, unknown>
): void {
    const qualifier = isFinal ? 'final' : 'partial';
    let content = `# Response from ${source} (${qualifier})\n\n`;
    
    if (metadata) {
        content += `## Metadata\n\n\`\`\`json\n${JSON.stringify(metadata, null, 2)}\n\`\`\`\n\n`;
    }
    
    content += `## Response\n\n${response}\n`;
    
    writeTrailFile(type, `response_${qualifier}_from_${source.toLowerCase().replace(/\s+/g, '_')}`, content);
}

/**
 * Log a tool request from the AI
 */
export function logToolRequest(
    type: TrailType,
    toolName: string,
    args: Record<string, unknown>
): void {
    const content = JSON.stringify({
        type: 'tool_request',
        tool: toolName,
        arguments: args,
        timestamp: new Date().toISOString()
    }, null, 2);
    
    writeTrailFile(type, `toolrequest_${toolName.toLowerCase().replace(/\s+/g, '_')}`, content, true);
}

/**
 * Log a tool result being sent back
 */
export function logToolResult(
    type: TrailType,
    toolName: string,
    result: string,
    error?: string
): void {
    const content = JSON.stringify({
        type: 'tool_result',
        tool: toolName,
        result: result,
        error: error || null,
        timestamp: new Date().toISOString()
    }, null, 2);
    
    writeTrailFile(type, `toolresult_${toolName.toLowerCase().replace(/\s+/g, '_')}`, content, true);
}

/**
 * Log a continuation prompt (after tool results)
 */
export function logContinuationPrompt(
    type: TrailType,
    target: string,
    messages: unknown[]
): void {
    let content = `# Continuation to ${target}\n\n`;
    content += `## Messages\n\n\`\`\`json\n${JSON.stringify(messages, null, 2)}\n\`\`\`\n`;
    
    writeTrailFile(type, `continuation_to_${target.toLowerCase().replace(/\s+/g, '_')}`, content);
}

/**
 * Log Copilot answer file content
 */
export function logCopilotAnswer(
    answerFilePath: string,
    content: unknown
): void {
    const jsonContent = JSON.stringify({
        type: 'copilot_answer',
        answerFile: answerFilePath,
        content: content,
        timestamp: new Date().toISOString()
    }, null, 2);
    
    writeTrailFile('copilot', 'copilot_answer', jsonContent, true);
}

/**
 * Log raw API request/response for debugging
 */
export function logRawApiCall(
    type: TrailType,
    direction: 'request' | 'response',
    endpoint: string,
    data: unknown
): void {
    const content = JSON.stringify({
        type: `raw_${direction}`,
        endpoint: endpoint,
        data: data,
        timestamp: new Date().toISOString()
    }, null, 2);
    
    writeTrailFile(type, `raw_${direction}_${endpoint.replace(/[^a-zA-Z0-9]/g, '_')}`, content, true);
}

/**
 * Open the trail folder in VS Code
 */
export async function openTrailFolder(type: TrailType): Promise<void> {
    const folder = getTrailFolder(type);
    if (!folder) {
        vscode.window.showWarningMessage('No workspace folder open');
        return;
    }
    
    if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder, { recursive: true });
    }
    
    const uri = vscode.Uri.file(folder);
    await vscode.commands.executeCommand('revealInExplorer', uri);
}

/**
 * Toggle trail logging on/off and persist to config
 */
export async function toggleTrail(): Promise<boolean> {
    loadTrailConfig();
    const newState = !trailConfig.enabled;

    try {
        let trail = TomAiConfiguration.instance.getTrail() as Record<string, unknown>;
        const raw = ((trail.raw ?? trail) as Record<string, unknown>);
        raw.enabled = newState;
        if (trail.raw !== undefined) {
            trail.raw = raw;
        } else {
            trail = raw;
        }
        await TomAiConfiguration.instance.saveTrail(trail);

        // Update in-memory state
        trailConfig.enabled = newState;

        vscode.window.showInformationMessage(`AI Trail logging ${newState ? 'enabled' : 'disabled'}`);
        return newState;
    } catch (e) {
        console.error('[TrailLogger] Failed to toggle trail:', e);
        vscode.window.showErrorMessage(`Failed to toggle trail: ${e}`);
        return trailConfig.enabled;
    }
}

/**
 * Set trail enabled state programmatically (for status page)
 */
export async function setTrailEnabled(enabled: boolean): Promise<void> {
    if (trailConfig.enabled === enabled) {
        return; // No change needed
    }
    await toggleTrail();
}
