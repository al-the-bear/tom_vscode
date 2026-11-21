/**
 * Every view that shows the guideline picker (gsel5), redrawn after a level
 * changed (gsel5b): the Prompt Queue editor gets its state again
 * (`refreshQueueEditorState`, which carries the picker's shared levels and the
 * runs' choices) and every open todo view a fresh `qtAspects`
 * (questTodoPanel-handler `postTodoAspectsToAllViews`).
 *
 * Called after every level write of the picker's messages
 * (aspectPickerMessages.ts), after another window's all-windows change (the
 * `setAspectChoice` window request) and after the quest-default commands
 * (aspectChoiceCommands.ts), so a change made in one page shows in the other
 * without a reload. A todo's own choice is not a shared level: it is written
 * to the todo file, whose watcher reloads the todo views.
 *
 * Both handlers are loaded when a refresh runs: they import the picker's
 * message handler, which imports this module.
 */

/** What a refresh redraws (swapped in tests). */
export interface AspectViewRefreshers {
    /** The Prompt Queue editor, when it is open. */
    queueEditor(): void;
    /** Every open todo view (panels, sidebar views, the pop-out). */
    todoViews(): void;
}

/* eslint-disable @typescript-eslint/no-require-imports -- loaded lazily, see the module comment */
const liveRefreshers: AspectViewRefreshers = {
    queueEditor: () => (require('./queueEditor-handler') as typeof import('./queueEditor-handler')).refreshQueueEditorState(),
    todoViews: () => { (require('./questTodoPanel-handler') as typeof import('./questTodoPanel-handler')).postTodoAspectsToAllViews(); },
};
/* eslint-enable @typescript-eslint/no-require-imports */

let refreshers: AspectViewRefreshers = liveRefreshers;

/** Swap what a refresh calls (tests); undefined restores the live views. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- the `__…ForTests` seam convention
export function __setAspectViewRefreshersForTests(next: Partial<AspectViewRefreshers> | undefined): void {
    refreshers = next ? { ...liveRefreshers, ...next } : liveRefreshers;
}

/** Redraw every view showing the picker; one that fails does not keep the others from it. */
export function refreshAspectViews(): void {
    for (const [name, refresh] of [['queue editor', refreshers.queueEditor], ['todo views', refreshers.todoViews]] as const) {
        try {
            refresh();
        } catch (err) {
            console.warn(`[AspectViews] refreshing the ${name} failed:`, err);
        }
    }
}
