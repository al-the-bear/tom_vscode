/**
 * Cross-platform executable resolution utilities.
 * 
 * This module provides utilities for:
 * - Resolving platform-specific executable paths from configuration
 * - Matching files to external applications based on extensions and patterns
 * - Expanding executable placeholders in strings
 * - Generic config-level placeholder expansion (${binaryPath}, ${home}, etc.)
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// ============================================================================
// Types
// ============================================================================

/**
 * Platform identifiers following the pattern: <os>-<arch>
 * Examples: darwin-arm64, darwin-x64, linux-x64, windows-x64
 * Wildcards supported: darwin-*, linux-*, windows-*, *
 */
export type PlatformKey = string;

/**
 * Executable configuration with platform-specific paths.
 * Each key is a platform identifier, value is the executable path.
 */
export interface ExecutableConfig {
    [platform: PlatformKey]: string;
}

/**
 * Collection of named executables with their platform configurations.
 */
export interface ExecutablesConfig {
    [name: string]: ExecutableConfig;
}

/**
 * Context for expanding configuration-level placeholders.
 * Build once via `buildConfigContext()`, then reuse for multiple expansions.
 */
export interface ConfigPlaceholderContext {
    /** Resolved binaryPath directory (with trailing separator). */
    binaryPath: string;
    /** Workspace root path (if available). */
    workspaceRoot?: string;
}

/**
 * A single application mapping rule.
 */
export interface ApplicationMapping {
    /** File extensions to match (e.g., [".md", ".markdown"]) */
    extensions?: string[];
    /** Regex pattern to match filename (e.g., ".*\\.ya?ml(\\.bak)?\$") */
    pattern?: string;
    /** Name of the executable from executables config */
    executable: string;
    /** Optional display name for the application */
    label?: string;
}

/**
 * External applications configuration.
 */
export interface ExternalApplicationsConfig {
    mappings: ApplicationMapping[];
}

// ============================================================================
// Platform Detection
// ============================================================================

/**
 * Get the current platform identifier.
 * Format: <os>-<arch> (e.g., darwin-arm64, linux-x64, windows-x64)
 */
export function getCurrentPlatform(): string {
    const platform = os.platform();
    const arch = os.arch();
    
    // Normalize platform names
    const osName = platform === 'win32' ? 'windows' : platform;
    
    return `${osName}-${arch}`;
}

/**
 * Get platform family (os only, without arch).
 * Returns: darwin, linux, or windows
 */
export function getPlatformFamily(): string {
    const platform = os.platform();
    return platform === 'win32' ? 'windows' : platform;
}

// ============================================================================
// Environment Variable Expansion
// ============================================================================

/**
 * Expand `${env:VARNAME}` placeholders with values from `process.env`.
 *
 * Unknown variables are left untouched so the user sees the placeholder
 * rather than a silently empty string.
 *
 * @param value The string containing `${env:...}` placeholders
 * @returns The expanded string
 */
export function expandEnvironmentVariables(value: string): string {
    if (!value.includes('${env:')) return value;
    return value.replace(/\$\{env:([^}]+)\}/g, (_match, varName) => {
        const envValue = process.env[varName];
        return envValue !== undefined ? envValue : _match; // keep placeholder if unset
    });
}

// ============================================================================
// Executable Resolution
// ============================================================================

/**
 * Resolve an executable path for the current platform.
 * 
 * Resolution order:
 * 1. Exact match: darwin-arm64
 * 2. Wildcard arch: darwin-*
 * 3. Universal wildcard: *
 * 
 * @param execConfig The executable configuration with platform paths
 * @returns The resolved path, or undefined if no match found
 */
export function resolveExecutablePath(execConfig: ExecutableConfig | undefined): string | undefined {
    if (!execConfig) return undefined;
    
    const currentPlatform = getCurrentPlatform();
    const platformFamily = getPlatformFamily();
    
    // 1. Try exact match
    if (execConfig[currentPlatform]) {
        return expandHomePath(execConfig[currentPlatform]);
    }
    
    // 2. Try wildcard arch (e.g., darwin-*)
    const wildcardArch = `${platformFamily}-*`;
    if (execConfig[wildcardArch]) {
        return expandHomePath(execConfig[wildcardArch]);
    }
    
    // 3. Try universal wildcard
    if (execConfig['*']) {
        return expandHomePath(execConfig['*']);
    }
    
    return undefined;
}

/**
 * Resolve a named executable from the executables configuration.
 * 
 * When a `ConfigPlaceholderContext` is provided, config-level placeholders
 * (e.g. ${binaryPath}) in the resolved path are expanded automatically.
 * 
 * @param name The executable name (e.g., "marktext", "tom_bs")
 * @param executables The full executables configuration
 * @param ctx Optional placeholder context for expanding config-level variables
 * @returns The resolved path for the current platform, or undefined
 */
