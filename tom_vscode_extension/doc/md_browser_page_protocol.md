# The MD Browser page protocol

**Protocol version: 1**

The MD Browser's page (`media/markdownBrowser/` with `media/shared/mdQuestions.js`, `mdOverlay.js` and `assistOverlay.js`) renders a Markdown document and lets a reader navigate, answer, edit and review it. The page changes no file and decides nothing about a document's text by itself: it asks its **host**, and the host answers. This document is the contract between the two, so that a second host can show the same page. The Tom AI extension's host is `src/handlers/markdownBrowser-handler.ts`.

In code the version, the capabilities and the capability of every message are in `src/utils/mdBrowserProtocol.ts` (for a host) and at the top of `media/markdownBrowser/main.js` (the page). How a host composes the page and publishes the host object is in `_copilot_guidelines/media_webview_migration.md` § The MD Browser page and its host.

## 1. Transport

- **Page → host:** the page calls `window.__tomVscodeApi.postMessage(message)`. A host publishes that object before the page's scripts run; `getState()` / `setState(state)` are optional and hold a small state for the page (`{filePath, liveMode}`).
- **Host → page:** the host posts a `message` event to the page's window with the message as its `data`.
- Every message is a JSON object with a `type`. A message whose `type` the receiver does not know is ignored.
- Lines are 0-based, and a range `startLine` … `endLine` excludes `endLine`.
- `filePath` is the host's name for a document. The page treats it as opaque, sends it back with every message about that document, and compares it for equality.

## 2. First-paint data and the version

The host gives the page `window.__INIT__` before `main.js` runs:

| Field | Meaning |
| --- | --- |
| `protocolVersion` | The version the host speaks (this document's: 1). |
| `capabilities` | What the host answers: any of `editing`, `reviewMarks`, `teamReview`, `assists`, `askBar`, `navigation` (§ 3). |
| `content` | Optional: an `mdContent` message (§ 5) the page renders before its first round trip. |

**The version is checked on both sides.**

- The page compares `protocolVersion` with its own. On a mismatch it shows a message in place of the document (*The MD Browser page speaks protocol version …, its host version …*), wires nothing, and still posts `webviewReady` with its own version, so the host knows too.
- The page names its version in `webviewReady.protocolVersion`. A host that reads another version answers with an `mdContent` whose `error` says so and sends nothing else. The extension's host also shows the error as a notification.

A page given no `protocolVersion` at all is embedded by a page of its own build (the extension's QUEST NOTES side panel): it takes every capability as declared and checks nothing. A host of its own — any host this document is written for — always gives the version.

**The version is raised** when a message, a field or a rule changes in a way the other side has to follow: a message removed or renamed, a field's meaning changed, a new message the other side must answer. A new optional field, or a new message the receiver may ignore, does not raise it.

## 3. Capabilities

A capability is a group of messages a host answers. The page hides the controls of a capability the host did not declare, and posts none of its messages; the host sends none of its messages either. The extension's host declares all six.

| Capability | The controls it shows | Page → host | Host → page |
| --- | --- | --- | --- |
| *(core)* | The document, folding, indenting, search, the line indicator, Reload, Reconnect, CR/LF, Open in Editor, Open in External Viewer, long comments in the overlay | `webviewReady`, `reload`, `reconnect`, `setCrlf`, `openInEditor`, `openExternal`, `renderMarkdown`, `openMarkdownPreview` | `mdContent`, `somComments`, `markdownHtml`, `reconnected` |
| `editing` | Edit mode, the block actions (edit, insert, comment), the answer button and the answer options of a question, a comment's edit button, Keep open, a proposed answer's Accept / Edit / Discard, a conflict's choices | `applyEdit`, `editState` | `editResult` |
| `reviewMarks` | Accept / reject on each inline mark, a comment on a change, Accept all / Reject all | `reviewMark`, `reviewAllChanges` | `actionDone` |
| `teamReview` | The Team button and its panel: the members, only one member's, accept or reject a member's changes, the revision history | `reviewAuthorChanges` | `reviewTeam` |
| `assists` | Grill me and Explain in detail on an open question, the "thinking" overlay | `assistQuestion`, `assistCancel` | `assistOverlay` |
| `askBar` | The bar of buttons above the document | `askAnswer`, `askKeepFile` | `askBar`, `askBarClear` |
| `navigation` | The document picker, Back / Forward, links to other documents, the link popup | `navigateLink`, `goBack`, `goForward`, `readingPosition`, `mdBrowserGetGroups`, `mdBrowserGetFiles`, `mdBrowserLoadFile`, `mdBrowserBrowseFile` | `navState`, `scrollToAnchor`, `mdBrowserGroups`, `mdBrowserFiles`, `mdBrowserBrowsedFile` |

Without `navigation` a link into the shown document (`#anchor`) is followed by the page itself; a link to another document does nothing. Section references (`OUTER > INNER`), search and the back / forward arrows *within* the document are the page's own and need no capability.

The marks, comments, questions and team colours are always *rendered*; the capabilities decide only whether the reader can act on them.

## 4. Page → host messages

| Message | Capability | Fields | What the host does, and its answer |
| --- | --- | --- | --- |
| `webviewReady` | core | `protocolVersion` | Checks the version (§ 2). Then sends what the page needs first: `mdContent` for the document to show, and per capability `askBar` (an open ask), `assistOverlay`, `mdBrowserGroups`. Sent once, shortly after the page's scripts ran. |
| `reload` | core | — | Reads the shown document again and answers `mdContent` (with `error` when there is none). |
| `reconnect` | core | — | Re-establishes its watch of the shown document, answers `mdContent` and then `reconnected`. |
| `setCrlf` | core | `value` (boolean) | Turns the conversion of escaped / literal line breaks on or off and answers `mdContent` with `crlf` and `lineMap` to match. |
| `openInEditor` | core | — | Opens the shown document in the host's text editor. No answer. |
| `openExternal` | core | — | Opens the shown document in the system's viewer. No answer. |
| `renderMarkdown` | core | `title`, `markdown` | Renders a long comment's Markdown to safe HTML and answers `markdownHtml`; the page shows it in its overlay. |
| `openMarkdownPreview` | core | `title`, `markdown` | Shows the same comment in a view of the host's own. No answer. |
| `applyEdit` | editing | `editId`, `filePath`, `startLine`, `endLine`, `expected`, `replacement`, `notifyOnError`? | **The guarded line edit** (§ 6.1): replaces the lines with `replacement` if they still hold `expected`. Answers `editResult` with the same `editId`, then `mdContent` with the new text when it changed. With `notifyOnError` (a one-click action without an editor to show the failure in) the host also tells the user of a refusal. |
| `editState` | editing | `openEditors` (number) | Notes whether the page holds unsaved text (so the host does not close or replace the page silently). No answer. Sent at start (0) and when the count changes. |
| `reviewMark` | reviewMarks | `filePath`, `startLine`, `endLine`, `expected`, `markup`, `occurrence`, `decision`, `text`? | **One inline mark decided** (§ 6.2). `decision`: `accept`, `reject`, `remove` (a comment), `comment` (write `text` on a change), `edit` (replace a comment's text). Answers `actionDone`, after `mdContent` when the text changed. The page shows a busy state until either arrives. |
| `reviewAllChanges` | reviewMarks | `filePath`, `decision` (`accept` / `reject`) | Decides every change mark of the document (comments and highlights stay). Answers `actionDone`, after `mdContent` when something changed. The extension's host offers an Undo while the file is untouched. |
| `reviewAuthorChanges` | teamReview | `filePath`, `author` (member id), `name`, `decision` (`accept` / `reject`) | Decides every change mark one member made (§ 6.3). Answers as `reviewAllChanges`. |
| `assistQuestion` | assists | `use` (`grillMe` / `explainInDetail`), `filePath`, `questionId`, `answerLine` | Starts the assist on that open question (in the extension: a prompt to an agent). Progress comes as `assistOverlay`; the result arrives as a changed document (`mdContent`). |
| `assistCancel` | assists | `id` (the run's) | Cancels the running assist, or dismisses a failed one. Answered by `assistOverlay` with `view: null`. |
| `askAnswer` | askBar | `requestId`, `button` (its id), `keepFile` (boolean) | Takes the click as the answer of the open ask. Answers `askBarClear`. |
| `askKeepFile` | askBar | `requestId`, `keepFile` (boolean) | Notes the checkbox's state for the open ask. No answer. |
| `navigateLink` | navigation | `href`, `filePath`, `position`, `newPanel`? | Follows a link of the shown document: `#anchor` → answers `scrollToAnchor`; another Markdown document → shows it (`mdContent`, `navState`), in a new page when `newPanel`; anything else as the host sees fit (the extension opens a file in the editor). `position` is the reading position being left (see `readingPosition`). |
| `goBack` | navigation | `filePath`, `position` | Steps back in the host's history of documents: answers `mdContent` (with the `position` recorded for that document) and `navState`. |
| `goForward` | navigation | `filePath`, `position` | The same, forward. |
| `readingPosition` | navigation | `filePath`, `position` (`{line, delta, scrollTop}`) | Records where the reader is in the shown document, for `goBack` / `goForward`. No answer. Sent when scrolling settles. |
| `mdBrowserGetGroups` | navigation | — | Answers `mdBrowserGroups`. The page of this version does not send it: the groups arrive unasked after `webviewReady`. A host answers it all the same, for a page that asks. |
| `mdBrowserGetFiles` | navigation | `group` | Answers `mdBrowserFiles` with the documents of that group. |
| `mdBrowserLoadFile` | navigation | `group`, `file` | Shows that document (`mdContent`, `navState`). With `group: "other"`, `file` is a path the user typed. |
| `mdBrowserBrowseFile` | navigation | — | Lets the user pick a file with the host's own dialog; answers `mdBrowserBrowsedFile` and shows the document. |

## 5. Host → page messages

| Message | Capability | Fields | What the page does |
| --- | --- | --- | --- |
| `mdContent` | core | `content`, `filePath`, `relativePath`, `fileName`, `anchor`?, `position`?, `author`, `memberId`, `liveMode`, `crlf`, `lineMap`, `error`? | Renders the document. `content` is the Markdown as shown; `relativePath` (else `fileName`) is displayed; `anchor` is scrolled to, else `position` (a reading position recorded earlier) is restored. `author` signs the comments the reader writes; `memberId` marks the reader's own lines in a team review. `liveMode`: the document is followed at its end as it grows. `crlf`: escaped / literal line breaks were converted, and `lineMap` then gives for each shown line its line in the file (`null`: they are the file's lines), which the page uses for the ranges it sends. `error`: shown instead of a document. The same message answers every request that changes what is shown, and is sent unasked when the document changes on the host's side. |
| `somComments` | core | `filePath`, `contentLength`, `nextCommentNumber`, `formFieldRanges`, `questions`, `team`, `revisions` | What the host's specification runtime read from the text just sent (matched by `filePath` and `contentLength`): the next free comment id, the line ranges where no comment is offered, each question's options and recommended option, the document's own review team and its revision history. A host without such a runtime does not send it; the page then works from the Markdown alone. |
| `markdownHtml` | core | `title`, `html` | Shows the rendered comment in the overlay (the answer to `renderMarkdown`). |
| `reconnected` | core | `filePath`, `liveMode` | Marks the reconnect as done and, in live mode, follows the end again. |
| `editResult` | editing | `editId`, `ok`, `error`? | Closes the editor of that edit (`ok`), or shows `error` in it and leaves the text. |
| `actionDone` | reviewMarks | — | Ends the busy state of a review decision the host answered without new content. |
| `reviewTeam` | teamReview | `filePath`, `members` | The team of the review round the document belongs to (member id, name, role, guest), for names, colours and the filter. `[]`: the document belongs to no round. |
| `assistOverlay` | assists | `view` (`{id, label, questionId, file, phase, startedAt, phaseSince, error?}` or `null`) | Shows the running assist's overlay with its phase and elapsed time and a Cancel button; `null` takes it off. |
| `askBar` | askBar | `bar` (`{requestId, title?, buttons: [{id, label}], keepFile, timeoutAt?}`) | Shows the bar: the title, a button per entry, the *Keep this file* checkbox, and the deadline when `timeoutAt` is given. |
| `askBarClear` | askBar | `requestId`, `note` | Takes that bar off and leaves `note` in its place. |
| `navState` | navigation | `canGoBack`, `canGoForward` | Enables the Back and Forward buttons. |
| `scrollToAnchor` | navigation | `anchor` | Scrolls to that anchor of the shown document (the answer to a `navigateLink` into it). |
| `mdBrowserGroups` | navigation | `groups` (`[{id, label}]`), `projects`, `quests` | Fills the picker's first list; the `project` and `quests` groups open a second list from `projects` / `quests`. |
| `mdBrowserFiles` | navigation | `files` | Fills the picker's file list for the group asked for. |
| `mdBrowserBrowsedFile` | navigation | `file` | Puts the picked path into the picker's *Other file* field. |

## 6. The decisions that are the host's

The page proposes; the host decides and writes. A host that implements a capability implements its decision the way the extension's host does, or the page and the document drift apart.

### 6.1 The guarded line edit (`applyEdit`)

The page sends the range it rendered, the text it saw there (`expected`) and what to put in its place. The host reads the document as it is *now*, checks that lines `startLine` … `endLine` still hold `expected`, and only then replaces them with `replacement`. If they do not — the file changed underneath — it refuses with `editResult {ok: false, error}` and writes nothing; the page keeps the reader's text in the editor. The host also refuses a `filePath` that is not the document it shows. After a successful write it answers `editResult {ok: true}` first and `mdContent` second, so the page can patch its view and skip the refresh of the same text. In the extension: `applyMdLineEdit` (`src/utils/markdownBrowserEdits.ts`).

Every text change the page makes with `editing` is such an edit: an answer written, a block edited or inserted, a comment added, a proposed answer accepted or discarded, a conflict decided. The page composes the replacement text (the answer marker, the comment's header and id); the host only guards and writes.

### 6.2 The inline marks (`reviewMark`, `reviewAllChanges`)

Accepting or rejecting a change mark, removing a comment, and writing or editing the comment of a change are done by the host on the block's lines, by the specification notation's own rules (SOM § 11.9.3): the page names the mark by its `markup` and its `occurrence` among identical marks of the block, and the guard of § 6.1 applies to the block (`expected`). The page never rewrites a mark itself. In the extension: `reviewMarkEdit`, `decideAllChanges` (the TomSpecs runtime).

### 6.3 The review team (`reviewTeam`, `somComments.team`, `reviewAuthorChanges`)

Who is on the team, which review round a document belongs to and what each member wrote are read by the host: from the round's folder (`reviewTeam`) and from the document itself (`somComments.team`, `revisions`). The page shows them and filters by member; deciding all of one member's changes is the host's (`decideAuthorChanges`), by the attribution the notation records (SOM § 11.9.8).

## 7. What a minimal host answers

A host that declares no capability answers `webviewReady` with one `mdContent` and may ignore every other message: the page then is a reader with folding, search and in-document links. `src/handlers/mdBrowserTestHost.ts` is such a host (`node scripts/md-browser-test-host.cjs --out <file.html> --capabilities none`).
