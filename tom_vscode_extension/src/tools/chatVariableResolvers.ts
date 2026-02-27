/**
 * Chat Variable Resolvers — §2 Chat Variables (New Feature)
 *
 * Registers #quest, #role, #activeProjects, #todo, #workspaceName
 * so that Copilot Chat users can reference them with # prefix.
 *
 * Uses `contributes.chatVariables` in package.json + dynamic resolver.
 * If the API is not available (older VS Code), gracefully skips registration.
 */

import * as vscode from 'vscode';
import { ChatVariablesStore } from '../managers/chatVariablesStore';

interface ResolverDef {
    id: string;
    name: string;
    description: string;
    resolve: () => string;
}

/**
 * Register all chat variable resolvers with VS Code.
 * Safe to call even if the API is not yet available — will just log a warning.
 */
export function registerChatVariableResolvers(context: vscode.ExtensionContext): void {
    // Check if the chat variable API is available
    const chatNs = vscode.chat as any;
    if (typeof chatNs?.registerChatVariableResolver !== 'function') {
        console.log('[ChatVars] vscode.chat.registerChatVariableResolver not available — skipping');
        return;
    }

    const resolvers: ResolverDef[] = [
        {
            id: 'tomAi.quest',
            name: 'quest',
            description: 'Current active quest ID',
            resolve: () => {
                try { return ChatVariablesStore.instance.quest; } catch { return ''; }
            },
        },
        {
            id: 'tomAi.role',
            name: 'role',
            description: 'Current AI role / persona',
            resolve: () => {
                try { return ChatVariablesStore.instance.role; } catch { return ''; }
            },
        },
        {
            id: 'tomAi.activeProjects',
            name: 'activeProjects',
            description: 'Currently active project IDs',
            resolve: () => {
                try { return JSON.stringify(ChatVariablesStore.instance.activeProjects); } catch { return '[]'; }
            },
        },
        {
            id: 'tomAi.todo',
            name: 'todo',
            description: 'Current todo summary from the active quest',
            resolve: () => {
                try { return ChatVariablesStore.instance.todo; } catch { return ''; }
            },
        },
        {
            id: 'tomAi.workspaceName',
            name: 'workspaceName',
            description: 'Current workspace name',
            resolve: () => vscode.workspace.name ?? '',
        },
    ];

    for (const def of resolvers) {
        try {
            const registerIds = [
                def.id,
                def.id.replace(/^tomAi\./, 'dartscript.'),
            ];

            for (const variableId of registerIds) {
                const disposable = chatNs.registerChatVariableResolver(variableId, {
                    resolve: async (_name: string, _context: any, _token: vscode.CancellationToken) => {
                        const value = def.resolve();
                        if (!value) { return []; }
                        return [
                            {
                                level: 1, // ChatVariableLevel.Full
                                value,
                                description: def.description,
                            },
                        ];
                    },
                });
                context.subscriptions.push(disposable);
            }

            console.log(`[ChatVars] Registered #${def.name}`);
        } catch (err) {
            console.warn(`[ChatVars] Failed to register #${def.name}:`, err);
        }
    }
}