export function resolveNamedExecutable(
    name: string,
    executables: ExecutablesConfig | undefined,
    ctx?: ConfigPlaceholderContext,
): string | undefined {
    if (!executables) return undefined;
    const resolved = resolveExecutablePath(executables[name]);
    if (!resolved) return undefined;
    return ctx ? expandConfigPlaceholders(resolved, ctx) : resolved;
}

/**
 * Expand ~ to home directory in a path.
 */
export function expandHomePath(filePath: string): string {
    if (filePath.startsWith('~/') || filePath === '~') {
        return path.join(os.homedir(), filePath.slice(1));
    }
    return filePath;
}

// ============================================================================
// Binary Path Resolution
// ============================================================================

/**
 * Resolve the binary path directory for the current platform.
 *
 * Uses the same resolution strategy as executables:
 *   1. Exact platform match (e.g., darwin-arm64)
 *   2. Wildcard arch match (e.g., darwin-*)
 *   3. Universal wildcard (*)
 *   4. Fallback: <workspaceRoot>/tom_binaries/tom/<platform>/ (if workspace provided)
 *   5. Final fallback: $HOME/.tom/bin/<platform>/
 *
 * @param binaryPathConfig Platform-specific binary path config (same shape as ExecutableConfig)
 * @param workspaceRoot Optional workspace root for the default fallback path
 * @returns The resolved binary path directory (always ends with path separator)
 */
export function resolveBinaryPath(
    binaryPathConfig: ExecutableConfig | undefined,
    workspaceRoot?: string,
): string {
    // Try platform-specific resolution from config
    let resolved = resolveExecutablePath(binaryPathConfig);
    if (resolved) {
        // Expand environment variables (e.g. ${env:TOM_BINARY_PATH})
        resolved = expandEnvironmentVariables(resolved);
        // Ensure trailing separator
        return resolved.endsWith(path.sep) ? resolved : resolved + path.sep;
    }

    const platform = getCurrentPlatform();

    // Fallback: <workspaceRoot>/tom_binaries/tom/<platform>/
    if (workspaceRoot) {
        const wsFallback = path.join(workspaceRoot, 'tom_binaries', 'tom', platform);
        if (fs.existsSync(wsFallback)) {
            return wsFallback + path.sep;
        }
    }

    // Final fallback: $HOME/.tom/bin/<platform>/
    const fallback = path.join(os.homedir(), '.tom', 'bin', platform);
    return fallback + path.sep;
}

// ============================================================================
// Generic Config Placeholder Expansion
// ============================================================================

/**
 * Build a `ConfigPlaceholderContext` from a binaryPath config and workspace root.
 *
 * Call once per operation, then pass the result to `expandConfigPlaceholders()`
 * or any function that accepts a `ConfigPlaceholderContext`.
 *
 * @param binaryPathConfig Platform-specific binaryPath config (from SendToChatConfig)
 * @param workspaceRoot    Workspace root path (for tom_binaries fallback)
 */
export function buildConfigContext(
    binaryPathConfig: ExecutableConfig | undefined,
    workspaceRoot?: string,
): ConfigPlaceholderContext {
    return {
        binaryPath: resolveBinaryPath(binaryPathConfig, workspaceRoot),
        workspaceRoot,
    };
}

/**
 * Expand configuration-level placeholders in any string value.
 *
 * This is the **single generic method** for placeholder expansion in config
 * fields such as executable paths, command strings, working directories, etc.
 *
 * Supported placeholders:
 *   ${binaryPath}       — platform-specific binary directory (with trailing /)
 *   ${home}             — user home directory
 *   ${workspaceFolder}  — VS Code workspace root (when available)
 *   ${env:VARNAME}      — environment variable (e.g. ${env:TOM_BINARY_PATH})
 *   ~                   — home directory prefix (expanded last)
 *
 * @param value The string containing placeholders
 * @param ctx   A `ConfigPlaceholderContext` (obtain via `buildConfigContext()`)
 * @returns The expanded string
 */
export function expandConfigPlaceholders(
    value: string,
    ctx: ConfigPlaceholderContext,
): string {
    let result = value;
    if (result.includes('${binaryPath}')) {
        result = result.replace(/\$\{binaryPath\}/g, ctx.binaryPath);
    }
    if (result.includes('${home}')) {
        result = result.replace(/\$\{home\}/g, os.homedir());
    }
    if (ctx.workspaceRoot && result.includes('${workspaceFolder}')) {
        result = result.replace(/\$\{workspaceFolder\}/g, ctx.workspaceRoot);
    }
    result = expandEnvironmentVariables(result);
    return expandHomePath(result);
}

/**
 * Check if an executable exists at the resolved path.
 */
export function executableExists(executablePath: string): boolean {
    const expanded = expandHomePath(executablePath);
    return fs.existsSync(expanded);
}

// ============================================================================
// External Application Matching
// ============================================================================

