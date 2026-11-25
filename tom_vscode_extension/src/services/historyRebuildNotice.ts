/**
 * The notice after a reconcile: when another host's compact trail
 * (`history/trail.<host>.md`) holds turns newer than that host's time in this
 * host's history watermark, the user is offered "Rebuild history and memory"
 * — once per change of what is ahead, never for this host's own trail.
 * Checked when a trail file of the quest changes on disk and at window start
 * (the wiring: src/handlers/historyRebuildNotice-handler.ts).
 *
 * vscode-free.
 */

import { hostTrailFileName, readHostTrails } from './hostTrail';
import { HistoryNoticeGate, hostsAheadOfHistory, readHistoryWatermark } from './questHistory';

export interface HistoryRebuildNotifierOptions {
    /** `_ai/quests/<quest>` */
    questFolder: string;
    /** This host's slug: its own trail never raises the notice. */
    ownHost: string;
    /** Show the notice naming the hosts whose turns the history does not cover. */
    show(hosts: string[]): void;
}

export interface HistoryRebuildNotifier {
    /** Check now (window start): shows the notice when one is due. Answers the hosts named, if any. */
    check(): string[] | undefined;
    /** A file of the quest's `history/` folder changed: checks unless it is no trail or this host's own. */
    onHistoryFileChanged(fileName: string): string[] | undefined;
}

/** The notifier of one quest. */
export function createHistoryRebuildNotifier(opts: HistoryRebuildNotifierOptions): HistoryRebuildNotifier {
    const gate = new HistoryNoticeGate();
    const own = hostTrailFileName(opts.ownHost);
    const check = (): string[] | undefined => {
        const ahead = hostsAheadOfHistory(readHostTrails(opts.questFolder), readHistoryWatermark(opts.questFolder), opts.ownHost);
        const hosts = gate.check(ahead);
        if (hosts) { opts.show(hosts); }
        return hosts;
    };
    return {
        check,
        onHistoryFileChanged(fileName: string): string[] | undefined {
            if (fileName === own || !/^trail\..+\.md$/.test(fileName)) { return undefined; }
            return check();
        },
    };
}
