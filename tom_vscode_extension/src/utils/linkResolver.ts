/**
 * Link Resolver — Extensible link handling for MD Browser and other panels.
 *
 * Supports multiple link types:
 *  - `#anchor` — In-document anchor navigation
 *  - `file.md` or `file.md#anchor` — Markdown file links
 *  - `file.ts` — Non-markdown files (open in editor)
 *  - Future link types (extensible via LinkHandler interface):
 *    - `issue:123` — GitHub/GitLab issue references
 *    - `test:my_test.dart::testName` — Test file + test name
 *    - `todo:quest-id/todo-id` — Todo item references
 *    - `trail:copilot/2026-03-02` — Trail entry references
 *    - `quest:my-quest` — Quest references
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { WsPaths } from './workspacePaths.js';

// ============================================================================
// Types
// ============================================================================

/** Result of resolving a link. */
export interface ResolvedLink {
    /** The type of link that was resolved. */
    type: LinkType;

    /** Action to take for this link. */
    action: LinkAction;

    /** For file links: absolute file path. */
    filePath?: string;

    /** For anchor links: the anchor ID (without #). */
    anchor?: string;

    /** For file links with line number: 1-based line number. */
    lineNumber?: number;

    /** For special links (issue, todo, etc.): the identifier. */
    identifier?: string;

    /** Error message if resolution failed. */
    error?: string;
}

/** Types of links we can resolve. */
export type LinkType =
    | 'anchor'           // #section-name
    | 'file'             // file.md, file.ts, etc.
    | 'file-with-anchor' // file.md#section
    | 'external'         // http://, https://, mailto:
    | 'issue'            // issue:123
    | 'test'             // test:file::name
    | 'todo'             // todo:quest/id
    | 'trail'            // trail:subsystem/date
    | 'quest'            // quest:quest-id
    | 'request'          // request:id (prompt queue request)
    | 'answer'           // answer:id (chat answer)
    | 'unknown';         // Unrecognized link type

/** Actions that can be taken for a resolved link. */
export type LinkAction =
    | 'scroll-to-anchor'      // Scroll within current document
    | 'navigate-md'           // Navigate to markdown file in browser
    | 'navigate-md-anchor'    // Navigate to markdown file + scroll to anchor
    | 'open-in-editor'        // Open file in VS Code editor
    | 'open-in-editor-line'   // Open file at specific line
    | 'open-external'         // Open external URL in browser
    | 'show-panel'            // Show a specific panel/view
    | 'run-command'           // Execute a VS Code command
    | 'error';                // Show error message

/** Context for link resolution. */
export interface LinkContext {
    /** Current file path (for resolving relative links). */
    currentFilePath?: string;

    /** Workspace root path. */
    workspaceRoot?: string;
}

/** Interface for extending link handling with custom types. */
export interface LinkHandler {
    /** Link type prefix (e.g., 'issue:', 'todo:'). */
    prefix: string;

    /** Resolve a link of this type. */
    resolve(href: string, context: LinkContext): ResolvedLink;
}

// ============================================================================
// Link Registry
// ============================================================================

const linkHandlers: Map<string, LinkHandler> = new Map();

/**
 * Register a custom link handler.
 */
export function registerLinkHandler(handler: LinkHandler): void {
    linkHandlers.set(handler.prefix.toLowerCase(), handler);
}

/**
 * Unregister a link handler.
 */
export function unregisterLinkHandler(prefix: string): void {
    linkHandlers.delete(prefix.toLowerCase());
}

// ============================================================================
// Core Link Resolution
// ============================================================================

/**
 * Resolve a link href to determine what action should be taken.
 */
export function resolveLink(href: string, context: LinkContext = {}): ResolvedLink {
    if (!href) {
        return { type: 'unknown', action: 'error', error: 'Empty link' };
    }

    const trimmedHref = href.trim();

    // 1. External URLs
    if (isExternalUrl(trimmedHref)) {
        return { type: 'external', action: 'open-external', identifier: trimmedHref };
    }

    // 2. Pure anchor link (#section)
    if (trimmedHref.startsWith('#')) {
        const anchor = trimmedHref.slice(1);
        return { type: 'anchor', action: 'scroll-to-anchor', anchor };
    }

    // 3. Check for custom link handlers (issue:, todo:, etc.)
    const colonIndex = trimmedHref.indexOf(':');
    if (colonIndex > 0 && colonIndex < 20) {
        const prefix = trimmedHref.slice(0, colonIndex + 1).toLowerCase();
        const handler = linkHandlers.get(prefix);
        if (handler) {
            return handler.resolve(trimmedHref.slice(colonIndex + 1), context);
        }
    }

    // 4. File link (possibly with anchor)
    return resolveFileLink(trimmedHref, context);
}

/**
 * Check if a URL is external (http, https, mailto, etc.).
 */
function isExternalUrl(href: string): boolean {
    return /^(https?:|mailto:|tel:|file:)/i.test(href);
}

/**
 * Resolve a file link (with or without anchor).
 */