/**
 * Find an external application for a given file.
 * 
 * Matching order for filename "config.backup.yaml.bak":
 * 1. Check extension-based rules from most specific to least:
 *    - .backup.yaml.bak (all extensions combined)
 *    - .yaml.bak (last two extensions)
 *    - .bak (last extension only)
 * 2. Check pattern-based rules (regex matching on full filename)
 * 
 * @param filePath The file path to match
 * @param config The external applications configuration
 * @returns The matching application mapping, or undefined
 */
export function findExternalApplication(
    filePath: string,
    config: ExternalApplicationsConfig | undefined
): ApplicationMapping | undefined {
    if (!config?.mappings || config.mappings.length === 0) {
        return undefined;
    }
    
    const filename = path.basename(filePath);
    const extensions = getExtensionChain(filename);
    
    // First pass: Check extension-based mappings (from most specific)
    for (const ext of extensions) {
        for (const mapping of config.mappings) {
            if (mapping.extensions && mapping.extensions.includes(ext)) {
                return mapping;
            }
        }
    }
    
    // Second pass: Check pattern-based mappings
    for (const mapping of config.mappings) {
        if (mapping.pattern) {
            try {
                const regex = new RegExp(mapping.pattern, 'i');
                if (regex.test(filename)) {
                    return mapping;
                }
            } catch {
                // Invalid regex, skip
            }
        }
    }
    
    return undefined;
}

/**
 * Get all possible extension chains for a filename.
 * 
 * For "config.backup.yaml.bak" returns:
 * [".backup.yaml.bak", ".yaml.bak", ".bak"]
 * 
 * This allows more specific extension combinations to match first.
 */
export function getExtensionChain(filename: string): string[] {
    const parts = filename.split('.');
    if (parts.length < 2) return [];
    
    const extensions: string[] = [];
    
    // Start from second part (skip the base filename)
    for (let i = 1; i < parts.length; i++) {
        const ext = '.' + parts.slice(i).join('.');
        extensions.push(ext);
    }
    
    return extensions;
}

/**
 * Resolve the full executable path for an external application mapping.
 * 
 * @param ctx Optional placeholder context for expanding config-level variables
 */
export function resolveApplicationExecutable(
    mapping: ApplicationMapping,
    executables: ExecutablesConfig | undefined,
    ctx?: ConfigPlaceholderContext,
): string | undefined {
    return resolveNamedExecutable(mapping.executable, executables, ctx);
}

// ============================================================================
// Placeholder Expansion
// ============================================================================

/**
 * Expand executable placeholders in a string.
 * 
 * Supports:
 * - ${executable.name} - resolves to platform-specific path
 * - ${executable.name.path} - same as above
 * - ${executable.name.exists} - returns "true" or "false"
 * 
 * @param input The string with placeholders
 * @param executables The executables configuration
 * @param ctx Optional placeholder context for expanding config-level variables
 * @returns The string with placeholders expanded
 */
export function expandExecutablePlaceholders(
    input: string,
    executables: ExecutablesConfig | undefined,
    ctx?: ConfigPlaceholderContext,
): string {
    if (!executables) return input;
    
    // Match ${executable.<name>} or ${executable.<name>.path} or ${executable.<name>.exists}
    return input.replace(
        /\$\{executable\.([a-zA-Z0-9_-]+)(\.path|\.exists)?\}/g,
        (match, name: string, suffix?: string) => {
            const resolved = resolveNamedExecutable(name, executables, ctx);
            
            if (suffix === '.exists') {
                return resolved && executableExists(resolved) ? 'true' : 'false';
            }
            
            return resolved || match; // Return original if not resolved
        }
    );
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate executables configuration and report missing executables.
 */
export function validateExecutables(
    executables: ExecutablesConfig | undefined
): { valid: boolean; missing: string[] } {
    const missing: string[] = [];
    
    if (!executables) {
        return { valid: true, missing };
    }
    
    for (const [name, config] of Object.entries(executables)) {
        const resolved = resolveExecutablePath(config);
        if (!resolved) {
            missing.push(`${name}: No configuration for platform ${getCurrentPlatform()}`);
        } else if (!executableExists(resolved)) {
            missing.push(`${name}: Executable not found at ${resolved}`);
        }
    }
    
    return { valid: missing.length === 0, missing };
}

/**
 * Get all configured executables with their resolved paths for the current platform.
 * 
 * @param ctx Optional placeholder context for expanding config-level variables
 */
export function getResolvedExecutables(
    executables: ExecutablesConfig | undefined,
    ctx?: ConfigPlaceholderContext,
): Map<string, { path: string | undefined; exists: boolean }> {
    const result = new Map<string, { path: string | undefined; exists: boolean }>();
    
    if (!executables) return result;
    
    for (const name of Object.keys(executables)) {
        const resolved = resolveNamedExecutable(name, executables, ctx);
        result.set(name, {
            path: resolved,
            exists: resolved ? executableExists(resolved) : false
        });
    }
    
    return result;
}
