/**
 * The Status Page's reminder settings (a part of its Queue & Timer section,
 * `data-section="reminders"`): the alive check — a reminder sent into a
 * queue item's conversation when its answer has not come in time — on or off,
 * its timeout, and the window's run's default reminder template (the one a new
 * queue item takes; the Prompt Queue editor's toolbar shows the same per run).
 * The templates themselves are edited in the Prompt Template Editor (category
 * Reminder).
 *
 * Actions: `setReminderOn` / `setReminderOff`, `saveReminderSettings`
 * (`timeoutMinutes`, `templateId`; listeners.js gathers them),
 * `editReminderTemplates` (`itemId`). vscode-free.
 */

export interface ReminderSettingsModel {
    /** The alive check is on (ReminderSystem config `enabled`). */
    enabled: boolean;
    /** Minutes an item waits for its answer before the reminder (ReminderSystem `defaultTimeoutMinutes`). */
    timeoutMinutes: number;
    /** The run whose default template is shown (the window's). */
    run: string;
    /** That run's default reminder template id; '' or undefined: none (the reminder system's default applies). */
    runDefaultTemplateId?: string;
    /** The template the reminder system falls back to (ReminderSystem `defaultTemplateId`). */
    fallbackTemplateId: string;
    templates: ReadonlyArray<{ id: string; name: string }>;
}

function esc(s: string): string {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The timeout as the reminder system keeps it: a whole number of minutes, at least 1; else undefined. */
export function parseReminderTimeout(value: unknown): number | undefined {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 1) { return undefined; }
    return Math.round(n);
}

export function reminderSettingsHtml(m: ReminderSettingsModel): string {
    const fallback = m.templates.find((t) => t.id === m.fallbackTemplateId)?.name ?? m.fallbackTemplateId;
    const selected = m.runDefaultTemplateId ?? '';
    const options = [`<option value=""${selected === '' ? ' selected' : ''}>(none: the reminder default, ${esc(fallback)})</option>`]
        .concat(m.templates.map((t) => `<option value="${esc(t.id)}"${t.id === selected ? ' selected' : ''}>${esc(t.name)}</option>`))
        .join('');
    return `<div class="sp-reminders" data-section="reminders">
        <div class="sp-settings-row" title="The alive check: when a queue item's answer has not come within the timeout, a reminder prompt is sent into its conversation.">
            <label>Alive check:</label>
            <div class="sp-controls sp-toggle">
                <button class="sp-btn ${m.enabled ? 'primary' : ''}" data-status-action="setReminderOn">On</button>
                <button class="sp-btn ${!m.enabled ? 'primary' : ''}" data-status-action="setReminderOff">Off</button>
            </div>
            <label for="sp-reminder-timeout">after</label>
            <input type="number" id="sp-reminder-timeout" min="1" step="1" value="${m.timeoutMinutes}" style="width:56px"> <span>minutes</span>
        </div>
        <div class="sp-settings-row" title="The reminder template a new queue item of run ${esc(m.run)} takes (the Prompt Queue editor's toolbar shows the same for every run).">
            <label for="sp-reminder-template">Default reminder template (run ${esc(m.run)}):</label>
            <select id="sp-reminder-template">${options}</select>
            <button class="sp-btn" data-status-action="editReminderTemplates" title="Edit the reminder templates in the Prompt Template Editor">Edit templates</button>
            <button class="sp-btn primary" data-status-action="saveReminderSettings">Save</button>
        </div>
    </div>`;
}