function resolveFileLink(href: string, context: LinkContext): ResolvedLink {
    // Split off anchor fragment
    const hashIndex = href.indexOf('#');
    const pathPart = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
    const anchor = hashIndex >= 0 ? href.slice(hashIndex + 1) : undefined;

    // Resolve the file path
    let resolvedPath: string | undefined;

    if (path.isAbsolute(pathPart)) {
        resolvedPath = pathPart;
    } else if (context.currentFilePath) {
        // Relative to current file's directory
        resolvedPath = path.resolve(path.dirname(context.currentFilePath), pathPart);
    } else if (context.workspaceRoot) {
        // Relative to workspace root
        resolvedPath = path.join(context.workspaceRoot, pathPart);
    }

    // If not found, try workspace-relative as fallback
    if (resolvedPath && !fs.existsSync(resolvedPath)) {
        const wsRoot = context.workspaceRoot || WsPaths.wsRoot;
        if (wsRoot) {
            const wsRelative = path.join(wsRoot, pathPart);
            if (fs.existsSync(wsRelative)) {
                resolvedPath = wsRelative;
            }
        }
    }

    // Check if file exists
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
        return {
            type: 'unknown',
            action: 'error',
            error: `File not found: ${pathPart}`,
        };
    }

    // Determine action based on file type
    const isMarkdown = resolvedPath.toLowerCase().endsWith('.md');

    if (isMarkdown) {
        if (anchor) {
            return {
                type: 'file-with-anchor',
                action: 'navigate-md-anchor',
                filePath: resolvedPath,
                anchor,
            };
        } else {
            return {
                type: 'file',
                action: 'navigate-md',
                filePath: resolvedPath,
            };
        }
    } else {
        // Non-markdown file — open in editor
        // Check for line number anchor (#L20, #L20-L30, etc.)
        let lineNumber: number | undefined;
        if (anchor) {
            const lineMatch = anchor.match(/^L(\d+)/i);
            if (lineMatch) {
                lineNumber = parseInt(lineMatch[1], 10);
            }
        }

        if (lineNumber) {
            return {
                type: 'file',
                action: 'open-in-editor-line',
                filePath: resolvedPath,
                lineNumber,
            };
        } else {
            return {
                type: 'file',
                action: 'open-in-editor',
                filePath: resolvedPath,
            };
        }
    }
}

// ============================================================================
// Built-in Link Handlers (can be extended)
// ============================================================================

/**
 * Issue link handler: issue:123 or issue:owner/repo#123
 */
const issueLinkHandler: LinkHandler = {
    prefix: 'issue:',
    resolve(identifier: string, _context: LinkContext): ResolvedLink {
        // For now, just mark as a command to open issue
        return {
            type: 'issue',
            action: 'run-command',
            identifier,
        };
    },
};

/**
 * Todo link handler: todo:quest-id/todo-id
 */
const todoLinkHandler: LinkHandler = {
    prefix: 'todo:',
    resolve(identifier: string, _context: LinkContext): ResolvedLink {
        return {
            type: 'todo',
            action: 'run-command',
            identifier,
        };
    },
};

/**
 * Trail link handler: trail:copilot/2026-03-02_143052
 */
const trailLinkHandler: LinkHandler = {
    prefix: 'trail:',
    resolve(identifier: string, _context: LinkContext): ResolvedLink {
        return {
            type: 'trail',
            action: 'run-command',
            identifier,
        };
    },
};

/**
 * Quest link handler: quest:my-quest-id
 */
const questLinkHandler: LinkHandler = {
    prefix: 'quest:',
    resolve(identifier: string, context: LinkContext): ResolvedLink {
        // Try to resolve to the quest overview file
        const wsRoot = context.workspaceRoot || WsPaths.wsRoot;
        if (wsRoot) {
            const questOverview = path.join(wsRoot, '_ai', 'quests', identifier, `overview.${identifier}.md`);
            if (fs.existsSync(questOverview)) {
                return {
                    type: 'quest',
                    action: 'navigate-md',
                    filePath: questOverview,
                    identifier,
                };
            }
        }
        return {
            type: 'quest',
            action: 'run-command',
            identifier,
        };
    },
};

/**
 * Test link handler: test:path/to/test.dart::testName
 */
const testLinkHandler: LinkHandler = {
    prefix: 'test:',
    resolve(identifier: string, _context: LinkContext): ResolvedLink {
        return {
            type: 'test',
            action: 'run-command',
            identifier,
        };
    },
};

// Register built-in handlers
registerLinkHandler(issueLinkHandler);
registerLinkHandler(todoLinkHandler);
registerLinkHandler(trailLinkHandler);
registerLinkHandler(questLinkHandler);
registerLinkHandler(testLinkHandler);

// ============================================================================
// Utility: Generate anchor ID from heading text
// ============================================================================

/**
 * Convert heading text to anchor ID (matching GitHub/marked.js behavior).
 * E.g., "Hello World!" → "hello-world"
 */
export function textToAnchorId(text: string): string {
    return text
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, '')    // Remove special chars except hyphens
        .replace(/\s+/g, '-')         // Replace spaces with hyphens
        .replace(/-+/g, '-')          // Collapse multiple hyphens
        .replace(/^-|-$/g, '');       // Trim leading/trailing hyphens
}
