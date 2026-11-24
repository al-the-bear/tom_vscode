/**
 * The MD Browser page's message protocol, as code (the contract is
 * `doc/md_browser_page_protocol.md`): its version, the capabilities a host
 * declares in the first-paint data, and the messages the page and a host
 * exchange, each with the capability it belongs to.
 *
 * A host gives the page `window.__INIT__` with `protocolVersion` and
 * `capabilities` ({@link mdBrowserInit}); the page refuses a version that is
 * not its own, hides the controls of a capability not declared and posts none
 * of its messages. The page names its version in `webviewReady`; a host checks
 * it ({@link mdBrowserVersionProblem}).
 *
 * `media/markdownBrowser/main.js` carries the same version, capabilities and
 * capability-of-message table (a page script cannot import this file); the
 * test mdBrowserProtocol.test.ts holds the two and the document together.
 *
 * Pure: no `vscode`, no `fs`.
 */

/** The protocol's version: raised when a message or a field changes in a way a host or the page must follow. */
export const MD_BROWSER_PROTOCOL_VERSION = 1;

/** What a host may declare it answers. */
export const MD_BROWSER_CAPABILITIES = ['editing', 'reviewMarks', 'teamReview', 'assists', 'askBar', 'navigation'] as const;
export type MdBrowserCapability = typeof MD_BROWSER_CAPABILITIES[number];

/** The document picker's prefix in the page: its messages are `<prefix>GetGroups` … */
export const MD_BROWSER_PICKER_PREFIX = 'mdBrowser';

/**
 * Every page → host message, with the capability it belongs to (`core`: sent
 * to every host).
 */
export const MD_BROWSER_PAGE_MESSAGES: Readonly<Record<string, MdBrowserCapability | 'core'>> = {
    webviewReady: 'core',
    reload: 'core',
    reconnect: 'core',
    setCrlf: 'core',
    openInEditor: 'core',
    openExternal: 'core',
    renderMarkdown: 'core',
    openMarkdownPreview: 'core',
    panelSettings: 'core',
    applyEdit: 'editing',
    editState: 'editing',
    reviewMark: 'reviewMarks',
    reviewAllChanges: 'reviewMarks',
    reviewAuthorChanges: 'teamReview',
    assistQuestion: 'assists',
    assistCancel: 'assists',
    askAnswer: 'askBar',
    askKeepFile: 'askBar',
    navigateLink: 'navigation',
    goBack: 'navigation',
    goForward: 'navigation',
    readingPosition: 'navigation',
    // Answered by a host; the page of this version does not send it (the groups come after webviewReady).
    mdBrowserGetGroups: 'navigation',
    mdBrowserGetFiles: 'navigation',
    mdBrowserLoadFile: 'navigation',
    mdBrowserBrowseFile: 'navigation',
};

/** Every host → page message, with the capability it belongs to. */
export const MD_BROWSER_HOST_MESSAGES: Readonly<Record<string, MdBrowserCapability | 'core'>> = {
    mdContent: 'core',
    somComments: 'core',
    markdownHtml: 'core',
    reconnected: 'core',
    editResult: 'editing',
    actionDone: 'reviewMarks',
    reviewTeam: 'teamReview',
    assistOverlay: 'assists',
    askBar: 'askBar',
    askBarClear: 'askBar',
    navState: 'navigation',
    scrollToAnchor: 'navigation',
    mdBrowserGroups: 'navigation',
    mdBrowserFiles: 'navigation',
    mdBrowserBrowsedFile: 'navigation',
};

/** The first-paint data of the protocol, as a host gives it in `window.__INIT__`. */
export interface MdBrowserInit {
    protocolVersion: number;
    capabilities: MdBrowserCapability[];
    /** An `mdContent` message rendered before the first round trip. */
    content?: Record<string, unknown>;
}

/**
 * The first-paint data of a host that answers `capabilities` (default: all,
 * as the editor's host does), with `content` when it gives the document at
 * once. A name that is no capability is refused.
 */
export function mdBrowserInit(capabilities: readonly string[] = MD_BROWSER_CAPABILITIES, content?: Record<string, unknown>): MdBrowserInit {
    const unknown = capabilities.filter((c) => !(MD_BROWSER_CAPABILITIES as readonly string[]).includes(c));
    if (unknown.length) { throw new Error(`Not a capability of the MD Browser page: ${unknown.join(', ')} (${MD_BROWSER_CAPABILITIES.join(', ')})`); }
    return {
        protocolVersion: MD_BROWSER_PROTOCOL_VERSION,
        capabilities: MD_BROWSER_CAPABILITIES.filter((c) => capabilities.includes(c)),
        ...(content ? { content } : {}),
    };
}

/**
 * Why a page naming `pageVersion` in `webviewReady` cannot be answered by this
 * host, or undefined when the versions agree. A page that names none is the
 * host's own (an embedding page of the same build).
 */
export function mdBrowserVersionProblem(pageVersion: unknown, hostVersion: number = MD_BROWSER_PROTOCOL_VERSION): string | undefined {
    if (pageVersion === undefined || pageVersion === null || pageVersion === hostVersion) { return undefined; }
    return `The MD Browser page speaks protocol version ${String(pageVersion)}, this host version ${hostVersion}. `
        + 'The page and its host come from different builds: install one build of both (in the editor: reinstall the extension and reload the window).';
}
