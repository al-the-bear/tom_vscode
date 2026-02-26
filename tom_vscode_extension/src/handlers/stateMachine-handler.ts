/**
 * State Machine Command Handler
 *
 * Provides configurable state machine commands — extension commands that
 * execute different sequences of VS Code commands based on current state.
 *
 * State is stored in-memory per VS Code window and does not persist across
 * restarts. Each state machine command maintains its own state independently.
 *
 * Config format in tom_vscode_extension.json:
 *
 * ```json
 * "stateMachineCommands": {
 *   "vsWindowStateFlow": {
 *     "label": "Window Panel State Flow",
 *     "initActions": {
 *       "endState": "default",
 *       "executeStateAction": false,
 *       "commands": [...]
 *     },
 *     "resetActions": {
 *       "commands": [...]
 *     },
 *     "stateActions": [
 *       { "startState": "default", "endState": "noExplorer", "commands": [...] },
 *       ...
 *     ]
 *   }
 * }
 * ```
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { getConfigPath } from './handler_shared';
import { FsUtils } from '../utils/fsUtils';

// ============================================================================
// Types
// ============================================================================

interface StateAction {
    startState: string;
    endState: string;
    commands: string[];
}

interface InitActions {
    endState: string;
    executeStateAction?: boolean;
    commands: string[];
}

interface ResetActions {
    commands: string[];
}

interface StateMachineConfig {
    label?: string;
    initActions: InitActions;
    resetActions?: ResetActions;
    stateActions: StateAction[];
}

type StateMachineCommandsMap = Record<string, StateMachineConfig>;

// ============================================================================
// State Storage (in-memory, per-window)
// ============================================================================

/** Global state map: commandName → currentState */
const stateMap = new Map<string, string>();

/** Track which commands have been validated to avoid repeated validation */
const validatedCommands = new Set<string>();

// ============================================================================
// Config Loading
// ============================================================================

/**
 * Read the `stateMachineCommands` map from the config file.
 * Returns an empty object when the file or section doesn't exist.
 */
function loadStateMachineCommands(): StateMachineCommandsMap {
    const configPath = getConfigPath();
    if (!configPath || !FsUtils.fileExists(configPath)) {
        return {};
    }
    try {
        const config = FsUtils.safeReadJson<Record<string, unknown>>(configPath);
        const section = config?.stateMachineCommands;
        if (!section || typeof section !== 'object') {
            return {};
        }
        
        const result: StateMachineCommandsMap = {};
        for (const [key, value] of Object.entries(section)) {
            const entry = value as any;
            
            // Validate required fields
            if (!entry?.initActions?.commands || !Array.isArray(entry.initActions.commands)) {
                console.warn(`[StateMachine] "${key}" missing initActions.commands, skipping`);
                continue;
            }
            if (!entry?.initActions?.endState) {
                console.warn(`[StateMachine] "${key}" missing initActions.endState, skipping`);
                continue;
            }
            if (!Array.isArray(entry?.stateActions)) {
                console.warn(`[StateMachine] "${key}" missing stateActions array, skipping`);
                continue;
            }
            
            result[key] = {
                label: entry.label ? String(entry.label) : key,
                initActions: {
                    endState: String(entry.initActions.endState),
                    executeStateAction: entry.initActions.executeStateAction === true,
                    commands: entry.initActions.commands.map((c: any) => String(c)),
                },
                resetActions: entry.resetActions?.commands ? {
                    commands: entry.resetActions.commands.map((c: any) => String(c)),
                } : undefined,
                stateActions: entry.stateActions.map((sa: any) => ({
                    startState: String(sa.startState),
                    endState: String(sa.endState),
                    commands: Array.isArray(sa.commands) ? sa.commands.map((c: any) => String(c)) : [],
                })),
            };
        }
        return result;
    } catch (e) {
        console.error('[StateMachine] Failed to load config:', e);
        return {};
    }
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate a state machine configuration.
 * Returns true if valid, false if there are errors.
 * Shows error message to user on validation failure.
 */
function validateStateMachine(name: string, config: StateMachineConfig): boolean {
    // Check for duplicate start states
    const startStates = config.stateActions.map(sa => sa.startState);
    const seen = new Set<string>();
    const duplicates: string[] = [];
    
    for (const state of startStates) {
        if (seen.has(state)) {
            duplicates.push(state);
        }
        seen.add(state);
    }
    
    if (duplicates.length > 0) {
        const msg = `State machine "${name}" has duplicate start states: ${duplicates.join(', ')}. Each start state must be unique.`;
        console.error(`[StateMachine] ${msg}`);
        vscode.window.showErrorMessage(msg);
        return false;
    }
    
    return true;
}

// ============================================================================
// Command Execution
// ============================================================================

/**
 * Execute a single command entry.
 * Supports both VS Code command IDs and JavaScript fragments wrapped in { }.
 */
async function executeCommandEntry(entry: string): Promise<void> {
    const trimmed = entry.trim();
    
    // Check for JavaScript fragment: starts with { and ends with }
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        const code = trimmed.slice(1, -1).trim();
        console.log(`[StateMachine] Executing JS fragment: ${code.substring(0, 50)}...`);
        try {
            // Create async function to allow await in the fragment
            const asyncFn = new Function('vscode', 'require', `return (async () => { ${code} })();`);
            await asyncFn(vscode, require);
            console.log(`[StateMachine] ✓ JS fragment executed`);
        } catch (err) {
            console.error(`[StateMachine] Error executing JS fragment:`, err);
        }
    } else {
        // Regular VS Code command
        try {
            await vscode.commands.executeCommand(trimmed);
            console.log(`[StateMachine] ✓ "${trimmed}"`);
        } catch (err) {
            console.error(`[StateMachine] Error executing "${trimmed}":`, err);
        }
    }
}

