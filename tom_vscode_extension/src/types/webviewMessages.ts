export interface WebviewMessage {
    type: string;
    [key: string]: unknown;
}

export interface ChatPanelSendMessage extends WebviewMessage {
    type: 'send';
    panelId: 'localLlm' | 'aiConversation' | 'copilot' | 'tomAiChat';
    text: string;
    templateId?: string;
}

export interface ChatPanelDraftMessage extends WebviewMessage {
    type: 'saveDraft' | 'loadDraft';
    panelId: string;
    text?: string;
}

export interface TodoPanelMessage extends WebviewMessage {
    type: 'create' | 'update' | 'delete' | 'move' | 'refresh';
    todoId?: string;
    data?: Record<string, unknown>;
}
