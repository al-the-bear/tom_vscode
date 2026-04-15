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

// ----- Anthropic chat panel (anthropic_sdk_integration.md §11.4) ------------

export interface AnthropicSendMessage extends WebviewMessage {
    type: 'sendAnthropic';
    text: string;
    model: string;
    profile: string;
    config: string;
}

export interface AnthropicRefreshModelsMessage extends WebviewMessage {
    type: 'refreshAnthropicModels';
}

export interface AnthropicClearHistoryMessage extends WebviewMessage {
    type: 'clearAnthropicHistory';
}

export interface AnthropicOpenMemoryMessage extends WebviewMessage {
    type: 'openAnthropicMemory';
}

export interface AnthropicToolApprovalResponseMessage extends WebviewMessage {
    type: 'anthropicToolApprovalResponse';
    toolId: string;
    approved: boolean;
    approveAll: boolean;
}

export interface AnthropicModel {
    id: string;
    name?: string;
    created?: number;
}

export interface AnthropicModelsMessage extends WebviewMessage {
    type: 'anthropicModels';
    models: AnthropicModel[];
    error?: string;
}

export interface AnthropicProfilesMessage extends WebviewMessage {
    type: 'anthropicProfiles';
    profiles: Array<{ id: string; name?: string }>;
    configurations: Array<{ id: string; name?: string }>;
}

export interface AnthropicTokenMessage extends WebviewMessage {
    type: 'anthropicToken';
    token: string;
}

export interface AnthropicToolApprovalMessage extends WebviewMessage {
    type: 'anthropicToolApproval';
    toolId: string;
    toolName: string;
    inputSummary: string;
}

export interface AnthropicResultMessage extends WebviewMessage {
    type: 'anthropicResult';
    text: string;
    turnsUsed: number;
    toolCallCount: number;
    historyMode?: string;
}

export interface AnthropicErrorMessage extends WebviewMessage {
    type: 'anthropicError';
    message: string;
}

export type AnthropicWebviewToExt =
    | AnthropicSendMessage
    | AnthropicRefreshModelsMessage
    | AnthropicClearHistoryMessage
    | AnthropicOpenMemoryMessage
    | AnthropicToolApprovalResponseMessage;

export type AnthropicExtToWebview =
    | AnthropicModelsMessage
    | AnthropicProfilesMessage
    | AnthropicTokenMessage
    | AnthropicToolApprovalMessage
    | AnthropicResultMessage
    | AnthropicErrorMessage;
