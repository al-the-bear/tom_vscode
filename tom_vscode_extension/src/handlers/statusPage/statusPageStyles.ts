/**
 * Static CSS for the Status panel.
 *
 * Wave 3.2 continuation — `statusPage-handler.ts` is ~3,000 lines;
 * the embedded-status stylesheet is the single largest static block
 * and has no dependencies on handler state, so it moves cleanly out
 * here. The rest of the handler (HTML builders, message routing,
 * settings writes) keeps living in the handler because it wires
 * directly into per-section state and the webview contract.
 *
 * Re-exported from `../statusPage-handler.ts` so downstream callers
 * (`wsPanel-handler`, the bottom-panel embed) keep their imports
 * unchanged.
 */

export function getEmbeddedStatusStyles(): string {
    return `
/* Status Panel Container */
.sp-panel { display: flex; flex-direction: column; gap: 8px; padding: 8px; overflow-y: auto; max-height: 100%; }

/* Section styling */
.sp-section { 
    border: 1px solid var(--vscode-panel-border); 
    border-radius: 4px; 
    background: var(--vscode-editorWidget-background); 
    padding: 8px;
}
.sp-section-header { 
    display: flex; 
    justify-content: space-between; 
    align-items: center; 
    margin-bottom: 0;
}
.sp-section-header.sp-collapsible { cursor: pointer; user-select: none; }
.sp-section-header.sp-collapsible:hover { opacity: 0.8; }
.sp-section-title { font-weight: 600; font-size: 12px; display: flex; align-items: center; gap: 4px; }
.sp-collapse-icon { font-size: 10px; transition: transform 0.2s; display: inline-block; width: 12px; }

/* Badge styling */
.sp-badge { padding: 2px 8px; border-radius: 8px; font-size: 10px; font-weight: 500; }
.sp-running { background: var(--vscode-testing-iconPassed); color: white; }
.sp-stopped { background: var(--vscode-testing-iconFailed); color: white; }

/* Controls and buttons */
.sp-controls { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; margin-bottom: 4px; }
.sp-btn {
    padding: 3px 8px; border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 3px; cursor: pointer; font-size: 11px;
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
}
.sp-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
.sp-btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.sp-btn.primary:hover { background: var(--vscode-button-hoverBackground); }
.sp-btn.small { padding: 2px 6px; font-size: 10px; }
.sp-btn.danger { background: var(--vscode-inputValidation-errorBackground); border-color: var(--vscode-inputValidation-errorBorder); }
.sp-btn.danger:hover { filter: brightness(1.1); }

/* Model config row */
.sp-model-config-row { justify-content: flex-start; }
.sp-model-name { font-weight: bold; min-width: 80px; }
.sp-model-info { color: var(--vscode-descriptionForeground); flex: 1; overflow: hidden; text-overflow: ellipsis; }

/* LLM Configuration cards */
.sp-llmconfig-card, .sp-aisetup-card {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    padding: 8px;
    margin-bottom: 8px;
    background: var(--vscode-editor-background);
}
.sp-llmconfig-header, .sp-aisetup-header {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-bottom: 8px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--vscode-panel-border);
}
.sp-config-name, .sp-setup-name { flex: 1; font-weight: bold; }
.sp-config-id, .sp-setup-id { width: 120px; font-size: 10px; color: var(--vscode-descriptionForeground); }
.sp-tools-section { margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--vscode-panel-border); }
.sp-tools-grid { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.sp-tool-checkbox {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    font-size: 10px;
    padding: 2px 4px;
    border: 1px solid var(--vscode-input-border);
    border-radius: 2px;
    background: var(--vscode-input-background);
    cursor: pointer;
}
.sp-tool-checkbox:hover { background: var(--vscode-list-hoverBackground); }
.sp-tool-checkbox input { margin: 0; }

/* Toggle button group */
.sp-toggle .sp-btn { border-radius: 0; }
.sp-toggle .sp-btn:first-child { border-radius: 3px 0 0 3px; }
.sp-toggle .sp-btn:last-child { border-radius: 0 3px 3px 0; }

/* Mode buttons row */
.sp-mode-buttons { display: flex; gap: 4px; align-items: center; font-size: 11px; margin-top: 4px; }
.sp-mode-buttons span { color: var(--vscode-descriptionForeground); }

/* Settings row */
.sp-settings-row { 
    display: flex; 
    align-items: center; 
    gap: 6px; 
    flex-wrap: wrap; 
    margin-top: 4px; 
    font-size: 11px;
}
.sp-settings-row label { color: var(--vscode-descriptionForeground); min-width: auto; }
.sp-settings-row input, .sp-settings-row select { 
    padding: 2px 4px; 
    font-size: 11px; 
    border: 1px solid var(--vscode-input-border);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border-radius: 2px;
}
.sp-settings-row input[type="number"] { width: 50px; }
.sp-settings-row input[type="text"] { flex: 1; min-width: 80px; max-width: 150px; }
.sp-settings-row select { min-width: 60px; max-width: 120px; }
.sp-settings-row textarea {
    padding: 2px 4px; font-size: 11px;
    border: 1px solid var(--vscode-input-border);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border-radius: 2px; resize: vertical; width: 100%;
    font-family: var(--vscode-font-family);
}

/* Collapsible content */
.sp-collapse-content { overflow: hidden; transition: max-height 0.2s ease-out; }
.sp-collapse-content.sp-collapsed { max-height: 0 !important; overflow: hidden; padding: 0; margin: 0; }

/* Subsection (nested within collapsible content) */
.sp-subsection { 
    margin-top: 8px; 
    padding-top: 8px; 
    border-top: 1px solid var(--vscode-panel-border); 
}
.sp-subsection-title { 
    font-size: 11px; 
    font-weight: 600; 
    color: var(--vscode-descriptionForeground); 
    margin-bottom: 6px; 
}

/* Editor links */
.sp-links { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.sp-link-btn { 
    padding: 4px 8px; 
    font-size: 11px; 
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 3px; 
    cursor: pointer;
    background: var(--vscode-button-secondaryBackground); 
    color: var(--vscode-button-secondaryForeground);
    text-align: left;
}
.sp-link-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }

/* Schedule editor */
.sp-schedule-slot {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px; padding: 6px; margin-bottom: 4px;
    background: var(--vscode-editor-background);
}
.sp-schedule-slot .sp-slot-header { display: flex; justify-content: space-between; align-items: center; cursor: pointer; user-select: none; }
.sp-schedule-slot .sp-slot-body { overflow: hidden; }
.sp-schedule-slot .sp-slot-body.sp-slot-collapsed { max-height: 0 !important; overflow: hidden; padding: 0; margin: 0; }
.sp-sched-cb { display: inline-flex; align-items: center; gap: 2px; margin-right: 3px; font-size: 11px; cursor: pointer; }
.sp-sched-cb input[type="checkbox"] { margin: 0; }
.sp-sched-inline-row { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-top: 4px; font-size: 11px; }

/* Executables editor */
.sp-exec-entry {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px; padding: 6px; margin-bottom: 4px;
    background: var(--vscode-editor-background);
}
.sp-exec-entry strong { font-size: 11px; }

/* Full page button */
.sp-fullpage { border: none; background: none; padding: 4px 0; margin-top: 4px; }
.sp-expand { width: 100%; justify-content: center; display: flex; align-items: center; gap: 4px; }

/* Selects in controls */
#sp-bridgeProfile { padding: 3px 6px; font-size: 11px; min-width: 80px; }
`;
}
