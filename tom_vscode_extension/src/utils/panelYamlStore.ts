/**
 * Panel YAML Store — Persistent YAML-file storage for panel state.
 *
 * Provides a uniform way to persist panel data (queue, timed requests,
 * context settings, chat variables, etc.) into YAML files in the workspace.
 *
 * Files are named with a workspace prefix: `{workspaceName}.{type}.yaml`,
 * e.g. `tom_agent_container.queue.yaml`.
 *
 * Default storage folder: `_ai/local/` in the workspace root.
 * Configurable via `dartscript.panelStoragePath` setting.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WsPaths } from './workspacePaths';

// ============================================================================
// Workspace helpers
// ============================================================================

/** Get the workspace name from the .code-workspace filename (without extension), or 'default'. */
export function getWorkspaceName(): string {
    const wsFile = vscode.workspace.workspaceFile;
    if (wsFile && wsFile.fsPath.endsWith('.code-workspace')) {
        return path.basename(wsFile.fsPath).replace(/\.code-workspace$/, '');
    }
    return 'default';
}

/** Get the storage folder path for panel YAML files. */
export function getStorageFolder(): string | undefined {
    const configPath = vscode.workspace
        .getConfiguration('tomAi')
        .get<string>('panelStoragePath')
        || vscode.workspace
            .getConfiguration('dartscript')
            .get<string>('panelStoragePath');

    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) return undefined;

    if (configPath) {
        // Resolve relative paths against workspace root
        const resolved = path.isAbsolute(configPath) ? configPath : path.join(wsRoot, configPath);
        return resolved;
    }

    return WsPaths.ai('local') || path.join(wsRoot, '_ai', 'local');
}

/**
 * Build the full file path for a panel YAML file.
 * @param type File type suffix, e.g. 'queue', 'timed', 'context', 'chatvars'
 * @returns Full path or undefined if no workspace is open
 */
export function getPanelFilePath(type: string): string | undefined {
    const folder = getStorageFolder();
    if (!folder) return undefined;
    const name = getWorkspaceName();
    return path.join(folder, `${name}.${type}.yaml`);
}

/** Build a per-section prompt state file path (e.g. workspace.copilot.prompt-panel.yaml). */
export function getPromptPanelFilePath(section: string): string | undefined {
    const folder = getStorageFolder();
    if (!folder) return undefined;
    const name = getWorkspaceName();
    return path.join(folder, `${name}.${section}.prompt-panel.yaml`);
}

function getLegacyPromptPanelFilePath(section: string): string | undefined {
    const folder = getStorageFolder();
    if (!folder) return undefined;
    const name = getWorkspaceName();
    return path.join(folder, `${name}.${section}.prompt.yaml`);
}

// ============================================================================
// Read / Write
// ============================================================================

/**
 * Read and parse a panel YAML file.
 * Returns undefined if the file doesn't exist or can't be parsed.
 */
export async function readPanelYaml<T = any>(type: string): Promise<T | undefined> {
    const filePath = getPanelFilePath(type);
    if (!filePath || !fs.existsSync(filePath)) return undefined;
    try {
        const yaml = await import('yaml');
        const content = fs.readFileSync(filePath, 'utf-8');
        return yaml.parse(content) as T;
    } catch {
        return undefined;
    }
}

/**
 * Synchronous version of readPanelYaml for use in constructors/restore methods.
 * Uses require() to load yaml synchronously.
 */
export function readPanelYamlSync<T = any>(type: string): T | undefined {
    const filePath = getPanelFilePath(type);
    if (!filePath || !fs.existsSync(filePath)) return undefined;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const yaml = require('yaml');
        const content = fs.readFileSync(filePath, 'utf-8');
        return yaml.parse(content) as T;
    } catch {
        return undefined;
    }
}

/**
 * Write data to a panel YAML file. Creates the directory if needed.
 * Adds a `$schema` reference and metadata header.
 */
export async function writePanelYaml(
    type: string,
    data: Record<string, unknown>,
    schemaRelPath?: string,
): Promise<string | undefined> {
    const filePath = getPanelFilePath(type);
    if (!filePath) return undefined;

    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const yaml = await import('yaml');

        // Build the document with schema reference
        const doc: Record<string, unknown> = {};
        if (schemaRelPath) {
            doc['$schema'] = schemaRelPath;
        }
        doc['updated'] = new Date().toISOString();
        Object.assign(doc, data);

        const content = yaml.stringify(doc, { lineWidth: 120 });
        fs.writeFileSync(filePath, content, 'utf-8');
        return filePath;
    } catch (e) {
        console.error(`[panelYamlStore] Failed to write ${type}:`, e);
        return undefined;
    }
}

export async function readPromptPanelYaml<T = any>(section: string): Promise<T | undefined> {
    const filePath = getPromptPanelFilePath(section);
    const legacyPath = getLegacyPromptPanelFilePath(section);
    const pathToRead = filePath && fs.existsSync(filePath)
        ? filePath
        : (legacyPath && fs.existsSync(legacyPath) ? legacyPath : undefined);
    if (!pathToRead) return undefined;
    try {
        const yaml = await import('yaml');
        const content = fs.readFileSync(pathToRead, 'utf-8');
        return yaml.parse(content) as T;
    } catch {
        return undefined;
    }
}

export async function writePromptPanelYaml(
    section: string,
    data: Record<string, unknown>,
    schemaRelPath: string = '../../.tom/json-schema/panels/prompt.schema.json',
): Promise<string | undefined> {
    const filePath = getPromptPanelFilePath(section);
    if (!filePath) return undefined;

    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const yaml = await import('yaml');
        const doc: Record<string, unknown> = {
            $schema: schemaRelPath,
            updated: new Date().toISOString(),
            section,
            ...data,
        };
        const content = yaml.stringify(doc, { lineWidth: 120 });
        fs.writeFileSync(filePath, content, 'utf-8');
        return filePath;
    } catch (e) {
        console.error(`[panelYamlStore] Failed to write ${section}.prompt:`, e);
        return undefined;
    }
}

/**
 * Check if a panel YAML file exists.
 */
export function panelFileExists(type: string): boolean {
    const filePath = getPanelFilePath(type);
    return !!filePath && fs.existsSync(filePath);
}

/**
 * Open a panel YAML file in the editor.
 */
export async function openPanelFile(type: string): Promise<void> {
    const filePath = getPanelFilePath(type);
    if (!filePath) {
        vscode.window.showWarningMessage('No workspace open');
        return;
    }
    if (!fs.existsSync(filePath)) {
        vscode.window.showWarningMessage(`File not found: ${path.basename(filePath)}`);
        return;
    }
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);
}

export async function openPromptPanelFile(section: string): Promise<void> {
    const filePath = getPromptPanelFilePath(section);
    if (!filePath) {
        vscode.window.showWarningMessage('No workspace open');
        return;
    }
    if (!fs.existsSync(filePath)) {
        vscode.window.showWarningMessage(`File not found: ${path.basename(filePath)}`);
        return;
    }
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);
}
