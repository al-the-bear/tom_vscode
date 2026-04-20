/**
 * Shared CSS for the @TOM sidebar notepad providers. Extracted from
 * `sidebarNotes-handler.ts` as the first step of Wave 2.1 of the
 * review refactoring plan — the same block used to be inlined at the
 * top of every `_getHtml()` in all 10 provider classes.
 *
 * Kept as a plain string so providers can concatenate it into their
 * own HTML without a build step; the extra rules specific to a given
 * provider (e.g. minimal-mode empty-state centering) can still be
 * appended after this block.
 */
export const NOTEPAD_BASE_STYLES = `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        padding: 8px;
        height: 100vh;
        display: flex;
        flex-direction: column;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        background-color: var(--vscode-panel-background);
        color: var(--vscode-foreground);
    }
    .toolbar {
        display: flex;
        gap: 4px;
        margin-bottom: 8px;
        flex-shrink: 0;
        flex-wrap: wrap;
        align-items: center;
    }
    .toolbar-row {
        display: flex;
        gap: 4px;
        width: 100%;
        align-items: center;
        margin-bottom: 4px;
    }
    .toolbar-row label {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        white-space: nowrap;
    }
    button, select {
        padding: 4px 8px;
        border: 1px solid var(--vscode-input-border);
        background-color: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        cursor: pointer;
        border-radius: 2px;
        font-size: 12px;
    }
    button:hover { background-color: var(--vscode-button-secondaryHoverBackground); }
    button.primary {
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
    }
    button.primary:hover { background-color: var(--vscode-button-hoverBackground); }
    button.danger { color: var(--vscode-errorForeground); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    button.icon-btn {
        padding: 4px 6px;
        min-width: 24px;
    }
    select {
        background-color: var(--vscode-dropdown-background);
        color: var(--vscode-dropdown-foreground);
        flex: 1;
        min-width: 80px;
    }
    textarea {
        flex: 1;
        width: 100%;
        resize: none;
        border: 1px solid var(--vscode-input-border);
        background-color: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        padding: 8px;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: var(--vscode-editor-font-size, 13px);
        line-height: 1.4;
        outline: none;
    }
    textarea:focus { border-color: var(--vscode-focusBorder); }
    .status-bar {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        margin-top: 4px;
        display: flex;
        justify-content: space-between;
    }
    .empty-state {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--vscode-descriptionForeground);
        text-align: center;
        padding: 20px;
    }
    .profile-info {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        padding: 4px 8px;
        background: var(--vscode-textBlockQuote-background);
        border-radius: 4px;
        margin-bottom: 8px;
        max-height: 60px;
        overflow-y: auto;
    }
    .placeholder-help {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        margin-top: 8px;
        padding: 8px;
        background: var(--vscode-textBlockQuote-background);
        border-radius: 4px;
    }
    .placeholder-help code {
        background: var(--vscode-textCodeBlock-background);
        padding: 1px 4px;
        border-radius: 2px;
    }
`;
