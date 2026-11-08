/**
 * The guard in front of everything that needs DartScript, the Dart bridge
 * (`tom_bs`): when the binary is missing on this platform
 * (services/dartBinariesStatus.ts — neither configured nor bundled), the
 * bridge is not started and every entry point stops with the same sentence:
 *
 *   `<feature> needs DartScript, which is not available on <platform>: the tom_bs binary is missing.`
 *
 * - a command shows it as an error with "What does this mean?", which opens
 *   the page about the Dart binaries, and returns the tool answer (so
 *   tomAi_runVscodeCommand gets it as the command's result);
 * - a tool answers {@link DartScriptUnavailableAnswer};
 * - Telegram replies with the sentence.
 *
 * Every check reads the binaries again, so a binary configured or copied in
 * later works on the next @T: Restart Bridge, without a reload.
 */

import { currentDartBinary, dartBinariesHelp } from '../services/dartBinariesStatus';
import { getCurrentPlatform } from '../utils/executableResolver';
import { showWithDartBinariesHelp } from './dartBinariesHelp-handler';
import { bridgeLog } from './handler_shared';

export function dartScriptUnavailableMessage(feature: string, platform: string = getCurrentPlatform()): string {
    return `${feature} needs DartScript, which is not available on ${platform}: the tom_bs binary is missing.`;
}

export class DartScriptUnavailable extends Error {
    constructor(readonly feature: string, readonly platform: string = getCurrentPlatform()) {
        super(dartScriptUnavailableMessage(feature, platform));
        this.name = 'DartScriptUnavailable';
    }
}

/** What a tool (or a guarded command, as its result) answers when DartScript is unavailable. */
export interface DartScriptUnavailableAnswer {
    ok: false;
    code: 'dartScriptUnavailable';
    error: string;
    help: string;
    page: string;
}

/** Whether tom_bs is there for this platform, read now. */
export function isDartScriptAvailable(): boolean {
    return currentDartBinary('tom_bs').source !== 'missing';
}

/** Throws {@link DartScriptUnavailable} when tom_bs is missing on this platform. */
export function requireDartScript(feature: string): void {
    if (!isDartScriptAvailable()) { throw new DartScriptUnavailable(feature); }
}

export function dartScriptUnavailableAnswer(error: DartScriptUnavailable): DartScriptUnavailableAnswer {
    const { help, page } = dartBinariesHelp();
    return { ok: false, code: 'dartScriptUnavailable', error: error.message, help, page };
}

/**
 * The guard for a command or handler: undefined when DartScript is available;
 * otherwise one line in the bridge log, the error with the help button (unless
 * `silent`), and the answer to return. The message is not awaited: a command
 * must not wait for the user to dismiss it.
 */
export function guardDartScript(feature: string, options: { silent?: boolean } = {}): DartScriptUnavailableAnswer | undefined {
    try {
        requireDartScript(feature);
        return undefined;
    } catch (e) {
        if (!(e instanceof DartScriptUnavailable)) { throw e; }
        bridgeLog(`[DartScript] ${e.message}`, 'INFO');
        if (!options.silent) { void showWithDartBinariesHelp('error', e.message); }
        return dartScriptUnavailableAnswer(e);
    }
}

/** For a chat reply (Telegram): the sentence when DartScript is unavailable, else undefined. */
export function dartScriptUnavailableText(feature: string): string | undefined {
    return isDartScriptAvailable() ? undefined : dartScriptUnavailableMessage(feature);
}