/**
 * Execute a list of commands in sequence.
 */
async function executeCommands(commands: string[]): Promise<void> {
    for (const cmd of commands) {
        await executeCommandEntry(cmd);
    }
}

/**
 * Execute a state machine command by its short name.
 */
async function executeStateMachineCommand(name: string): Promise<void> {
    console.log(`[StateMachine] Executing "${name}"...`);
    const allCommands = loadStateMachineCommands();
    const config = allCommands[name];
    
    if (!config) {
        const msg = `State machine command "${name}" is not configured in tom_vscode_extension.json → stateMachineCommands.`;
        console.error(`[StateMachine] ${msg}`);
        vscode.window.showWarningMessage(msg);
        return;
    }
    
    // Validate on first execution
    if (!validatedCommands.has(name)) {
        if (!validateStateMachine(name, config)) {
            return; // Validation failed, error already shown
        }
        validatedCommands.add(name);
    }
    
    const currentState = stateMap.get(name);
    
    if (!currentState) {
        // No state yet — run init actions
        console.log(`[StateMachine] "${name}" — running init actions (no current state)`);
        await executeCommands(config.initActions.commands);
        
        const newState = config.initActions.endState;
        stateMap.set(name, newState);
        console.log(`[StateMachine] "${name}" — state set to "${newState}"`);
        
        // If executeStateAction is true, immediately execute the state action for the new state
        if (config.initActions.executeStateAction) {
            console.log(`[StateMachine] "${name}" — executeStateAction=true, finding action for state "${newState}"`);
            const stateAction = config.stateActions.find(sa => sa.startState === newState);
            if (stateAction) {
                console.log(`[StateMachine] "${name}" — executing state action: ${newState} → ${stateAction.endState}`);
                await executeCommands(stateAction.commands);
                stateMap.set(name, stateAction.endState);
                console.log(`[StateMachine] "${name}" — state set to "${stateAction.endState}"`);
            } else {
                console.log(`[StateMachine] "${name}" — no state action found for state "${newState}"`);
            }
        }
        return;
    }
    
    // Find the state action for the current state
    const stateAction = config.stateActions.find(sa => sa.startState === currentState);
    
    if (!stateAction) {
        const msg = `State machine "${name}" has no action for state "${currentState}".`;
        console.error(`[StateMachine] ${msg}`);
        vscode.window.showWarningMessage(msg);
        return;
    }
    
    console.log(`[StateMachine] "${name}" — executing: ${currentState} → ${stateAction.endState}`);
    await executeCommands(stateAction.commands);
    stateMap.set(name, stateAction.endState);
    console.log(`[StateMachine] "${name}" — state set to "${stateAction.endState}"`);
}

/**
 * Reset all state machine states.
 * Executes resetActions for all configured state machines, then clears all state.
 */
async function resetAllStateMachineStates(): Promise<void> {
    console.log(`[StateMachine] Resetting all state machine states...`);
    const allCommands = loadStateMachineCommands();
    
    // Execute reset actions for all state machines that have them
    for (const [name, config] of Object.entries(allCommands)) {
        if (config.resetActions?.commands && config.resetActions.commands.length > 0) {
            console.log(`[StateMachine] "${name}" — executing reset actions`);
            await executeCommands(config.resetActions.commands);
        }
    }
    
    // Clear all state
    const count = stateMap.size;
    stateMap.clear();
    validatedCommands.clear();
    
    console.log(`[StateMachine] Cleared ${count} state(s)`);
    vscode.window.showInformationMessage(`Reset ${count} state machine state(s). Next invocation will run init actions.`);
}

// ============================================================================
// Registration
// ============================================================================

/**
 * Creates a command handler function for a given state machine command name.
 */
export function createStateMachineCommandHandler(name: string): () => Promise<void> {
    return () => executeStateMachineCommand(name);
}

/**
 * Register all state machine command entries.
 * Call this from extension.ts during activation.
 *
 * Each registered command has the ID `dartscript.stateMachine.<name>`.
 * The names must match entries declared in package.json → contributes.commands.
 */
export function registerStateMachineCommands(context: vscode.ExtensionContext): void {
    // Statically registered state machine command names in package.json
    const registeredNames = [
        'vsWindowStateFlow',
    ];
    
    for (const name of registeredNames) {
        const cmd = vscode.commands.registerCommand(
            `dartscript.stateMachine.${name}`,
            createStateMachineCommandHandler(name),
        );
        context.subscriptions.push(cmd);
    }
    
    // Register the reset command
    const resetCmd = vscode.commands.registerCommand(
        'dartscript.resetMultiCommandState',
        resetAllStateMachineStates,
    );
    context.subscriptions.push(resetCmd);
}

/**
 * Get the current state for a state machine command (for debugging/status).
 */
export function getStateMachineState(name: string): string | undefined {
    return stateMap.get(name);
}

/**
 * Get all current state machine states (for debugging/status).
 */
export function getAllStateMachineStates(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, state] of stateMap) {
        result[name] = state;
    }
    return result;
}
