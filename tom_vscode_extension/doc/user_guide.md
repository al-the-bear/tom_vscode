# @Tom Extension User Guide

## 1) What the extension provides

The extension combines VS Code automation, bridge-based scripting, Copilot workflows, Anthropic chat with tools, local LLMs through Anthropic profiles, a prompt queue with timed requests, and dedicated output channels for observability.

## 2) Panels and layout

Current bottom panel layout:

- `@CHAT` (`tomAi.chatPanel`): **Copilot**, **ANTHROPIC/LLM** and **Logs** in an
  accordion layout (pin, rotate). Each of the two chat subpanels can send its
  prompt to the prompt queue. The Logs section shows one session's live trail,
  prompts, answers and running prompt, with a session switch; the session's
  history, memory and Clear are behind it — see [Logs Panel](#logs-panel).
- `@WS` (`tomAi.wsPanel`): Guidelines, Documentation, Settings, Issues, Tests, Quest TODO. The Documentation section's sub-tabs hold the document editor and the quest's own documents — see [Documentation Panel](#documentation-panel).

Both subpanels are queue-compatible.

### Setting up a workspace, creating quests

- **Setup New Workspace Folder** (`@T: Setup New Workspace Folder`; also the
  button on the panels of a folder without `.tom/` and at the top of the Status
  Page, beside **Create new quest**) unpacks the workspace template the VSIX carries — a root part (the
  configuration, the root guidelines with the shared `workspace_agents.md`, CLAUDE.md, AGENTS.md, the `_ai`
  roles, processes, schemas and prompts, the starting quest `tomai_introduction`) and a workspace part (its
  `.tom`, AGENTS.md, CLAUDE.md, guidelines) — as one of three setups: **a new root with a first workspace
  folder** (the root in the folder you pick, the workspace folder in a named subfolder, its `_ai` linked to the
  root's), **a workspace folder in an existing root** (refused unless a folder above has `.tom/tom_root.yaml`;
  its `_ai` linked to the root's) or **a standalone workspace folder** (both in one folder, no
  `tom_root.yaml`). Every `.code-workspace` it and **Create new quest** write sets `chat.useAgentsMdFile`. A
  folder that is not empty shows what is in it first (**Set up anyway** goes
  on). For each file that already exists you choose **Overwrite**, **Skip**,
  **Overwrite All**, **Skip All** or **Cancel** (what was written stays); the
  end reports what was written, overwritten and skipped (**Show the file
  list**). Then it says what in `.tom/tom_vscode_extension.json` to adapt (the
  bridge profiles' paths, `bridge.executables`, the Local LLM endpoint, the API
  key's environment variable; **Open the configuration**), offers to register
  Tom AI's `_ai` merge drivers in git (**For this _ai repository** when `_ai`
  is one, **For all repositories (global)**; the rules go into
  `_ai/.gitattributes`; see *Upgrading the workspace* › Merge drivers) and asks
  what to open: the introduction quest or the folder, each in a new window, or
  stay here.
- **AI workspaces** — one `_ai` folder serves several workspace folders (e.g.
  `tom_agent_container` and `al_the_bear`), and a workspace works on some of
  the quests. `_ai/workspaces/<workspace>.yaml` lists them (`quests:`; a quest
  may be in several workspaces); `<workspace>` is the name of the window's root
  folder. **@T: Open AI Workspace Quests** (`tomAi.editor.aiWorkspaceQuests`,
  also in Extension Tools) shows every quest with a checkbox and its short
  description: **Save** writes the list (creating the file), **All quests**
  removes it, **Open the file** shows it as text; a listed quest that no longer
  exists is named. The workspace's quests come first wherever quests are chosen
  — the todo panel's *Workspace quests* scope (where @TOM TODO starts), moving a
  todo to another quest, the done notification's quest in the queue editor, the
  chat panel's quest prompt scopes, `tomAi_listQuests` and
  `tomAi_getQuestWindowStatus` — and **All quests…** (or the other quests,
  marked) reaches every quest. Without a list the workspace has every quest.
  Open a quest's `.code-workspace` from inside its workspace folder (the
  folder first, then the file's *Open Workspace* button): opened directly
  through a symlinked `_ai`, VS Code takes the symlink's target folder as the
  root, and the workspace name follows it.
- **Create New Quest** (`@T: Create New Quest`) asks the quest id (letters,
  digits and `_`, not taken), a name and — optional — what the quest is for in
  a sentence or two, creates `_ai/quests/<id>/` with the quest's files (empty
  but for their headings; `short_description.<id>.md` holds its title, that
  purpose or a pointer to the setup todo, and a `**State:**` line) and offers
  to open the quest's workspace. No table lists the quests: when a window opens
  a quest it records the quest's workspace folder (relative to the root) in the
  quest's `extension_config.<quest>.yaml` (`workspaceFolder`), and a
  workspace's quests are its list in `_ai/workspaces/<workspace>.yaml`, else
  the quests recorded for its workspace folder, else every quest
  (`${workspaceQuests}`, `tomAi_getWorkspaceInfo` with `include`). Its one todo,
  `questsetup1_<code>-define-the-quest`, defines the quest with you in question
  rounds when you run it in the queue or the chat, and fills in the short
  description; the quest refresh keeps it current. The quest lists show it
  (the todo panel's quest scope, the queue editor's quest picker, AI Workspace
  Quests, `tomAi_listQuests`). Agents run the command with
  `{ id, name, purpose, offerOpen }` (the `!create quest` pattern prompt does).
- **No quest is open:** while the window's workspace is not a quest's (quest
  `default`), @CHAT, @WS and the @TOM views PROCESS, QUEST NOTES, QUEST TODOS,
  SESSIONS and SESSION TODOS show a banner *No quest is open. Open a quest
  workspace (`_ai/quests/<id>/<id>.code-workspace`) or create one.* with **Create
  new quest** and **Setup new workspace folder**.
- **The quest overview once:** the first time a quest's window opens on a
  machine, its `overview.<quest>.md` opens in the MD Browser (the focus stays
  where it is; not when a restored tab shows it already). It is remembered per
  quest in the VS Code profile's global state (`tomAi.questOverview.shown`);
  afterwards the overview is in @WS › Documentation › Quest Overview.

### Guidelines Panel

The Guidelines panel in @WS provides a document browser for the guidelines. Features:

- **Levels**: **Workspace** is the workspace folder's guidelines folder, **Root** the root's (when the root is another folder); a level holding both `_agent_guidelines/` and `_copilot_guidelines/` shows each as its own entry
- **Project dropdown**: Filter guidelines by project (shows projects with an `_agent_guidelines/` or `_copilot_guidelines/` folder)
- **Quest dropdown**: Filter guidelines by quest (shows quests when quest project type selected)
- **Link navigation**: Click links to navigate within the panel or open in Markdown Browser

### Logs Panel

The Logs section of @CHAT shows what one Anthropic session wrote: its live trail,
its prompts and answers, and the prompt it last sent. Every session — `default`
(the prompt queue), `chat` (the ANTHROPIC/LLM panel) and each named session — keeps
these in `_ai/quests/{quest}/history/sessions/{session}/`. It is read-only; use
the toolbar to edit.

- **Session actions**: behind the session switch, six icons work on the
  selected session — its raw trail viewer, its summary trail in the trail
  viewer, its rolling history and its live trail in the MD Browser, the memory
  panel on its quest memory, and clearing its history (asks first).
- **Session switch**: above the sub-tabs, one button per session, the most
  recently used first. With more than four sessions a dropdown holding every
  session comes first, and the buttons are the four most recently used; the
  chosen session shows in the dropdown when it has no button. The list follows
  sessions created and deleted while the section is open, and a session without
  that file yet shows a line saying so. The choice is one for the whole Logs
  section: switching the session on any sub-tab switches it on all of them, and
  it survives a window reload; without one the tabs show the queue session of
  the window's run. A run's items that name no session run in the run's
  default session, `default@<run>` (`default@collab`), each with its own trail;
  the `default` run's is `default@default`.
- **Sub-tabs**: **MD Trail** (the session's `live-trail.md`, rendered), **Trail**
  (the same file as highlighted source), **Prompts** / **Answers** (the session's
  `{quest}.anthropic.prompts.md` / `.answers.md`), **Current Prompt** (see below)
- **Remembered selection**: the active sub-tab and each sub-tab's session are
  restored after a window reload
- **Auto-refresh**: re-reads every 7 s while the section is expanded and the
  panel is shown; a file that has not changed costs no read
- **256 KB window**: a larger file is shown from the end its newest content is
  at — the last 256 KB (marked `(tail)`) of the two trail tabs, the first 256 KB
  (marked `(head)`) of the others
- **Follow scrolling**: the view opens at that same end, and a reader still
  sitting there stays there as the file grows; scrolling away to study something
  holds that position

The quest's own documents moved to the **Documentation** section (see
[Documentation Panel](#documentation-panel)).

#### Current Prompt sub-tab

Shows the prompt currently in flight, replaced on every send. A dropdown in the
toolbar — visible only on this sub-tab — picks which of six views to show:

| Option | Shows |
| --- | --- |
| Chat / Queue **Literal Prompt** | What you typed, before placeholders were expanded and before keyword triggers were stripped |
| Chat / Queue **User Prompt** | The user message that actually went to the model |
| Chat / Queue **System Prompt** | The assembled system prompt — empty when the profile has none |

Comparing the literal against the user prompt is the fastest way to see what a
template or a placeholder did to your text.

A queue item and a chat message can run at the same time, so the two keep
separate sets: the **Chat** options never show a queue item's prompt and vice
versa. The dropdown selection is remembered across a window reload alongside the
sub-tab.

The files behind it are the session's own copy in its trail folder
(`history/sessions/{session}/trail/current_prompt.*.md`), which is gitignored —
they change on every prompt, so they are deliberately kept out of what git
tracks. They are written for every Anthropic transport (direct SDK, Agent SDK,
vscodeLm) and persist after the answer arrives, so the tab still shows the last
prompt sent when nothing is running. Internal calls that run in no session
(history compaction, memory extraction) write none.

- **Toolbar**: **Refresh** re-reads the selected file from disk; **Open in
  editor** opens it in a normal text editor

### Documentation Panel

The Documentation section of @WS has its own sub-tabs:

- **Documents** — the document editor: pick a group (Workspace, Projects,
  Notes) and a file, edit it, open it in an editor or the MD viewer.
- The quest's documents, read-only like the Logs (the same toolbar, 7 s
  refresh and 256 KB window): **Quest Progress** (`progress.{quest}.md`),
  **Quest Overview** (`overview.{quest}.md`), **Quest Notes**
  (`quest-notes.{quest}.md`), **Quest Refresh** (`quest_refresh.{quest}.md`),
  **DocUpdate** (`quest_documentation_update.{quest}.md`), **Deferred**
  (`deferred.{quest}.md`), **Questions** (`questions.{quest}.md` — every question
  the model asked you and the answer you gave), **Decisions**
  (`decisions.{quest}.md` — the decisions carried by each todo, copied here when
  the todo is archived as completed). The three journals (Deferred, Questions,
  Decisions) are appended to and open at their end; the others open at the top.
  These are one set per quest, shared by every session. Not every quest has
  every document; a missing one is reported in the viewer.

### Markdown Browser

The Markdown Browser is a standalone webview panel for reading markdown documents with full navigation:

- **Open via**: the `@T: Open in MD Browser` command, link clicks in the Guidelines panel, or the tools (`tomAi_openInMdBrowser`, with `live: true` for follow-tail mode)
- **Document picker**: Grouped by Guidelines, Workspace Docs, Notes, Roles, Quests, Copilot Instructions, and Projects
- **Quest dropdown**: Secondary dropdown to filter quest documents when in quest context
- **Link resolver**: Clickable `.md` links navigate within the browser; special link types include `quest:`, `issue:`, `todo:`, and `test:` protocols; non-`.md` files open in the VS Code editor; external URLs open in the system browser; a link may be URL-encoded (`%20` for a space, as in `[the design](../my%20designs/design.md)`): the path as written is tried first, then the decoded one, so a file with `%` in its name opens too
- **Links to files elsewhere**: when a link names no folder, or its file is not where it says, the browser looks for the file by its name — first in the document's folder and its subfolders, then in the current quest's folder, the workspace folder's guidelines, the root's guidelines (a nested workspace) and finally the whole workspace folder — and opens it from the first of these places that has it. When that place has several files of the name, a picker lists them with their folders; when the link names folders too (`dart/unit_tests.md`), the files whose path ends with them are kept. Tool and build folders (`node_modules`, `.git`, `.dart_tool`, `build`, `out`, `ztmp`, …) are not searched. Only when no place has it does the *File not found* warning show. The quest notes panel's View tab follows links the same way
- **The reading notation**: any Markdown document may mark secondary text (the DocSpecs specification's *Reading Notation*), and the browser renders it instead of showing its markup. A fenced div marks a block — `::: {.provenance}` (or `::: provenance`) on a line, the text, `:::` on a line of its own — and `[text]{.aside}` marks a span; the citation shapes `(-> C2.1, TR-07)` (*backed by*), `(<- notes.md#SEC)` (*taken from*) and `(<~ notes.md)` (*extrapolated from*) are citations. By default `provenance`, `editorial` and `aside` blocks are **collapsed** to one line naming the kind (or its `label="…"`) and the start of the text — a click opens it, the small `▾ kind` tag closes it again — and spans and citations are a small **marker** † that shows the text on hover and opens on a click; `refs` and `records` are shown compactly (a reference list on one line, a records table scrolling sideways); a kind the browser does not know is shown as it is. A `provenance` block's `source="…"` is linked when it is open, and so is a citation's path. What you open stays open when the document is rendered again and resets for another file. The **Reading** group in the toolbar: the eye button shows all marked text at once (a second click goes back), and **Reading** opens the kinds with their counts in this document, a mode for each (blocks: collapsed / shown; inline: marker / dimmed / shown) and *Reset to defaults*. Nothing is ever hidden for good: a search match or a question the arrows step to inside a collapsed block is opened. An unclosed div ends at the next heading and is shown with a warning; a `:::` with nothing to close shows as a muted line; `\:::` and fences in code are text. In edit mode a div is one block: edit shows it with its fences, insert adds to its text, and a comment goes after its closing fence.
- **Links in plain text**: a path to a Markdown file written as plain text — `iterations/notes.md`, `../other.md`, `clarifications.sbp.md` — is a link like any Markdown link, resolved relative to the document and then to the workspace root (code blocks are left alone).
- **Tab titles name the file**: `MD: <name>` (`MD (live): <name>` for a live panel); while another MD Browser shows a different file of the same name — a step folder's copy of a document, say — both titles add the parent folder. Agents see the same list with `tomAi_listMdBrowserPanels` (and in `tomAi_getOpenEditors`), including whether a panel has an in-place editor open with unsaved text.
- **Grill me / Explain in detail**: every unanswered question block (the review syntax, plain Markdown and TomSpecs documents alike) has two buttons after its answer button. **Grill me** (flame) runs the *Grill me* Assist prompt: the agent asks you narrowing questions in the question panel until the question can be answered, then proposes the answer. **Explain in detail** (book) runs the *Explain in detail* prompt: the agent writes a note beside the document (`<document folder>/notes/<question id>-explained.md`), shows it with its dig-deeper choices, and may end with a proposed answer. The notes these prompts write (Explain in detail, Explain a decision, Grill me at a decision), and the documents the question and review rounds of a process keep, name every file they refer to as a Markdown link relative to themselves, so each opens with one click in the MD Browser. Both run outside the queue in the ANTHROPIC/LLM panel, in a temporary session (`tmp-…`) based on the session the document's work runs in — the session of the process's current position, else `default` — so they do not wait for a running walk; the temporary session is removed when the turn ends. If the panel is busy, you are told to try again. When the turn has ended and the question is still open, the question panel asks for its answer with the question's own choices, one selectable at a time: **Accept the proposed answer** (when the agent proposed one), each option — the recommended one marked *(recommended)* — and **Leave it open**. The proposal is preselected, and its text is already in the field under the question: **Send answers** accepts it as it stands there, so edit it first to change it. Without a proposal the recommended option is preselected. Select another choice to answer with it and add your own words if you like (with an option they are written after it, `(b) …`), or clear the selection and type an answer of your own. In a TomSpecs document the proposal is the reviewer comment starting `Proposed answer:` under the question; accepting it writes the Answer through the spec tools and resolves the comment. What you send is written into the Answer line. While the agent works between two of your answers — after you answered a round and before its next question, the proposal or the end — the MD Browser panel on the document and the @CHAT panel show an overlay: *the agent is thinking about the next step on DP-19*, the document, and how long it has been thinking. **Cancel** stops the turn: the document stays as it is (a proposal already written stays), and no answer is written; a notification says it was cancelled. When the turn fails, the overlay shows the error (**Dismiss**, or it goes after 15 seconds); it never stays once the turn has ended. A notification then says how the question ended — what was written into which file and line (**Open file** opens it there), that the agent answered it during the turn, that it is left open, or why the answer could not be written — and the same line is added under the turn's answer in its prompt queue entry and to the Tom Prompt Queue output channel.
- **Proposed answers**: a proposal written under a question (`> **Proposed answer** (<source>, <date>): …`) shows **Accept** (writes it into the Answer line and removes it), **Edit** (opens it in an editor; saving writes the edited text into the Answer line) and **Discard** (removes it, the answer stays as it is). In a TomSpecs document the agent proposes as a reviewer comment instead.
- **An agent asking through a document**: an agent can open a file with its own buttons (Continue, Cancel, whatever its flow needs) and a **Keep this file** checkbox, checked by default, in a bar above the toolbar (`tomAi_askInMdBrowser`). It waits for your click — a queued prompt holds there — and goes on with the button you clicked; the bar then shows the answer. With the box unchecked the file is deleted and its panel closed as the flow goes on, also when the agent's deadline passes or you close the panel. At a review of the quest's process the bar carries **Finish review round**: one click closes that panel (only that one), confirms the review, moves the process on and queues the next step's prompt — or opens the decision when the process has one next. A gate's result carries the buttons of the decision after the gate (gate passed, gate failed): one click ends the gate's step and takes the decision.
- **After a window reload**: VS Code brings the MD Browser tabs back but starts each one only when it is shown; showing it reopens its file. Until then agents see the tab as `dormant`, with the file it showed, and can close it. A tab whose file no longer exists is closed when the window starts.
- **Open here or in a new browser**: hovering a link to a `.md` document shows a small popup with **Open here** and **Open in new MD Browser**; a plain click still opens it here.
- **Section references** (DocSpecs documents): a reference to section ids written `OUTER > INNER` (upper case ids joined by `>`, also inside backticks) is a link to that heading — the outer ids pick among headings that share the inner id. A single upper-case id with more than four letters (`PLTPLN`, `ASMRE-ASMP-PERSONA-ARCHETYPES`; ids may contain `-`) is a link too, to the first heading with that id, except inside that heading. References that name no heading stay plain text. A reference broken across lines is not one: the line starting with `>` is a quote.
- **Back and forth within the document**: following a section reference or an in-document anchor remembers where you were. The second pair of arrows, in the bar under the toolbar, goes back to it and forward again; the trail starts fresh for another document.
- **Search**: the search box in the same bar finds text in the document as you type (case-insensitive), shows which match is current and how many there are (*147/356*; *0/0* when nothing matches), and highlights the matches. It starts where you are reading — at the first match from the top of the view, and while you type on it stays on the current match — and counts every match in the document. Enter / Shift+Enter or the up / down arrows step through them, and after the last match comes the first from the top; a match inside a folded section unfolds it; Esc or the × in the box clears it; Cmd/Ctrl+F jumps to the box.
- **Line number support**: Links with `#L10` or `#L10-L20` fragments open source files at the specified line
- **Auto-reload**: File watcher (debounced ~200 ms) monitors the currently viewed file and re-renders on external changes; scroll position is preserved across same-file re-renders in normal mode
- **Reload** (the refresh button): renders the file again in any case — also when its text has not changed, and with a text area open (which is closed; the reading position stays)
- **While a change is saved** — Save, Save and next, a one-click answer, accepting / rejecting / removing a mark or a comment, accept / reject all — the browser shows a *Saving…* indicator with a wait cursor and takes no clicks or typing until the change is done (or refused)
- **While a text area is open** the search box and the review navigation (↑ / ↓ and the kinds) are disabled, so nothing scrolls or re-renders under the text you are writing; they come back when it is saved or discarded
- **Live mode (follow-tail)**: Opened by a session's live-trail action in the @CHAT Logs section, or by `tomAi_openInMdBrowser` with `live: true`. When the file only grew at its end (a live trail being written), only the new part is rendered, not the whole document; anything else (the start cut off, a change further up) renders it in full. Auto-scrolls to the bottom as events stream in; pauses when the user scrolls up and resumes when they return to the bottom
- **Anchor navigation**: a link with an anchor — `#anchor` in the document, `other.md#anchor` to another one — scrolls to it. The anchor is looked up in this order: an element with exactly that id; a heading carrying it as its section id (`<!--[TOKEN]-->` in a TomSpecs or DocSpecs heading: `#TOKEN` names its last id, case-sensitive, `#SBP.STKG.TOENV` its dotted full id; with the same id under several parents, the first in the document); the heading's words as a slug (`#stakeholders` for `## Stakeholders`, without its section-id label). So the back-links of an IR Specs Markdown rendering (`[`TOKEN`](<rendition>.md#TOKEN)`) reach their sections.
- **Position in the document**: the file bar shows `Line X / N` — the source line at the top of the view and the document's line count. While you drag far into a part not shown yet it reads `≈ Line X / N` until that part is drawn.
- **Navigation history**: Back/forward buttons with up to 100 entries; going back or forward to a document opens it where you left it (the block that was at the top of the view, at the same height)
- **Breadcrumb navigation**: Shows current document path
- **Folding sections**: every heading starts with a small triangle that folds or unfolds its section — its text and the subsections below it, up to the next heading of the same or a higher level. Each heading keeps its own state: folding a section and unfolding it again leaves its subsections folded or open as they were. In the action bar, the **fold all** button folds every section (and then offers to unfold all), and the level dropdown (H1, H2, … — the levels the document has, up to 10) with the button beside it folds or unfolds every heading of that one level. Beside a heading's triangle, **+** and **−** open or collapse every section of that heading's level inside its parent section — the heading and its siblings, nothing outside the parent; deeper sections keep their own state, and the tooltip names the level and the parent. They are there when the parent holds more than one section of that level. The folded state is kept while the document refreshes and starts fresh for another document; following a link to a heading inside a folded section unfolds it.
- **Indenting by heading level**: the indent button in the action bar shifts every heading right by its level (a level-*n* heading by *n* − 1 steps) and the content of its section one step further, so the outline reads at a glance. The dropdown beside it sets a step to 1, 2 (default), 3, 4, 6 or 8 spaces. It stays on while the document refreshes.
- **Answering review questions**: every `**Answer:**` marker (outside code blocks) carries a small comment button. It opens a 5-line text area, resizable by its corner handle; the button gives way to **Save**, **Discard** and **Save and next** while it is open — Save and next saves (if anything changed) and opens the next unanswered question. It opens with the answer already written there, so an answer can be corrected or cleared; an unanswered question opens with its **recommended option** filled in (`(b)`). Hovering the button lists the question's options — `(a)`, `(b)` …, the recommended one in bold — and a click on one writes it as the answer at once; *Write an answer…* opens the text area. The recommended option is the one written bold (`**(b)**`, the TomSpecs rule), else the one whose text says "recommended", else the letter of a `*Recommendation:*` line. In a TomSpecs document the options and the recommended option are those the TomSpecs runtime reads — the same as the agents' tools see — once the browser has read the document (a moment after it opens); until then, and in any other Markdown file, the browser reads them itself by the same rules. Save writes it right after the marker — `**Answer:** your text` — and the browser stays where it was and shows the updated document. The answer is what the answer import reads: the rest of the marker's line and, in a blockquote, the following `>` lines up to a bare `>` line, a blank line or a line without `>` (outside a quote, the rest of the paragraph). A longer answer is written on further lines of the same quote; blank lines inside it are dropped, since they would end it.
- **Edit mode** (pencil button in the action bar): every paragraph, list, quote, table and code block shows two buttons at its end; switching edit mode on or off is immediate, also on large documents. **Edit** opens the block's markdown source in a text area, starting with the empty line that separates it from the block before — delete that newline to merge the block into the previous one. **Insert** opens an empty one whose text is appended directly to the end of the block — start it with an empty line for a new paragraph. The text is saved exactly as typed, newlines included. Both close with Save / Discard and keep the reading position; a save updates only the part of the page it changed. Large documents (several MB) render in short steps, so the window stays responsive while they open — the file bar shows the progress — and only the part around the view is laid out; the pages above and below it are prepared ahead, so scrolling does not show blank pages.
- **Review comments**: in edit mode every paragraph, list, quote, table and code block also has a **comment** button. It opens a text area after the block, filled in with the upward arrow, the document's next comment id (the highest `C-<n>` in the document + 1 — in a TomSpecs document the id the TomSpecs runtime gives the next comment, when that is higher, so the browser and the agents' tools never hand out the same id twice) and you as the author — `⬆️ **C-13** (Alexis):` and a space — and you write your comment after it. The author is the logged-in OS user: the first name of the account's full name (macOS account name, Linux GECOS field), else the login. On Save it goes into the document as a comment block of its own after the block, every line under `>` and a space: `> ⬆️ **C-13** your comment`. Id and author are optional in the notation (`> ⬆️ **C-12** (Alexis): …`, `> ⬆️ (Alexis): …`, `> ⬆️ …`); a missing id is added on save, and so is the author when the comment names none (a comment by someone else keeps its author). A comment block carries its own comment button, always visible: it reopens the comment without the `>` prefixes, and Save writes it back. Saving it empty asks once more (*Save again to remove it*) and then removes the block. Comment blocks are drawn with a yellow bar on a tinted background. In a TomSpecs (SOM) Markdown document a comment on a form belongs in the form's preamble, above its first field: from a form's first field to the next heading the blocks offer no comment button.
- **Inline review marks** (CriticMarkup, as in the TomSpecs notation) are drawn as marks with an icon each, so the kind of change is visible at a glance: `{++ added ++}` green with a ➕ diff icon, `{-- removed --}` struck through in red, `{~~ old ~> new ~~}` the old text struck through next to the new one in a dashed blue frame, `{== text ==}{>> comment <<}` highlighted (the comment as its tooltip and as a yellow note after it), and a `{>> comment <<}` alone as a yellow note. Marks inside code are left as text.
- **Marks from a selection** (edit mode): select text in a paragraph and **right-click** it. The menu offers **Comment on “…”** (the selection is highlighted and your comment attached: `{== text ==}{>> comment <<}`), **Mark for deletion** (`{-- text --}`, at once) and **Replace with…** (`{~~ old ~> new ~~}`); a right-click without a selection offers **Insert comment here…** (`{>> comment <<}` at that point). Comment and Replace open a text area under the paragraph; Save writes the mark. With a review member id set (Status Page, Team review) the mark is signed with it and the time (`{@you 2026-11-20T12:00+01:00}`), else it is unsigned. A mark stays within one paragraph and cannot go inside another mark, into code or html, or into a heading of a TomSpecs document; the menu then says why. A selection that crosses formatting (part of a bold word, a link) cannot be found in the source: edit the paragraph instead. Outside edit mode the right-click is VS Code's own.
- **Track changes** (the diff button beside the pencil; on for this panel until it is closed): while it is pressed, saving a paragraph's edit does not change the text but writes what you changed as marks, word by word — removed words `{-- --}`, added ones `{++ ++}`, a replaced run `{~~ old ~> new ~~}` — signed like the marks above, so the change can be accepted or rejected (*Reviewing changes*). An added line or paragraph is marked added, a removed one stays, marked removed; list markers, quote marks and heading hashes stay outside the marks. What cannot carry a mark is written as you typed it: code blocks, table rows, html, and a change to text that is already a mark. Text added with a block's **+** button is marked added too.
- **Reviewing changes**: in edit mode every change mark has an accept (✓) and a reject (✗) button, and every inline comment an edit (✎) and a remove button; one click decides that one mark, and the file is written by the TomSpecs runtime's rules — an accepted change keeps its new text, a rejected one its old text, a removed comment leaves the text it was on, and no double spaces are left behind. Every change also has a **Comment** button: it opens an editor under the paragraph, and Save writes a *change comment* right after the change, quoting it — `{~~ 30 ~> 15 ~~}{>> [~~ 30 ~> 15 ~~] why shorter? <<}` (SOM §11.9.3) — so the comment still says what it was about once the change is decided. A change's own comment is drawn beside it, once, with its own edit and remove buttons; accepting or rejecting the change keeps the comment and records the outcome in its quote, and such a comment is then drawn with the change and its outcome as a label (*30 → 15 (accepted): why shorter?*). Edit opens a comment's text in an editor under its paragraph — a `{>> comment <<}` alone, a change comment (its quote is kept) or a highlight's comment (on a highlight without one it reads *Add a comment*). Save has the TomSpecs runtime write it; saved empty, the comment is removed (a highlight keeps its marked text). A comment holding a mark delimiter (`{>>`, `{==`, `{++`, `{--`, `{~~`, `<<}`) or a blank line is refused in the editor, which keeps the text. A comment block's trash button removes it with one click. The action bar's **Accept all changes** (✓✓) and **Reject all changes** buttons decide every change mark of the document at once (comments stay for their own decision); the notification that follows offers **Undo** while the file is unchanged.
- **Stepping through a review**: the action bar's ↑ / ↓ buttons step through the kinds ticked in the popup the button between them opens (the count beside them says which target is current and how many the ticked kinds have, *2/14*; *–/14* before the first step, updated as you decide, answer or save) — **Changes**, **Comments** (comment blocks), **Inline comments**, **Questions**, **Unanswered** questions, **Marked: check here** (every `___check here___` marker) and **Agent comments** (comment blocks and inline comments an agent signed, `agent_<role>`), one or several at once, in document order (**Unanswered** is ticked when a document opens — the usual review; the button names them: *Unanswered*, *Changes + 2*, *All*, *Nothing*) — from the reading position, wrapping at the ends; the current one is outlined. After a save, an accepted or rejected change or a removed comment, the next step goes on from there: the question after the one just answered, the change after the one just decided (changing the ticked kinds goes on from the current target too). Stepping shows the context at the top of the view — a question's text above its answer, the paragraph a comment block is on — keeping the target itself, or the answer's open text area, in view. While **Unanswered** is ticked, stepping to an unanswered question opens its answer with the recommended option filled in. Under the kinds, **Whose** lists every author the document names — a comment block's `(author)` and the attribution tokens after marks (`{@alice}`, `{@agent_spec_author}`, SOM §11.9.8) — and *(no author)*, all ticked; unticking one leaves that author's comments and changes out of the arrows and the count (questions and markers are found whoever wrote them). The choice is kept while the browser is open, and an author new to the document comes in ticked. With your **review member id** set (Status Page, **Team review**, `review.memberId`) the comments you write here are signed with it, Whose names it *(you)*, and your own lines are marked with a green bar: your comments, the changes attributed to you (`{@<id>}`) and the individual answers that list you (`**Answer (<id>, …):**`). The spec tools write answers and marked changes as yours by default then. Below Whose, **Changed since** (*Any time*, *The last hour*, *Today*, *The last 24 hours*, *The last 7 days*, or *A chosen time…* with a date and time field) leaves out the comments, changes and questions not written or changed since then — the button then reads *… · since*; markers and conflicts carry no time and stay.
- **Change times**: when a comment, question, answer or change was written (SOM §11.9.10, `2026-11-07T14:05+01:00` in the document) is shown as a small label after its author — *just now*, *5 min ago*, *3 h ago*, *2 d ago*, after a week the date and time — with the full time and its offset as the tooltip; the labels follow the clock when you come back to the browser. What you write here records the time too: a new or edited comment's header `(<author>, <time>)`, an answer's marker `**Answer (<time>):**` (an emptied answer is `**Answer:**` again).
- **Team review rounds**: an agent runs a review by several people through files. It creates a round folder next to the document (`review-rounds/<name>-<date>/`) with one copy per team member, named by member id (`alice.tomspecs.md`, `alice.tomspecs.yaml`); each member reviews their own copy in the MD Browser. The agent then tells you who has returned theirs, merges the copies into `merged/` — each change and answer marked with who made it, a conflict block `⚖️ X-1` wherever two members changed the same passage differently — and writes the decision you take for each conflict. A copy from somebody not on the team counts as a guest's: the agent asks for their name and role. The team comes from the document's review team, else the solution blueprint's (for the document type, else its default); for a plain Markdown file you name it.
- **Consolidating a team review** (the merged document of a round): every change, vote, comment and individual answer carries a **chip** with the member's display name in the member's colour (names from the round's `round.yaml`, the document's review team and its revision history; an id nobody names is shown as it is). `**Answer (alice, bob):**` lines read *Answer (Alice Owner, Bob Dev):*. **Team** on the action bar opens the legend: each member with role (guests marked), **Only …** to dim everyone else's marks, comments and answers and leave them out of the arrows (**Everyone** undoes it), and ✓✓ / ✗ to accept or reject **all of one member's changes** (with Undo); below it the **revision history** with each round's team and reviewers, guests marked. A base mark the members voted on shows the votes (✓ Alice, ✗ Bob). A **conflict block** (`⚖️ X-1`) has one button per alternative and **Keep base**; **Decide** writes the chosen text into the paragraph and removes the block, **Rewrite…** opens the editor with the chosen text, **Keep open…** writes `open:` with a summary of the positions as its decision (a conflict about a form field, another value or an item is recorded as its decision and applied when the annotations are removed). A question the members answered opens its team-answer editor with the option most of them chose; **Keep open** beside it writes `open:` with each member's answer. Beside the arrows, the counter (*1 ⚖ · 2 ? · 3 ±*) says how many conflicts, open questions and undecided changes are left, and **Next unresolved** steps through them.
- **Agents' annotations and the check-here marker**: an agent signs what it writes into a reviewed document as `agent_<role>` (e.g. `agent_spec_author`; the annotation tools sign so when no author is given). An attribution token after a mark is drawn small after it. `___check here___` marks a section or comment that especially needs your eye; it is drawn as a yellow *check here* badge instead of bold italic text, and an agent's comment that uses it says why.
- **Long comments**: a comment block or inline comment longer than 200 characters carries two buttons, always shown: the eye shows the whole comment as Markdown in an overlay over the browser (close with ✕, Escape or a click beside it), the other opens it in the Markdown preview editor.
- **Editing is guarded**: a save is refused, and the text area stays open with the reason, when the file changed since it was shown, or when it has unsaved changes in an editor. With **CR/LF** on everything can be edited as usual, except a paragraph that holds a converted line break (an escaped `\n` or a bare CR in the file): its lines are not the file's lines, so it shows no editing buttons until CR/LF is off. When the file changes on disk while a text area is open — an agent wrote a proposal or an answer, Grill me accepted one — a text area with nothing typed in it is closed and the new version shows at once; when you have typed something, a bar names the questions that changed and asks: **Show the new version** (your typed text is dropped) or **Keep my text** (the new version shows when you close the text area; saving text typed against the old version is refused when its lines changed, so it never overwrites the new answer). After such a refresh the panel scrolls to the question that changed and marks it for a moment. A write by the agent's Markdown and spec tools renders every MD Browser panel on that file at once.

### Processes

A **process** is a named way of working through a quest, so you do not have to explain it to the agent again in every prompt. It has **phases**; each phase has **steps**, and a step can group **sub-steps** (the step is then just their group). A step or sub-step can name the **role** doing it. Every phase ends with a **quality gate** step and can have a **post-gate** step whose todos are done after the gate passed and before the next phase starts. Phases, steps and sub-steps can be **repeatable** — run in several iterations, optionally up to a maximum.

Processes live in `_ai/processes/<id>/`: `<id>.process.yaml` is the structure and `<id>.md` the description.

- **Process editor** — the hierarchy icon button at the bottom of every @CHAT subpanel (or `@T: Open Process Editor`). The list on the left shows every process; **+** creates one from a one-phase skeleton, the copy button duplicates the selected one under a new id. The form edits the name, summary, Markdown description and every phase, step, sub-step, gate and post-gate step: id, name, role, repeatable / maximum, description, **prompt** (what is to be done when it runs — Proceed puts it into the prompt it queues), **session** (the session its prompts run in, shown like the queue's session link — `name based on X, per prompt, profile`, or *inherited*; a click opens the session picker: an existing session, or a new one described by its base, lifetime, profile and name — the editor only writes the definition, Proceed creates the session; the ✕ clears it, so it is inherited from the step, then the phase, then the process; `${phase-iteration}`, `${step-iteration}` and `${substep-iteration}` in a name are filled in). The process itself has a **Session of every prompt** field: e.g. a per-prompt session with a profile makes every Proceed prompt start fresh. A profile this window does not have is refused on save, and the post-gate todos with an optional quest-todo id prefix, and on a gate **If the gate fails** — run it again, or back to one of the phase's steps (`onFail`). A phase, a step and a post-gate step (not a gate) have **optional** and a **runs** choice: *always runs*, *runs when a variable…* (a variable, then *is*, *is not*, *is one of* — comma-separated —, *is set* or *is not set*) or *runs when the agent judges…* (a text); see *Optional and conditional phases and steps* below. Problems are listed as you type; **Save** (Ctrl/Cmd+S) refuses an invalid definition. The descriptions are edited only here.
- **PROCESS view** (@TOM sidebar, first, above QUEST NOTES) — where the active quest is: process, phase, step and sub-step as dropdowns, each iteration with **−** / **+**, the role the step names, and the post-gate todos when in that step. **?** shows a description; the pencil opens the editor. Normally the agent keeps this current; you can set any of it by hand. **+** starts the next iteration (a new phase iteration starts again at its first step, a new step iteration at its first sub-step); **−** only corrects the number. A gate always has **+**: a failed gate is run again.
- **Action bar** (top of the PROCESS view) — the moves the process allows from the current position, as icon buttons (the tooltip says where each leads). The position shown is **what runs next**: nothing runs until you press **Proceed**.
  - **Proceed** (▶) — runs the current phase, step or sub-step: its prompt goes into the prompt queue, followed by a **process-move marker** (`⏭ move the process to …`). Everything the step's prompt queues in turn — todo walks, closing items — goes in before the marker. When the queue reaches the marker with all of them done, the state moves on to the next position, which runs only when you press Proceed again. Until then the view shows **⏳ running — N items left** and the next position, and Proceed is disabled; the queue editor shows each item's position (`[⚙ …]`) and the marker (`[⏭ process move]`). If an item of the step fails, the marker is held and the view shows **failed — see the queue**; Proceed then offers **Repeat the step** (queue it again) or **Move on** (as if it had finished). Skip, Back and setting the state by hand remove the marker; the step's items stay in the queue. After a **decision point** — every gate, the end of every phase, every repeatable sub-step and the end of every repeatable step (e.g. step 03 of the tom_specs process, after its verdict review) — it moves to the **decision** after it instead; Proceed's prompt and its marker are **process items**: the work of the step does not count towards the quest refresh (Status Page → Quest Refresh, *every N prompts*), and a refresh that is due waits for the next prompt that counts. The agent marks what the step queues the same way (`processItem: true` on `tomAi_addQueueItem`; the *Current process* section of its system prompt asks for it); the queue editor shows such an item with a dashed `[process item]` chip.
  - **Decide…** (a fork icon, framed) — Proceed at a decision. The view shows a *Decision — how does the process go on?* box listing the options; the button opens a dialog with them: **Go on to …** (the next position), **Repeat …** for every repeatable level that ends there (sub-step, step, phase — below its maximum; the iteration counts up and the first step / sub-step inside it is next), and after a gate **Gate passed — go on to …** / **Gate failed — run the gate again** or **— back to …** (the step the gate names in `onFail`, set in the process editor). A step entered again within the same round of its phase continues at its next iteration — the `onFail` step after a failed gate, and the steps after it as they come round again — so session names and todo prefixes that carry the iteration do not repeat an earlier round's; Back returns to the iteration a step was at. At the end of the process the forward option is **Finish the process** — the state file then records `completed: true` and the view says *The process is finished*; **Reopen** takes it back. Nothing is queued: the choice only moves the state. Beside the options the dialog offers **Grill me** (the agent asks you narrowing questions until it is clear which choice fits) and **Explain a decision** (the agent explains each choice); both run their Assist prompt in the ANTHROPIC/LLM panel, in a temporary session based on the process's session, and write their advice to a note in the quest's process folder (`_ai/quests/<quest>/process/decision-<time>-grill-me|explain.md`), shown in the MD Browser with the decision's own choices (**Go on to …**, **Repeat …**, **Gate passed** / **Gate failed** …) — a click takes that choice — and **Back to the decision**, which opens the decision again beside the note. A short answer may come through the question panel instead; when the agent's turn ends without the button having been used, the decision opens again by itself (unless you decided meanwhile). The decision stays yours. The decisions are not written in the definition: the extension puts one after every decision point;
  - **Continue in …** (a decision option) — a **follow-up process** the process, the phase or the step names (`followUps:`, edited in the process editor under *Follow-up processes*): instead of going on in this process, the position switches to the named process at its phase and step (the first ones by default), in the same run, the run's chat variables kept. A phase offers its follow-ups at the decision after its gate (or post-gate step), a step at its end (a step with follow-ups ends at a decision), the process at the end of its last phase. The switch records where it came from: the variables the follow-up names to carry (`carry`) with their values, and its **call context** (`context`: texts such as file names or comments, resolved when the switch is made), which the follow-up's prompts read as `${origin.<name>}`; `${process-origin}` is `<process>/<phase>`. The PROCESS view shows the chain (*Continued from …*), the quest's decisions journal records each switch, and the agent's process context says where it came from. Only the quest's own process (not a subprocess or branch) offers follow-ups; `tomAi_validateProcess` and the editor check that the target exists.
  - **Skip** — to the next position without running this one; **Back** — to the previous position, a correction (iterations are kept).
  - **Back to the start of the current phase (<phase>)** (a restart-frame icon, after Back; not at the phase's very start) — the phase's cycle again from its first step, without moving step by step: the first step's iteration counted on from the one it last ran at in this phase iteration, and the steps after it count on as they come round again, so their round folders continue; the phase iteration stays (it is a move, not a phase repeat, so a phase that is not repeatable has it too). The decision offers it at every decision inside the phase, and after a gate as **Gate failed — back to the start of the current phase (…)**. Written to the decisions journal.
  - **Back to the start of the previous phase (<phase>)** (a circled left arrow, after the current phase's button; not in the first phase) — to the first step of the phase before the current one, its iteration counted on from the one it was last in (bounded by its maximum; a phase not marked repeatable stays at 1), so its round folders and session names continue. After a gate the decision offers it too, **Gate failed — back to the start of the previous phase (…)**, also among the decision's buttons in the MD Browser (Grill me / Explain notes, `${gate-decision}`). It is the way back when a gate is a phase of its own after the phase whose work it checks: `onFail` only names a step of the gate's own phase. Either way the move is written to the quest's decisions journal (`decisions.<quest>.md`). The state file keeps the iteration each phase was last in (`phaseIterations`).
  - **Leave out** (step-out icon, labelled *phase* or *step*) — at the start of an optional or conditional phase, and in an optional or conditional step: past the whole phase or step, without running it. Unlike Skip it is recorded, with its reason, in the process state (see below).
  - **Start Subprocess or Branch…** (step-into icon in the view's title bar, `@T: Start Subprocess or Branch…`) — the processes the running step lists in its definition: `subprocesses:` (a level that hands a result back) and `branches:` (a level that hands nothing back); nothing else starts from a step. You pick one and what the step does when it ends — **Go on past the step**, **Run the step again**, or **Ask me at the end** (then the decision *… finished — go on to …* / *Run the step … again*). The process starts at its first position as a new level of the quest's process stack: the step below waits, only the new level moves, and its first Proceed goes in the queue behind the step below's items that are still there. Any depth, and a process may start itself again; a start beyond the depth set on the Status Page (**Process nesting**, default 5) asks first. When the level finishes its process, it is removed and the step below goes on. A process can declare **inputs** and **outputs** (name, kind — document, list of documents, folder — description, required), edited in the process editor: the step's list entry fills the inputs (`inputs:` in the definition, texts with placeholders resolved when the level starts, e.g. `docs/${step}.md`), and the level's prompts see them as `${input.<name>}`; a subprocess's agent sets the outputs (`tomAi_setProcessState {outputs}`, else an output's default value) before it finishes, and they come back to the step below as `${sub.<process>.<name>}`. A branch and an aborted level hand nothing back.
  - **The levels in the view** — while a subprocess or branch runs, every level below it is a collapsed section (its kind — the quest's process, a subprocess, a branch — its process and where it waits, the follow-up it gets, its inputs and the outputs handed back to it); the running level is open, with its kind, **Abort**, its inputs and the outputs set so far. The quest's own process is chosen only in the bottom section's **Process** dropdown — any process; switching while levels run asks first, since it leaves every level — and the running level shows its process without a dropdown: what starts from a step is only what the step lists.
  - **The agent's suggestions** — at the end of a step the agent may suggest processes the step lists (`tomAi_suggestSubprocess`, each with its reason and the follow-up it recommends). The view lists them under the running step (*Suggested: …*, **Review…** greyed while the step still runs, **Dismiss**); once the step's queue items are done the step's move waits and the process branching editor opens by itself, the suggested processes first with the agent's reason and recommendation. Start one, or Dismiss — the suggestions go and the process moves on as the step's run would have. The agent never starts or aborts a level; it sees the running level, a *Parent processes* list above it, and reads the stack with `tomAi_getProcessStack`, `tomAi_getProcessState {level}` and `tomAi_getSubprocessRuns`. A subprocess or branch that names no session runs in the session of the step that started it.
  - **Start a subprocess or branch…** in the *Your turn* box of a user-action step that lists processes opens the **process branching editor**: one card per listed process (both lists) — subprocess or branch, its summary and the entry's description, where it starts, the inputs the step fills — with a *When it ends* choice and **Start**; **Dismiss** closes the page, and it closes by itself once a level started or the position moved on. A process the agent suggested comes first, with its reason and its recommended follow-up selected.
  - **The process editor** edits, per step and sub-step, the **Subprocesses** and **Branches** lists — each entry a process (picked from the defined ones), an optional description, and a field for each input the process declares — and, at the top, the process's own **Inputs** and **Outputs**.
  - **Abort Subprocess or Branch** (step-out icon) — asks first, then removes the running level (where it stood goes to the quest's decisions journal) and the step below goes on with its follow-up.
  - **Confirm done** (a person icon, framed) — Proceed at a **user action**: a step or sub-step the process marks as yours (`userAction: true`), such as reviewing a document or answering its questions. The view shows it in a highlighted *Your turn — user action* box with what is to be done (its description), and the steps and sub-steps that are user actions carry 👤 in the dropdowns. A user action runs no prompt: the button opens no action page but a confirmation saying that this is a user action, what is to be done, and that you hereby confirm you have done it; **I confirm I have done it** moves the process on (after a decision point, to its decision).
  - **Documents** — a step or sub-step that names the documents it puts in front of you (`documents:` in the definition, a review step's) shows a link to each under its description, in the *Your turn* box at a user action: a Markdown document opens in the MD Browser (a panel already on it is brought to the front), a process definition in the process editor, any other file in its default editor. A link whose path is not known yet (a chat variable it uses is not set) or whose file does not exist yet is greyed out and says why. The process editor edits them per step and sub-step (**Documents**: a path with placeholders — `${<chat variable>}`, `${input.<name>}`, `${output.<name>}`, `${dirname:<variable>}` — and a label).
  - **Finish review round** — the button a review's results carry in the MD Browser when an agent step's closing item shows them (the tom_specs process does, `${finish-review-round}`). It is Confirm done for that review, made from the document: the click closes that panel, confirms the review, moves the process on and queues the next step's prompt; when the next position is a decision, the decision dialog opens instead. What the agent shows depends on what is under review: with one document, its current version is brought to the front and carries the button; with several, the agent writes a review document `review_<phase>_<step>_repetition_<n>_<timestamp>.md` in the round folder (`${reviewFile}` in the Assist prompt), which links each document with what changed and what to look at, opens the documents and puts the button on the review document. Panels still showing older copies are closed first. The button works in every process run: it confirms the review of the run whose prompt showed it, whichever run the PROCESS view shows (so does the gate's result below).
  - **The gate's result with the decision's buttons** — a gate's prompt that ends with `${gate-decision}` (the *Gate decision* Assist prompt) shows the gate's result — each checklist item, the answers taken in, the agent's recommendation with its explanation — in the MD Browser with the buttons of the decision after the gate: **Gate passed — …** and **Gate failed — …** (and Repeat where a level repeats there). The decision itself only opens once the gate's prompt has ended, so these buttons take it from the document while the prompt still waits: the click ends the gate's step and takes your choice as Decide… does; the document stays open with your choice in place of the bar. Close the panel instead, and the decision opens in the PROCESS view when the prompt has ended.

  Every button except Proceed only moves the state, at once. Proceed opens the **action page**: what runs, where the state goes afterwards (or that it stays for your decision), the **session** the prompt is queued in (the one the process names for this position, else the queue default; **Change…** opens the session picker for this prompt only), the `prompt` fields of what runs here (at a phase's first step the phase's too, at a step's first sub-step the step's too), a field for **custom instructions** and a live preview of the prompt. A session the process names that does not exist yet is created from the definition (its base too) when you confirm. **Add to queue** (Ctrl/Cmd+Enter) adds the prompt and its process-move marker to the prompt queue, which sends the prompt; the state moves when the queue reaches the marker (a position that queues no prompt, such as a user action, moves at once); **Cancel** changes nothing. The queued prompt — and every prompt it queues in turn, such as the todo walks of a planning step — runs as the position it belongs to: its role and the *Current process* section of its system prompt are those of that position.
- **Decision steps** — a step may be a decision step (`decision:` in the definition; the process editor's **Decision step** block on a step card: *make it a decision step*, how it is decided, and its targets — each a phase or step of the process from a dropdown, a label and a condition). It runs when the step before it has finished and chooses where the process goes next, any step or phase, earlier or later:
  - **automatic** (`mode: auto`) — the extension takes the first target whose condition holds (a target without one always holds), the moment the process reaches the step; when none holds, or a variable is not set, you decide.
  - **you decide** (`mode: user`, the default) — the step opens its decision at once: Decide… lists its targets.
  - **the agent judges** (`mode: judge`) — Proceed runs the step's prompt; the agent is told the targets and chooses one with `tomAi_setProcessState {decide: "<label>", reason: "<why>"}`, taken when the step's queue run ends; when it chooses none, you decide.

  Skip passes a decision step by without a jump. A jump counts the iterations on, so round folders continue: the target step continues at its next iteration within its phase's round, another phase starts at the iteration after the one it was last in, and so does every phase after it as the process moves on (Back stays a correction: going back into the previous phase and on again keeps the iteration). The PROCESS view marks decision steps *Decision:* in the step dropdown, shows how the current one decides with its targets, and lists under **Jumps** where the process jumped — from, to, the choice, by whom and why, newest first; the state file keeps them (`jumps`, at most 50) and each jump is written to the quest's decisions journal.
- **Non-linear processes** — by default the phases run in order. A phase may name the phases that may follow it, `next:` — phase ids, or `{phase: <id>, when: <condition>, label: <text>}`, `{end: true}` for the end of the process; `next: []` ends the process after the phase (the process editor's **Followed by** block on a phase card, whose title names the successors). The decision at the phase's end then offers **Gate passed — go on to …** for every successor whose condition does not fail (only one left: just that one; when every condition fails, all of them), and **Finish the process** for an end. So two branches can meet again at a later phase (a join: both name it), and a branch can end the process on its own. A **goto step** (`goto: <phase>/<step>`, `<phase>` or a step of its phase; **goto** in the step card's Decision step block) goes on at that place the moment the process reaches it, e.g. at the end of one alternative past the other. The process editor and `tomAi_validateProcess` check that every phase is reached (from the first phase, through the default order, `next:` and decision or goto steps) and that the process can end from every phase. When the phases are not a straight line the PROCESS view shows a **Flow** box — each phase with what may follow it, the current one ▶, those passed ✓ — and the **Path taken** (every phase iteration entered, kept as `phasePath` in the state file). *Back to the start of the previous phase* and Back across a phase boundary go to the phase the process came from (a phase that leads to the current one in the flow), not simply the one before it in the definition.
- **Optional and conditional phases and steps** — a phase or step (not a gate) may be `optional: true` and may carry a `when:` condition, in one of two notations; the key says who decides:
  - `when: {var: spec-mode, equals: change}` (or `notEquals`, `in: [a, b]`, `set: true | false`) — **the extension decides**, from the chat variables (a custom one by its name or as `custom.<name>`, the built-ins, and a subprocess's `input.<name>`). A move forward — Proceed, Skip, Go on, Gate passed, Leave out, a repeated phase, the start of a process or subprocess — passes every phase and step it enters whose test fails, and records it. A variable that is not set decides nothing (except `set`): the phase or step is entered, and the agent judges it.
  - `when: {judge: the change touches the data model}` — **the agent decides** when Proceed runs the step (for a phase, its first step): the *Current process* section gives it the condition; when it does not hold the agent does none of the work and calls `tomAi_setProcessState {leaveOut: "<why>"}`, and when the step's queue run ends the process leaves the phase or step out instead of moving on through it.
  - `optional: true` — you decide: **Leave out** in the action bar.

  Alternatives are two steps (or phases) with conditions that exclude each other: e.g. a first step where you set `spec-mode` to `initial` or `change`, then one step `when: {var: spec-mode, equals: initial}` and one `when: {var: spec-mode, equals: change}` — Proceed from the first goes to the one chosen, and from it past the other. The PROCESS view shows a phase's and the step's note (*optional*, *runs only when …* and whether it holds now), marks optional and conditional entries ⁇ and left-out steps *— left out* in the dropdowns, and lists under **Left out** what was left out — where, why and by whom (its condition, you, the agent), newest first — so which alternative ran is the one not listed. The record (`skipped` in the state file, at most 50) stays with the run until another process is chosen.
- **Process template editor** (the snippet button at the right of the action bar, the *Edit template* button on the action page, or `@T: Open Process Template Editor`) — the Proceed prompt template, the same for every process, stored in the extension config under `processActionTemplates.proceed`. The list on the right inserts a placeholder at the cursor: the action variables (`${custom-instructions}`, `${action-prompt}` — the `prompt` fields of what runs here, `${action-note}` — a note for a repeated run, `${action-position}`, `${action-after}` — what the view does after queuing, `${action-label}`, `${action-target}`), the process variables of the position being run, and the chat variables. The preview resolves the edited text at the current position. **Default** puts the built-in template back; an empty template queues nothing. The built-in template ends, before `${action-after}`, with a *Work you queue* section: the queue items and todos the agent queues may name a `role` and `guidelines` ([Aspect guidelines](#aspect-guidelines)), named to give secondary work — a review, a fix in another area, research, a task for another quest — the role and guideline aspects it needs, and left out when the work should run like the step. A template you edited and stored keeps its own text: **Default** brings the section in.
- **State per quest** — the position is stored in `_ai/quests/<quest>/process-state.<quest>.yaml`, so it is the same in every window and on every machine, and switching the quest switches it. Moving to a step that names a role also sets the `role` chat variable; choosing *— none —* as the process clears the process variables and sets `role` back to `default`. The Chat Variables view lists the process variables read-only under *Process*; a long description is shortened, and hovering it opens a scrollable popup with the whole text.
- **Runs** — a quest may hold several process positions, *runs* (another change worked on in parallel, or another process in the same window), each in `process-state.<quest>.<run>.yaml`; the quest's own file is the run `default`, always there. **`default` runs no process**: a process runs in a run of its own, so the PROCESS view shows *default — create a new run to run a process* there with a **New run** button, and starting a process on `default` is refused — the view's process select, `tomAi_setProcessState`, a follow-up process, a subprocess or branch. A process a quest still followed on `default` is moved by the `_ai` format migration (format version 9, `npm run migrate:ai-formats -- --apply`) into a run named after the process, with the chat variables it uses, its named sessions (`idea` becomes `idea@idea_to_todos`, the conversation going on) and its staged and pending queue items; a window that worked on `default` then works on that run, and the decisions journal records the move. Until the migration ran, such a `default` shows a notice, and Reset Run clears it. A window works on one run at a time; the PROCESS view, the process chat variables and the agents' process tools follow it. Each run has its own conversations: a session the process names (`work`) is the run's own in a run other than `default` — `work@chg1` — and so are the items its Proceed queues; the SESSIONS view lists a run's sessions under the run (`@chg1`), and deleting runs asks whether their sessions go too. Each run has its own custom chat variables — its run parameters, such as `design` or `change`: selecting a run switches what `${custom.design}` reads, a Proceed of a run reads its run's even while the window works on another, and a deleted run's variables go with it. The **Runs** list at the top of the PROCESS view shows every run of the quest, the last changed first (agents' moves and other windows' included), with its process, position and change time, the window's run marked: a click works on another run, **+** asks for a name (letters, digits, `_`, `-`) and a process (or none yet) and creates the run as the window's run, the trash asks which runs to delete (`default` is never offered) and confirms. Two more buttons reset the window's run, after a confirmation naming what goes (the reset is written to the quest's decisions journal): **Reset Process** (restart icon) puts the run back to the first position of its process and clears only the chat variables the process declares as its run parameters (`runParameters:` in the definition, the process editor's **Run parameters** field); **Reset Run** (discard icon) clears everything process-related — the run follows no process afterwards (`default` too), every level of its process stack and its open process-move markers go (the step's prompts stay in the queue), and every custom chat variable of the run is cleared. Each run names what it works on in its `process-subject` chat variable — a short title such as *Revision of tom_specs* or *Change chg3 on tom_uam*, set by the process's first step (a process that sets it lists it in its run parameters, so Reset Process clears it): the **Runs** list shows it beside the run's name, the PROCESS view shows it as *Working on* under the process (*not named yet* while a process that declares it has none), and the @CHAT subpanels' *Run* selects, the Proceed page and the system prompt's process context name it too. Agents reset a run with `tomAi_resetProcess` (`mode` `run` or `process`). Agents create, list, select and delete runs with `tomAi_createProcessRun`, `tomAi_listProcessRuns`, `tomAi_selectProcessRun` and `tomAi_deleteProcessRuns`; a Proceed moves the run it was started in, also after the window switched to another.
- **Processes written by an agent** — an agent can create a process: `tomAi_validateProcess` checks its draft (the schema, the editor's rules, the roles), `tomAi_writeProcess` writes `<id>.process.yaml` and `<id>.md` when the draft is valid (an existing process only with `replace`, after your approval; the file then changes only where the definition did, so the revision diffs cleanly) and opens it in the process editor for you to look at.
- **Moves offered in a question** — an agent asking you something can put buttons into the question (`choices` on `tomAi_askUser` and on the Agent SDK's question tool): a plain answer, or a move of the quest's process to a position of the current process. Clicking a move button makes the move at once, exactly as the PROCESS view would, and tells the agent where the process is now; the decision is your click, not the agent's reading of an answer. Branches and subprocesses can be offered only when the current step lists them; clicking one asks what the step does when it ends and then starts it, as the PROCESS view does (the depth confirmation, the inputs its entry fills) — the agent is told what started, or why nothing did (the step moved on since, you cancelled).
- **In the system prompt** — every Anthropic profile includes a *Current process* section while a process is set: the positions, the steps of the phase, the post-gate todos and the descriptions. The values are also chat variables (`process`, `phase`, `step`, `substep`, `phase-iteration`, `step-iteration`, `substep-iteration`, `process-description`, `phase-description`, `step-description`, `substep-description`, `phase-prompt`, `step-prompt`, `substep-prompt`, `session`) and placeholders (`${process-context}` for the whole block). The agent moves the state with `tomAi_setProcessState`.

### @TOM VSC: resource-hungry extensions

The **@TOM VSC** sidebar's RESOURCES view lists the helper processes of this window's extension host (language servers, analysers, git, …) grouped by the extension that started them, with memory, CPU and age; a group opens to its processes. **Pause** stops a process or all of an extension's (SIGSTOP: no CPU, its idle memory is left to the system, the extension does not notice) — its editor features wait until you **Resume** it; **Kill** (asked first) ends a hung one, which its extension may start again. Windows offers Kill only. **Profiles**: switch to a lean VS Code profile (its own set of enabled extensions — the supported way to turn extensions off), create one from the current profile, or open the profiles editor. **Settings (this workspace)**: toggles for Dart analysis, Git's repository scan and the watcher / search excludes of `ztmp/`, `build/`, `.dart_tool/`, `node_modules/`. The view refreshes every 5 s while visible; the status-bar item with the window's total (refreshed every 30 s) opens it.

### @TOM VSC: prerequisites and secrets

A `prerequisites.yaml` at a project's root (or at a repository root, for every project of the repository) lists what the project needs that is not in its repository: the **secrets** it reads, each with its type, whether it is required, what it is for, how to get it, and the ways to provide it (an environment variable, a `.env` key, a file, the OS keychain, VS Code's secret storage, a KDBX entry, a tool's own login, ssh-agent, a cloud secret manager); and the **software** it expects on the PATH. It never holds a value. The format is in `_agent_guidelines/prerequisites_yaml.md`; the YAML editor checks the file against the extension's schema.

The **PREREQUISITES** view of the **@TOM VSC** sidebar lists every such file of the workspace as a tree — repository, project, section, secret or tool, way to provide it — each level with ✓ (every required item available), ✗ (one missing) or ? (not known) and the count of required items available. Optional items are counted but never turn a level red.

- **Check now** (before the first check) and then **Refresh** run the checks: presence only, never a value. An environment variable and a tool get two marks — VS Code's environment and an interactive login shell (what a terminal has) — so you see whether it works in VS Code and in a terminal. A file readable by the group or others gets a warning; `kdbx`, cloud secret managers and `other` are ? unless the file gives a `check` command. Every program a check runs has a timeout and runs one check at a time.
- The results and the time of the last check (shown at the top, with how long it took) are kept per VS Code installation: another window shows them at once, without checking again. Which nodes are open and the filters are kept the same way.
- A click on a name shows its details: what it is for, how to get it, the option's fields, and the check's result with its time. The file button opens the `prerequisites.yaml` at that entry; the pencil opens the file.
- **missing only** / **required only** narrow the tree.
- **Projects without prerequisites.yaml** (closed at first) lists the other projects of the workspace listing; **Create** writes a starting file there and opens it. The view re-reads a file when it changes.

### Window Status Panel

The Window Status panel is an Explorer sidebar view showing the state of all open @Tom windows:

- **Multi-window overview**: One card per open window displaying workspace name and active quest
- **Subsystem status**: Per-subsystem indicators (Queue, Anthropic, Copilot) with color coding:
  - **Orange**: Prompt sent, awaiting answer
  - **Green**: Answer received
- **Relative timestamps**: Shows how long ago each state change occurred
- **Servers**: behind the indicators, the servers the window runs with their ports, e.g. `CLI :19901 · MCP :19921`
- **Heartbeat**: every window rewrites its heartbeat (time, process id, servers) every 30 seconds; a window whose heartbeat is older than 90 seconds is shown dimmed and marked *gone*. A window of an older build writes no heartbeat and is not judged.
- **What each window is doing**: with every heartbeat, and about a second after it changes, a window also writes its host, role, process position, the ANTHROPIC/LLM panel's profile and session, and a queue summary (auto-send, paused, items per status, the defaults, the item being sent). An agent or MCP client reads all of it, with each quest's sessions and the Anthropic profiles, through `tomAi_getQuestWindowStatus` — the lookup before `tomAi_sendItemToQuest`.
- **Reload needed**: a window that runs an older build of the extension than the one installed is marked *reload needed*; the tooltip names both builds. Reload that window to run the installed build.
- **Auto-refresh**: File watcher on `_ai/local/*.window-state.json` with periodic refresh every 15 seconds, only while the view is visible
- **Cleanup**: Delete button to remove stale window entries

#### Which build a window runs

A window loads the extension once, when it starts; a build installed later reaches it only after a reload. Every compile writes `out/build-info.json` (commit, uncommitted changes, build time), and each window compares the build it runs with the installed one every 30 seconds and whenever it gains focus. When a newer build is installed, the status bar shows **Reload: newer Tom AI build** (click it to reload the window), the Status Page shows an **Extension build** section with a **Reload window** button, and the WINDOW STATUS view marks the window. Nothing reloads by itself: a reload ends a queue send that is running. Agents read the same through `tomAi_getWorkspaceInfo` (`build`) and `tomAi_getQuestWindowStatus` (`build` per window).

The @TOM sidebar holds the quest's views (Process, Quest Notes, Quest Todos, Sessions, Session Todos); @TOM WS the workspace's (VS Code Notes, Workspace Notes, Workspace Todos, TODO Log, Window Status).

#### Notes views

VS CODE NOTES (`~/.tom/notes/global_notes.md`), WORKSPACE NOTES (a notes file you pick or create) and QUEST NOTES (`quest-notes.<quest>.md`) each edit one Markdown file and save as you type. Their toolbar: 👁️ **Preview Markdown**, 📄 **Open in Editor**, 📖 **Open in MD Browser** (the file in the Markdown Browser) and ↗️ **Open in MD Viewer** (the file in the external Markdown application the workspace config maps to `.md` files in `externalApplications.mappings`; without such a mapping it warns that none is configured); VS CODE NOTES also has 📋 **Copy** and 🗑️ **Clear**, WORKSPACE NOTES 📁 **Change file**. To send notes to a model, use the @CHAT panels.

#### @TOM INFO: the quest notes, the runs and the notifications

The **@TOM INFO** sidebar (its own Activity Bar icon, beside @TOM, @TOM WS and @TOM VSC; `@T: Focus @TOM INFO Sidebar`) holds three views. **QUEST NOTES — <quest>** is on the active quest's notes file (`quest-notes.<quest>.md`, the same file as the @TOM QUEST NOTES view). Drag the icon into the secondary side bar to keep the notes open beside the editor. Two tabs on top, the last one used kept for the window:

- **Edit** — a text area on the file (monospace, the panel's full height), saved half a second after you stop typing and when you leave it; `/` and `@` completion as in the other notes. A change made elsewhere (an editor, a reconcile) is taken in at once; while you have unsaved text, a bar asks instead: **Load the file** (your text is replaced) or **Keep my text** (written over the file).
- **View** — the file rendered as the MD Browser renders it: headings with folding (fold all, fold one level, the +/− beside a heading), search, links (another Markdown file opens in the MD Browser, a file at a line in an editor), comments and questions shown read-only. It follows the file.

The bar's 📖 opens the notes in the MD Browser, the file icon in an editor for more space. With no quest open the view says so.

**RUNS** — below the notes, every process run of every VS Code window on this machine, grouped by window (its quest; this window on top; a window that has not written its heartbeat for 90 s is shown as gone, and left out 10 minutes after its last one). One line per run: its name, its subject (the run's `process-subject`), its process › position, and a badge with its state and what it waits for:

- **waiting for user** — a question, approval, plan, picker or MD Browser ask of the run is open (its title), or an item is held on its todo's open decisions;
- **waiting for event** — its turn waits in tomAi_waitFor (the reason and until when);
- **waiting on task** — its turn waits for its own background tasks or command streams (named);
- **running** — an item of the run is being sent, or pending items are about to be;
- **paused** — its auto-send is off (with the pending count);
- **idle** — nothing pending.

When several apply, the first of this list wins. Click a run of this window to work on it here (as selecting it in PROCESS › Runs does); click another window's run to see its details. Each window writes its runs with its heartbeat (every 30 s) and soon after a change, and the view follows those writes; agents read the same entries from `tomAi_getQuestWindowStatus` (`runs`).

**USER NOTIFICATIONS** — above NOTIFICATIONS: everything directed at you, from every window of this machine, kept apart from the busy event list. One row per event, never merged, newest first, each with an icon for its kind, the window (quest), the run, a title and the time:

- **an ask** waiting for you — a question (`tomAi_askUser`), a picker, an MD Browser ask, a plan proposal, a tool approval; shown **open** with how long it waits (bold), and **answered** once it is settled, with the answer or why it closed (timed out, cancelled, the prompt ended);
- **a message** an agent sent you (`tomAi_notifyUser`), with its urgency and channel;
- **an answer** an agent gave you (`tomAi_answerUser`): click the row to open it in the Answers page;
- **suggested processes** (`tomAi_suggestSubprocess`: the process branching editor waits for you);
- **a process decision** waiting: a run arrived where the PROCESS view offers **Decide…**;
- **a todo waiting for your decisions**: filed as `decision-needed` or changed to it, by any window (whatever build it runs: the row comes from the todo's own events) — **open** until the todo leaves `decision-needed`, then **decided** with its new status;
- **a todo for you to do**: filed as your action (`user_action`), or changed to one;
- **the queue holding for you**: an item in `decision-needed`, in `error` or needing attention, and a run paused because of one.

Click a row for its details (the questions and their choices, the picker's items, the document, the plan, the message, the answer). Clicking an open ask of this window also opens it where it is answered — the user-input panel on its run, or its MD Browser.

**Answer** (on an open row) answers from wherever you are:

- an ask of this window opens where it waits;
- an ask of **another window** is shown in this window's user-input panel, on a tab named after that window and its run; your answer goes to that window, which settles the ask there (an MD Browser ask is answered in its own window, where its document is open);
- a todo waiting for decisions opens in the bottom panel's **Quest TODO** section (@WS), switched to the todo's quest. The section stays where you leave it; the sidebar's QUEST TODOS keeps its own view.

**Continue queue** appears on a decided todo whose decisions held a queue item: it switches that run's auto-send on again, in the window whose queue it is. **Dismiss** (×, on hover) hides a row here only, and the bar's **Dismiss answered** hides every answered ask and notice; the rows stay in NOTIFICATIONS. The dismissed rows are one list for every window of the machine. The view's badge counts the open asks.

**Answers** — when a prompt asks for work and also asks questions, the agent hands each answer over with `tomAi_answerUser` instead of writing it into its reply, where the items that run afterwards would bury it. The Answers page (`@T: Answers`; Extension Tools; a click on an answer's row in USER NOTIFICATIONS) opens beside your work when one arrives, without taking the focus. On the left the answers, newest first, unread ones bold, each with its time, quest and run; on the right the selected one: your question, the answer, and what the agent suggests —

- **Suggested todos**: **Show record** shows the todo exactly as it would be written, **Add todo** writes it into its quest's todo file, filed by the agent that answered. An added todo shows its id and cannot be added twice. Nothing is created until you add it.
- **Suggested prompts**: **Copy** puts the prompt on the clipboard; you queue it from the quest's chat panel. Nothing is queued for you.

An answer is read once it is in view in the focused page; **Mark as unread** keeps it unread until you select another. Answers are kept until you delete them: the answer's own trash button, **Delete read**, or **Delete all** (asks first). They are stored on this machine, per `_ai` folder, outside git — every window whose quests share the `_ai` folder shows the same answers; another machine does not. Past 500 answers the window offers to delete the 100 or 200 oldest, or those older than 7 or 30 days.

**NOTIFICATIONS** — the last section: what agents, you and the extension do across the VS Code windows of this machine. Five kinds of event on queues and todos: an item **queued** or **deleted** (a queue item of any run), a todo **created**, a todo **edited** (fields or text) and a todo's **status** changed; and the kinds USER NOTIFICATIONS shows — asks and their answers, messages, suggestions, decisions, todos for you, the queue holding —, each with its own toggle. One line per event — its time, an icon for the kind, a short text (*todo vscimpb121 → completed · vscode_extension*). Events of one kind from the same agent (or from you) in the same quest within 60 seconds are merged into one line (*5 todos created by default@another · vscode_extension*). Hover a line for its details, click it to keep them open: who did it — an agent with its transport, profile and session and the queue item and todo it was working on, you (the UI), or the extension on its own (a timed request, a reminder, a done notification, *blocked todos follow their blockers*) —, the window and run, the fields changed (old → new) and the members of a merged line.

The bar on top: one toggle per kind; the window button lists the windows the events come from (tick one or several; none ticked shows every window); **Clear** hides the events there are now (in this window only — the log stays; a history button shows them again). The filters are kept per window. Every window writes its events into one log for the machine (the extension's global storage, the last 1000 events), and every NOTIFICATIONS view shows it as it changes.

#### @TOM TODO: the todo panel on its own

The **@TOM TODO** sidebar (its own Activity Bar icon; `@T: Focus @TOM TODO`) holds one view, **TODO**: the todo panel (see [Quest TODO Panel](#quest-todo-panel)) taking the whole side area. It is a panel of its own — its quest scope, file toggles, order, prefix, sort and filters are kept apart from QUEST TODOS' and the @WS section's — and it starts across quests: on **the open windows' quests**, with the **quest prefix** in front of every id. In a window without an active quest it starts on **all quests**. Change any of it with the panel's own controls; the panel keeps your choices.

### Upgrading the workspace (the `_ai` format migration)

A newer Tom AI build may store some `_ai` files differently. The files carry their format version: `_ai/format-version.yaml` for the shared files and `_ai/local/format-version.<host>.yaml` for this machine's own files (the queue, chat variables, sessions — not versioned). When a window starts and either is older than its build, **Tom AI does not start**: every panel and view shows *This workspace is in _ai format version X; this Tom AI build needs version Y. Tom AI does not start until the workspace is upgraded.* with a button **Upgrade the workspace…**, and the page **Upgrade the workspace** opens by itself; **@T: Migrate _ai Formats** opens it any time. After **Migrate now** the page and the panels ask for a reload, and the reloaded window starts normally. This works on any machine with the VSIX installed: no checkout of the extension and no Node are needed.

- **The page** shows the version the files are in and the one the build expects, a dry run of what changes (per quest and step; **Open the report in the MD Browser** shows it in full), and the other windows of this machine. **Migrate now** is enabled once you tick *I understand it cannot be undone*.
- **It cannot be undone**: an older build cannot read the migrated files. Everyone who shares the workspace — your other machines, and anyone syncing the same `_ai` — must upgrade Tom AI to this build too.
- **One at a time**: while one window migrates, another says *Migration is already running in another window*; one opened afterwards says the migration has been done already.
- **The other windows**: once the files are migrated, every other window of the workspace pauses the auto-send of all its runs and brings the **Reload required** page to the front (over the Prompt Queue editor when it is open): *The workspace has been migrated to version X, a reload is required. All runs have been paused. Let the currently running prompts finish, then reload.* Below it, one list of the prompts of every run of that window that were still running — status and kind as in the prompt queue (SENDING TODO (PAUSED), SENDING CHAT, …), run, session, prompt — each with **Interrupt** (a queue item is interrupted for continuation: its resend after the reload goes on in the conversation it ran in; a chat send is cancelled). The status follows the queue: SENT … once an item is done, PAUSED … when an iteration item finished its iteration, PENDING … (PAUSED) once it is back in the queue. **Reload window** says *Nothing runs any more* when the list is done. Closed, the page comes back from the status-bar item *Reload: workspace migrated*. Meanwhile every panel and view of that window shows only *The workspace has been migrated to version X; reload this window.* with **Reload window** and **Show running prompts** (the page), and a new chat send — from a panel, the editor's Send commands, a script, Send to Copilot, the todo panel or Telegram — is refused with that sentence; a send already running finishes and is listed on the page.
- **Another machine**: after a reconcile brings migrated files to another machine, its window opens the page for that machine's own files (its own stamp is still behind). When those have nothing in an older form, the stamp is written without asking.
- **Newer files**: when the files are newer than the build, Tom AI does not start either: the panels name the format version the files are in and ask to install a Tom AI build that knows it, then reload. There is no migration button: a migration never goes back.
- **Merges**: files a session already has are merged with the extension's own `_ai` merge drivers — no git and no registered driver needed. A file a driver cannot read (an unterminated history block, broken YAML) is reported as a problem; the stamp is not written until it is solved.
- **Merge drivers for git**: when a pull or a reconcile brings two copies of an `_ai` file together, git merges it with the driver `_ai/.gitattributes` names — `ai-trail` (live trails), `ai-history-json` / `ai-history-md` (session histories), `ai-block-history` (compacted histories), `ai-yaml-smart` (todo files, memory, extension configs). The extension carries all five (`out/utils/aiMergeDriverCli.js`, run by VS Code's own Node). The page's **The _ai merge drivers** section shows, per driver, whether git uses the extension's (*this extension's*), an older install's (*to update*), another tool's (e.g. the Python drivers of the al_the_bear skills) or none, and whether `.gitattributes` binds it; **Register the extension's drivers for this repository** (the `_ai` repository's own git config) or **for all repositories (global)** registers them and adds the missing rules to `_ai/.gitattributes`. A window that starts while a driver still points to an older install (VS Code or the extension moved) offers **Update the merge drivers**.

In a checkout of the extension the same migration runs as `npm run migrate:ai-formats -- --apply`.

### Issues Panel

The @WS **Issues** section lists the issues of the repositories it finds in the workspace's git remotes, plus the ones the panel configuration adds (`issuePanels`; **Tests** works the same for test reports). The repository dropdown offers one repository, **All Repos**, or **My Repos (`<account>`)**: the repositories of the GitHub account VS Code is signed in with, without forks and without clones of other people's repositories. The choice appears once the account's repositories are known (it asks GitHub whether each is a fork) and only when an account is signed in. New issues need one repository chosen.

The table's **Repo** column, right of the comment count, names the repository each issue is from as `<repo-name>/<owner>` (`tom_vscode/al-the-bear`), so the name comes first; it sorts like the other columns.

### Quest TODO Panel

The Quest TODO panel (the @TOM QUEST TODOS view, the `@WS` Quest TODO section, the @TOM TODO sidebar, and the editor that opens for any `*.todo.yaml` file) manages quest todos with status tracking.

#### Quests and files shown

The quest todo views (@TOM QUEST TODOS, @WS › Quest TODO, @TOM TODO) are todo managers across quests. QUEST TODOS and the @WS section start on their own quest — the window's — and look and work as always until another quest is added; @TOM TODO starts on the workspace's quests (see *AI workspaces* below). Their top bar has:

- **Quest scope** — the button with the library icon, showing the quest (or *Workspace quests (n)* / *Open windows (n)* / *All quests (n)*). A click opens a picker: the **workspace quests** (the quests this workspace lists, every quest without a list), the **open windows' quests** (the windows on this machine with a live heartbeat, this window's first), **all quests** — then a second picker with a checkbox per quest chooses which to see — or **one quest** (any quest folder, each with its short description). The scope is kept per view, in this window.
- **Which files** — three toggle icons: **live todos** (the checklist, on by default), **archived todos** (the box) and **deleted todos** (the bin): the `-archived` / `-deleted` siblings. An archived or deleted todo is shown greyed, marked *archived* / *deleted*, and read-only — in its detail every field is disabled — with one action, **↩️ Restore**: it goes back into the live file it came from, without its archive stamp. Restore is refused when the live file already holds a todo with that id.
- **Order** (shown when more than one quest is in the list) — **Groups of all quests** (the prefix groups and group todos of every quest shown in one list, without a quest level; a group is always one quest's, so a prefix two quests use appears once per quest, with the quest in front of the prefix while the quest prefix toggle is on), **By quest, then groups** (each quest a collapsible level, its prefix groups and group todos under it), **By quest, then list** (each quest's todos as a list).
- **Quest prefix** — a toggle that shows the quest in front of every todo id (`vscode_extension/vscimpb137_…`). Off by default with one quest, on by default with several and in @TOM TODO; once you set it, the view keeps your choice.
- **Search** — the search field narrows the list to the todos whose id, title or file name holds the text, as you type. While it holds text an **×** at its right end clears it: the whole list is back and the cursor stays in the field.

Everything else works across quests: details, editing, status changes, stacking, Send and Queue each act on the todo's own quest and file. Groups are quest-aware in every order: a prefix group's walk (🔁), rename (✏️) and move button act in the group's own quest, a group todo's members are todos of its own quest, and its queue buttons queue it for that quest. The view reloads when any quest's todo files change.

The right end of its top bar holds what the panel's sends use: the **Done notification** toggle (a bell icon, pressed while it is on, off by default and disabled while no done-notification template is set; the tooltip says what it does and whether it is on; what it does: *The todo done notification* below), the **template button**, the **Next** and **Fresh** toggles (*Where a todo is queued and sent* below) and **Save to Queue** / **Send**. The template button shows the selected template's name (at most 20 characters, the full name in its tooltip); a click opens a picker with the templates on offer (the queue's transport decides which), and the pick is used by Save to Queue and Send. **Run default (<template>)** comes first and is selected whenever the panel opens: a queued item gets no template of its own and takes its run's template when it is sent; Send takes the template of the run it sends in.

#### Prefix groups

The list is grouped by **todo-id prefix** — the characters before the id's number, so `qr1-…` and `qr3-…` share the group `qr`. A group's name may start with a number, which then belongs to the prefix and orders the groups: `001_cleanup1` and `001_cleanup2` are todos 1 and 2 of the group `001_cleanup`. Ids with no number after their prefix (`cleanup`, `001_cleanup`) or made of digits only collect in a group called **Unprefixed**, which always sits last. The groups are in natural order of their prefix (`001_cleanup` before `002_…` before `qr`), whatever the list's sort, so every group is always in the same place; the filter decides which todos show. Inside a group the todos follow the **Sort** picker: by **id** in the order of their number (`qr2` before `qr10`) when no field is chosen, or by the fields you pick (id, quest, status, priority, title, dates), ties by id. The picker's **Group by prefix** checkbox (on by default) turns the grouping off: the list is then one plain list in that order. Reset turns grouping back on. Each group is headed by a thin separator line showing the prefix, the number of todos in brackets, and a triangle that expands or collapses the group.

The list opens **fully collapsed** — after a window reload or a VS Code restart you see only the separator lines. Expand the groups you need; the **Expand all** toolbar button opens every group and **Collapse all** closes them again. Expanding a group sticks for the rest of the session, including across todo refreshes.

#### Todo groups (🗂️)

A **group todo** (status `group`) is a todo that stands for a group of others, listed in its **Members** (`comprised_of`; members of another quest are written `<quest>/<id>`). It is not work itself: a `prefix*` walk passes it, and it completes by itself once every member is completed or cancelled (it goes back to `group` when a member is reopened).

In the list, each group todo heads its own section above the prefix groups, sorted by title: a header of two lines, like a todo's row: the arrow, 🗂️ (✅ once completed), the group's title, its member count in brackets and its progress (*done / all*, counted over every member); below, its priority dot and its id. The arrow on the left expands or collapses the members, like a prefix group (collapsed at first; **Expand all** / **Collapse all** include the todo groups). The members follow in the group's order: a member of this quest is its usual row — so a todo in a group and a prefix group appears in both —, a member of another quest is a line with its `quest/id`, title and status, and a member that is archived is marked so. A click on the header (anywhere but the arrow) opens the group todo's details, as a click on its own row does.

The group's header and its detail view have a queue button (⏵): it queues the group as a GROUP item (see *TODO and GROUP items* under the Prompt Queue) where you pick (see *Where a todo is queued and sent* below); the ⏩ button on a tile queues a group todo as a GROUP item the same way, and an individual todo as the detail's **Queue** button does: a normal prompt with the todo in the Todo buttons template, the todo's id on the item.

The detail view of a group shows its **Members** with their progress: each member a badge with its status, ◀ ▶ to change the order, × to remove it, ➕ to add members from this quest, another quest or the workspace. Set a todo's status to `group` to give it the Members row. A todo that belongs to groups shows them as 🗂️ chips on its row and under **Part of** in its details (read-only — edit Members on the group); a click on a chip goes to the group. The move button on a todo's row (not on a group todo) offers **Move to a group todo…** while the quest has group todos: pick one, and the todo (or every stacked todo) becomes its member, at the end, and leaves the group todos it was in. A prefix group's move button offers it too: every todo of the group, the completed ones included, becomes a member. That button also offers **Move to a new group todo…**: it asks the new todo's id, appends the date code (`<id>_<code>`, e.g. `grp1_akrs`), refuses an id the quest already has, creates the group todo with the group's todos as its members and opens its details, where the remaining fields are filled in. The todo itself stays where it is: its file, its id and its prefix group.

#### Your own todos (👤)

A todo marked `user_action: true` is yours to do — a review, an answer, a look at a screen. Its title is **purple** in every todo list and it carries 👤. (A row's left border shows its status, not this mark: **blue** for in progress, **yellow** for blocked.) The **👤 toolbar button** shows only those todos and opens every prefix group, so none hides in a collapsed one; press it again to see all todos. The filter (funnel button) has a **User action** section for the same choice: your own todos, the others, or (nothing ticked) both. Set the mark with the *Your to do* checkbox when you create the todo (the new-todo form) or later in its detail form, where you can also clear it.

#### Queued todos (⏵#N)

A todo the prompt queue will run carries **⏵#N**: N is the number the Prompt Queue editor shows the queue item with in its run's tab (each run tab numbers its items from #1 at the top). An item of another run than `default` is named with its run: **⏵chg1 #2**, and `#2 (run chg1)` in the tooltip; a run name longer than 15 characters is cut with … (the tooltip names it in full), and a prefix group's header keeps room for its prefix. The numbers follow the queue: when an item finishes and the ones behind it move up, the marks change with them (a view hidden at the time catches up when it is next used or the queue changes again). Hover over it to see every queue item that will run the todo — `Queued: #2` or `Queued: #2 (first), #5`. A prefix group's header carries the mark too when any of its todos is queued (the tooltip says how many), so a collapsed group still shows it. The marks follow the queue: when an item is added, finished or removed, the list updates.

A queue item knows its todos by its **todo id pattern**: the todo's id when you add one todo to the queue (*Add to queue*, the stack's *Queue each*, *Guide me* into the queue), `<prefix>*` for a todo-group walk, several separated by commas. The queue editor shows it on the item (*todos …*). An item marks its todos until it has finished; a walk marks its open todos (not completed or cancelled), only in the quest whose queue it is.

Work that has to wait for you — a check that can only run after you reload the window, say — is written as a 👤 todo for your part plus the work itself, `status: blocked` with `blocked_by` naming the 👤 todo. A `prefix*` queue walk passes the 👤 todo and holds at the blocked one (the item shows what it waits for); once you complete the 👤 todo and resume the run, the walk sends it.

#### Todos that block others (⛓️)

A todo's **Blocked By** names the todos it waits for. The other end is kept for you: each todo carries a **`blocking`** list — the todos whose Blocked By names it (by id in the same quest, as `quest/id` from another quest) — which every save keeps in step, whether it comes from the todo panel, a todo tool or a script. A todo that blocks at least one open todo shows **⛓️** next to its status icon; hover it to see which. Its detail form shows a read-only **Blocking** row whose entries open the blocked todo. To change the relation, edit Blocked By on the blocked todo; Blocking follows. The filter has a **Blocking** section: the todos that block open todos, the others, or (nothing ticked) both.

**Blocked todos follow their blockers.** Complete or cancel a todo — in the todo panel, the editor, through a tool, by archiving or in a queue walk — and every `blocked` todo in any quest that was waiting for it, and has nothing else open, becomes **not-started** (or **decision-needed** when it still has open decisions). Its `blocked_until` versions count too: they have to be on pub.dev. Set the done todo back to another status and the not-started / decision-needed todos waiting for it become **blocked** again; ones already in progress, done or waiting for a repeat are left as they are. Each change writes a line into the todo's notes (*unblocked by …* / *blocked again: … is …*). **A done blocker leaves the Blocked By lists**: when a todo is completed or cancelled, its entry is removed from every todo of every quest that names it, whatever that todo's status (*no longer blocked by … (done)*), so Blocked By shows only what still blocks; a todo reopened later blocks only the todos that still name it.

**Cleaning up the dependencies.** The toolbar's references button (**Clean up the todo dependencies**) checks the dependencies in one pass and puts them right. It asks first which todos: **the todos shown in the list** (after its filters and search), **the open windows' quests**, or **all quests**. For those todos:

- a **Blocked By** entry naming a todo that is done (completed or cancelled), or one that is no longer a live todo (archived, deleted or gone), is removed: a todo that no longer exists counts as completed. An entry naming an open todo stays, and so does one that names no todo (text, a bare quest name);
- a **blocked** todo whose Blocked By is emptied by this, and that waits for no package version (`blocked_until`), is no longer blocked: it becomes **not-started**, **group** for a group todo, or **decision-needed** when it holds an open decision. A blocked todo without any Blocked By is left as it is, since what it waits for is not written down where the cleanup can read it; the summary counts them;
- each todo's **`blocking`** list is set to what the other todos' Blocked By say.

Each todo whose Blocked By or status changed gets a line in its notes. While it runs the status bar shows **Checking todo dependencies n/m**; at the end a message says how many entries were removed, how many todos were unblocked and how many `blocking` lists were corrected, and the list loads again.

#### After done and Filed by

Todos hand work on to each other within this machine:

- **After done:** a completed todo sets others free, reports back and sends instructions.
- **The Done notification:** the panel's items report back when they finish.
- **Items sent to another quest:** they can be todo walks in a named run (see
  [Items from other quests](#items-from-other-quests)).

Claims on repositories, messages between machines and coordination servers
come later; until then, work in parallel by the rules of the workspace's
parallel-work guideline.

A todo can say what happens when it is completed (`on_done`), and records who filed it (`filed_by`). Both are in the detail form's **After done** group:

- **Targets**: the todos **unblock** sets free, comma-separated: a bare id in this todo's quest, `quest/id` for a todo of another quest.
- **Actions**:
  - **unblock**: when this todo is completed, each target is set free (below);
  - **notify filed-by**: the done notification goes to the quest and run in **Filed by** instead of the run that queued the todo.
- **Instructions**, with **Quest** and **Run**: a prompt sent when the todo is completed, to that quest and run. **(current quest)** and **(current run)** — the default, the same as leaving them unset — mean this todo's quest and the run it is completed in; for another quest the run defaults to its `default` run. The Run picker lists the chosen quest's process runs.
- **Notify prompt**: the done notification (below).
- **Report to**: where the result is recorded, a `path#section`.

A change is saved when you leave the field. With **unblock**, every target must exist in its quest; archived and deleted todos count. Otherwise the save is refused with a warning.

**Nothing is written into the targets while the todo is open.** **unblock** acts only when this todo is completed. A todo that has to wait for this one *and* its other conditions names this one in its own **Blocked By** instead: when this todo completes, its entry leaves that list (the standard behaviour of every completed todo, above), and the todo is set free once its last blocker is done. **Renaming** a target, or the todo that filed this one, rewrites the ids in After done and Filed by.

**When the todo is completed, the extension carries out After done itself.**

- **When it runs:**
  - in a queue walk, once the walk has written the todo's answer;
  - otherwise, when the todo is set to completed: from the todo panel, a tool or the editor;
  - for a group todo, when its last member is completed (the group completes with it) — not before;
  - for a repeated todo, on every completion.

  Saving a todo that is already completed runs nothing again. Cancelling a
  todo runs nothing of After done.
- **unblock:** each target is set to **group** when it is a group todo,
  else to **not-started** — **decision-needed** while it has an open
  decision — whatever else it waits for; its Blocked By stays as it is. Only a
  target that waits (blocked, not-started, decision-needed, group) changes: one
  in progress, waiting for its repetition, completed, cancelled or archived is
  passed over. A target that was deleted or no longer exists is passed over
  with a line in the todo's Notes.
- **Instructions:** sent as a prompt to the quest and run of After done, in
  that run's default session. The prompt names the completed todo, then the
  instructions (with the placeholders below filled), then the answer the todo
  was completed with.
- **Next in the queue:** the instructions and the done notification are
  both queued **next** in their run — at the front of its queue, and between
  the iterations of a repeating item that is sending. Another quest gets them
  through its inbox, queued next there too.

**The todo done notification** reports a completed todo back.

- **What it says:** the todo's **Notify prompt**. Without one, the **Todo —
  Done Notification** template of the Prompt Template Editor — but only when
  the todo panel that queued the todo had its **Done notification** box on,
  or with **notify filed-by**. There is no built-in text. Placeholders, filled
  from the todo as it is at completion:
  - `${todoId}`, `${todoTitle}`, `${todoFile}`, `${todoStatus}`;
  - `${itemOutcome}` (`completed`), `${itemAnswer}` and `${todoLastAnswer}`
    (the answer stored on the todo);
  - `${todoOnDone}`, `${filedBy}`, `${reportTo}`, `${senderQuest}`,
    `${senderRun}`.
- **Where it goes:** into the run and session that queued the todo. Each
  queue item records who queued it (`queuedBy`):
  - an agent queuing with `tomAi_addQueueItem` or `tomAi_sendItemToQuest`:
    its quest, run and session;
  - the todo panel: the run and session you queued the item into, and for
    Send and Guide me the chat send's own run and session;
  - nothing else records it.

  When nobody is recorded the notification is not sent; the item's own
  queue and run are never used in its place. With **notify filed-by** it goes
  to the quest and run in **Filed by** instead, in that run's default session;
  a todo without a Filed by quest then sends none. Whoever receives it records
  the result at Report to.
- **The box:** the **Done notification** toggle (bell icon) in front of the
  todo panel's template button. It is off by default, kept per quest, and
  disabled while no Todo — Done Notification template is set. It decides
  whether a todo the panel queued, and that has no Notify prompt of its own,
  sends the template.
- **Older queue items:** an item that still carries the done notification an
  older build added for its todo loses it when the queue reads it.

**Filed by**, below the group, is read-only. It holds:

- the quest of the window, or of the quest that asked for the todo when another quest's item filed it;
- the process run and the session;
- the todo whose queue walk filed it;
- the time.

The todo panel and the todo tools write it when a todo is filed. `_bin/check_todo_blocks.py` reports an **ON_DONE** finding when a target no longer exists, and when a todo still carries an action that no longer exists (`queue`, `none`; a todo file that has them reads them as nothing).

#### Filtering by date

The filter's **Date Ranges** rows — **Created**, **Updated** and **Completed** — each take a from and a to date, both inclusive, either one optional. A Completed range shows only todos whose `completed_date` lies inside it, so a todo that was never completed is hidden while a Completed bound is set.

#### Moving todos between files

Four top-bar buttons move todos between files instead of destroying them:

- **Archive completed todo** — moves the selected *completed* todo to the file's `-archived` sibling (e.g. `todos.myquest.todo.yaml` → `todos-archived.myquest.todo.yaml`), stamping it with the archive date. Enabled only for completed todos.
- **Archive all completed** — bulk-archives every completed todo in the current file.
- **Delete todo (to file)** — moves the selected *non-completed* todo to the `-deleted` sibling, stamping the deletion date. Completed todos can only be archived, not deleted.
- **Delete all cancelled** — bulk-moves every cancelled todo to the `-deleted` sibling.

Archived/deleted sibling files are **terminal**: they can be viewed but never archived or deleted *from*, and the buttons hide when browsing them. A todo moved to the `-deleted` file remains recoverable (unlike the per-row hard-delete). There is no separate backup file mechanism anymore.

Archiving a **completed** todo also **copies** any decisions it carried into the quest's `decisions.<quest>.md` journal (@WS → Documentation → Decisions), stamped with the todo id and the archive timestamp. It is a copy, not a move — the archived todo keeps its decisions. Two cases are deliberately left out: deleting never journals (a deleted todo's decisions were never acted on), and neither does archiving a todo that has not reached `completed` — the Archive button works on any status, and a todo archived half-done was abandoned rather than concluded.

A further set of top-bar buttons changes a todo **without** moving it to a terminal file:

- **Rename a todo** — the ✎ button beside the **ID** field in a todo's detail opens VS Code's input box with the id; enter the new one. It refuses, in the box as you type, an empty id, a space, a path character, an id the todo schema's id pattern refuses (the message names the rule, read from `_ai/schemas/yaml/todo.schema.json`) and an id the quest already has (archived and deleted todos count). The todo keeps every field and its place, its notes say which id it had, and every `blocked_by` / `dependencies` entry naming it follows — in the quest's todo files, and as `<quest>/<id>` in other quests'; the old id stays as a cancelled stub naming the new one in the `-deleted` file beside it (the `_ai` commit guard refuses an id that vanishes) — when it was committed; an id that never was needs none and gets none; a prompt already in the queue keeps the old id in its text. Quest todos only (not session or workspace todos). Moving todos into another group renames them the same way.
- **Mark selected todo completed** / **Mark selected todo cancelled** / **Mark selected todo not-started** — set the selected todo's status in place (the completed action also stamps the completion date). With a non-empty todo stack they act on the whole stack after a single confirmation.
- **Move to another group / quest / workspace / another quest** (the ⬆️ button on a todo's row) — asks where to move it: **Quest todos** (the todo's own quest file, offered when it is not already there), **Move to another group…** (see below), **Workspace todos** (`workspace.todo.yaml`), or **Move to quest…**, which opens a second picker listing every quest and moves the todo into that quest's `todos.<quest>.todo.yaml`. With more than one todo stacked it moves the whole stack; the picker then reads *Move N stacked todos to…* instead of *Move this todo to…*. Works in quest, session and workspace mode. A todo that leaves its quest gets `[moved from quest: <id>]` added to its notes; a todo whose id the target already holds is left where it is and reported.
  - **A whole group** — a group separator (the line naming a prefix, e.g. `annot`) has its own ⬆️ button: it moves every open todo of that group with the same pickers, as if they were stacked. Completed and cancelled todos stay; a group with none open has no button.
  - **Another group** — **Move to another group…** (offered when the todos all belong to one quest) moves them into another id group of that quest: a second picker lists the quest's groups that hold live todos, alphabetically (not the one the todos are all in, nor a group only archived or deleted todos hold), and **Enter a prefix…** to type a group by hand — a new one, or one of those not listed. The todos are added at the **end of the group**: numbered after the group's highest number **below 999** (archived and deleted todos count, so no id is taken twice) and placed after its last such todo, in the file that holds it. A todo numbered **999 or higher** (`<prefix>999`, …) is the group's **finalizer**: the moved todos go before it and it stays last. Each todo keeps the text after its number (`mov1_bb-x` → `fin3_bb-x`), its notes say which id it had, and every `blocked_by` / `dependencies` entry naming it in the quest follows the new id. A group with no free number below 999 is refused, and so are new ids the todo schema's id pattern refuses (also when numbered into another quest). The same finalizer rule holds when todos are numbered into a group of another quest (below).
- **Rename group…** (the ✏️ button on a group separator) — gives the group a new prefix in one step: an input box with the prefix; its line below previews the new ids (`ww3_akfd-x` → `xx3_akfd-x`) and refuses a prefix with a digit after its leading number, a space or a path character, one whose new ids the todo schema's id pattern refuses (the rule named), or one whose ids the quest already has. Every live todo of the group is renamed as by **Rename a todo** (references follow in this quest and others, a stub per committed old id); archived and deleted todos keep the old prefix. The message names the quest documents that still mention the old prefix — they are not rewritten. Agents do the same with `tomAi_renameTodoPrefix` (with `dryRun`). Quest todos only.
- **Queue Group Prompt** (the 🔁 button on a group separator) — queues a walk over the group, where you pick like every queue action of the panel (the confirmation names it: *… quest q1, run r2, session work@r2, at the end of the queue*): a queue item with the repeat count `<prefix>*` (see *Todo iteration* under the Prompt Queue) whose prompt you pick from a list: **Default**, **Default + `<addition>`** for each global addition and each of the quest's additions, and the quest's own prompts. To add text of your own for this walk only, pick a prompt with its ✎ button, or **Default + an addition I type…**: a panel shows the prompt and a multi-line box (Ctrl/Cmd+Enter queues, Escape cancels); what you type follows the prompt after a blank line and is not stored. The last entry opens the group prompt editor. A walk goes over the todos of the group's quest, so it is queued into that quest (another quest's through its window's inbox). When the group has nothing left to walk over, the item is queued in `ERROR` with the reason and you are told.
- **Group prompt editor** (`@T: Open Group Prompt Editor`, or the picker's last entry) — edits those prompts. **Global**: the **Default** (the built-in one until you save your own; *Use built-in* deletes yours; it asks the agent to do the todo, report it, and wait actively for anything it starts, since nothing can call back once it has answered and the next todo is sent) and **Additions**, appended to the default after a blank line. **Quest** (chosen at the top): an **own default** that replaces the global one for that quest, **Additions**, and **Prompts** sent instead of the default. The files are Markdown: `_ai/group_prompts/default.md` and `additions/<name>.md`; `_ai/quests/<quest>/group_prompts/default.md`, `additions/<name>.md` and `prompts/<name>.md`. A click on a variable inserts it at the cursor — `${repeatTodoId}`, `${repeatTodoTitle}` and `${repeatNumber}` are filled in for the todo each send of the walk works on; the preview shows what the walk sends with the selected entry, unsaved text included. Save writes every changed entry.
  - **Ids in the other quest** — when the todos enter a quest they are not in, a third picker asks how they are named there, once for all of them: number them into one of that quest's groups (those holding live todos, alphabetically, each with its count and the ids the moved todos would get — the group's prefix and consecutive numbers after its highest, each id keeping the text after its own number, e.g. `vscannot3_ajtf-tools` → `annot10_ajtf-tools`), **Enter a prefix…** to number them under a prefix of your own (a new group starts at 1; the input box previews the new ids and refuses a prefix with a digit, a space or a path character), or **Keep the ids as they are**. A renamed todo's notes say which id it had, and the `blocked_by` / `dependencies` among the moved todos follow the new ids.
- **Move selected to other todo file** — opens a quick pick of the quest's other `*.todo.yaml` files (including the `-archived` and `-deleted` siblings), plus a *New todo file…* option, and moves the selected todo (or the whole stack) into the chosen file. Available only in concrete quest mode. Clicking a todo in any of the quest's todo files loads its details, and the details pane refreshes automatically after a status change.

#### Decisions and the `decision-needed` status

A todo can carry a list of **decisions** — open questions that must be answered before the work can start. Each entry has three fields: a one-line **summary**, the **decision needed** (what exactly has to be decided, and the options), and the **decision** itself once made. In the details pane they render as a collapsible list: collapsed you see just the summary line, expanded all three fields.

A todo with unanswered decisions belongs in status **`decision-needed`** (❓), which sorts directly after `blocked` and ahead of `not-started`. It is a normal dropdown choice and the four quest-todo tools round-trip it, so the model can create a todo already in that state — the workspace rule is that a todo whose scope contains a user decision is created as `decision-needed` with the decisions filled in, rather than as `not-started`. A `prefix*` queue walk never runs it and holds when it is the next todo of the walk; the todos before it run first; see [Todo iteration](#todo-iteration-prefix). The todo views show it with a yellow **decision-needed** chip (its tooltip lists the open decisions, also beside the status in the detail), and a group header carries a yellow **❓** with the count of its todos with open decisions (the tooltip names them), so you see there is something to answer without a walk having to stop.

**Repeated todos** (🔁 in the list, the rule in its tooltip): a todo with a **Repeat** rule in its detail — by hand, N days / weeks / months after it is done, daily, weekly on chosen weekdays, monthly or yearly on a day, the last day, the nth weekday (*the second Tuesday*, *the last Friday*) or the first / last working day, at a time, until a date or for a number of times — is not completed when it is done: it goes to **waiting-for-repeat** (⏳), and its next repetition is computed (a calendar rule from its schedule, *after N …* from when it was done). The **Repeated todos** entry in the Timed Requests list (add it with its toolbar button; start / stop, interval, Check now) moves every due one back to **not-started**, also once when a window starts. ⏭️ **Repeat now** brings one back at once; a todo repeated by hand waits for that, and a `prefix*` queue walk runs it once per walk. Done for the last time (its count or end date reached), it is completed. The detail shows how often it was done and when it comes back.

**Target dates** (📅): a todo's **Due** field (in its detail's *Dates*, or `due` through the todo tools) is the date it should be done by. A dated row shows the date as a small chip; once the date has passed and the todo is neither completed nor cancelled it is **overdue** — the chip and the title turn **red** (on the date itself it is not overdue yet). The filter (funnel button) has an **Overdue** section: overdue todos, the others, or both. On the due date the todo gets **one reminder**, at 09:00 local time or the time set as `todoPanel.dueReminderTime` in the extension config (`HH:MM`), or at the first check after that: through the quest's Telegram where it is set up, else a VS Code message, naming the quest, the todo and the date. The check runs with the **Repeated todos** entry of the Timed Requests list, so that entry must be on; for now a window of the todo's quest sends it. The todo records it (`due_reminded`; the detail shows 🔔 with the time), so it goes out once across windows and hosts; setting another date gives the new date its own reminder. A completed or cancelled todo gets none.

**Reminders** (🔔 in the list, every reminder in its tooltip): besides the due date, a todo rings through two fields of its detail. A **🔔 Remind** schedule is a rule like Repeat's (without *by hand*): after N days / weeks / months, daily, weekly on chosen weekdays, monthly or yearly on a day, the last day, the nth weekday or the first / last working day, at a time, until a date or for a number of times. While the todo is open it rings at each moment the rule names; *after N …* counts from the reminder before, the first from when the rule was set. The detail shows how many reminders it sent and when the next one comes. **🔔 Reminders** are one-shot reminders: **at** a date and time, or a span (minutes, hours, days, weeks) **before the due date**, counted back from a time of day on that date (its start without one). Each rings once and is then marked *✓ rang*; a changed due date lets the ones before it ring again. Add one with ➕, remove one with 🗑️. Remind and Reminders are independent of Repeat, which brings a done todo back and does not ring. All of them go out like the due-date reminder (the quest's Telegram, else a VS Code message), checked by the **Repeated todos** entry of the Timed Requests list in a window of the todo's quest, and are recorded in the todo before they are sent (`next_remind`, `remind_count`, a reminder's `acknowledged`), so each rings once across windows and hosts. What one todo has due at a check — the due date, a Remind moment, Reminders — comes as **one** message naming every reason. Moments missed while no window ran ring once, then the schedule goes on with the next moment to come. Completed, cancelled and waiting-for-repeat todos ring nothing; when a repeated todo comes back, its Remind schedule starts again from then. The todo tools take `remind` and `reminders` too (`null` removes them).

**Session todos** (the Session Todos view and the panel's session mode) belong to **one session** of the quest: the steps an agent notes for itself while it carries out a quest todo, in the flow of that session. Each session keeps them in its own file, `_ai/quests/<quest>/history/sessions/<session>/session-todos.todo.yaml` (machine-local, not versioned), and they are **deleted with the session**. An agent's session todo goes to the session its prompt runs in. The view's **session switch** has a button for each of the most recent sessions that have todos (a dropdown with all of them when there are more), each with its open-todo count; what you add there goes to the session shown. The SESSIONS view shows each session's count (☑ n), and deleting a session with open todos says how many go with it. The former per-machine file is taken over once when a window starts: its open todos become the `default` session's.

#### Todo stack (batch send)

Each list row shows a small clickable circle **under its status icon**. Clicking it adds the todo to the **todo stack**; the circle then shows the todo's 1-based stack position. **Shift-click** (with at least one todo already stacked) adds every todo between the last picked one and the clicked one, in the current list order. Clicking a stacked circle again removes that todo and renumbers the rest. The **Clear todo stack** toolbar button empties the stack.

With a non-empty stack, the send buttons switch to batch mode:

- **Save to Queue** — adds **one prompt per stacked todo** to the prompt queue, in stack order, each embedded via the selected template (e.g. the Execute TODO template).
- **Send** (Copilot or Anthropic, following the queue's transport) — combines **all stacked todos into a single prompt**: one block per todo, get one numbered `REQUIRED: Add responseValue #TODO_<n>=…` line each, and the combined text is inserted into the selected template. With no template selected, the blocks (plus the response-value lines) are sent as-is.

Every send of a todo from the panel — Send, Save to Queue, single or stacked — carries the todo's whole record: its reference, then *Here is the complete YAML of the todo:* and the todo as stored (every field, decisions with their answers, notes, references; not `blocking`), the same block a todo walk appends. Execute TODO, Guide me through a user action and Explain TODO work from it, and so does any template of your own.

## 3) Sending prompts

**Extension Tools.** The tools button (🛠, `codicon-tools`) on the ANTHROPIC/LLM and Copilot subpanels opens the **Extension Tools** overlay: every editor, page and viewer of the extension, one button each, in the same four groups as the Status Page's Editors and pages overview (Prompts & templates, Queue & automation, Quest & process, Trails, logs & setup). It covers about 90% of the panel's width and lays the groups out in up to four columns as the width allows; a button's tooltip says what it is for. A button opens its editor or page (Telegram, Reminders, MCP server and Usage open the Status Page at that section) and closes the overlay; **Close**, Escape or a click beside it close it too. The window's quest, role, projects and todo are chat variables, set in the Chat Variables Editor.

**Ordering an editor's list.** Every editor with a list on the left — the template editor (profiles, user message, compaction, memory extraction, transport retry, interactive questions, assist prompts, reminders, timed requests), the queue template editor, the reusable prompt editor, the group prompt editor, the Role Editor (both tabs) and the process editor — has an **Up** and a **Down** button (↑ ↓) beside its add and delete buttons. They move the selected entry one place and are greyed out at the list's ends and while nothing is selected; text you have not saved yet stays as it is. Two kinds of list:

- **Entries kept in the configuration** (everything in the template editor): the entry moves in the configuration itself, so the pickers that offer these entries — the profile picker, the template pickers — show the new order too.
- **Entries that are files or folders** (queue templates, reusable prompts, group prompts, roles, role types, processes): the files stay as they are, and the order is stored in the configuration under `editorListOrder`, one list of ids per list. It is the order of the editor's list; an entry created later comes after the ones already placed. A reusable prompt folder has its own order per scope, the group prompts one per scope and kind (an entry moves among the entries of its own kind).

### Anthropic

The ANTHROPIC/LLM subpanel in `@CHAT` is the primary AI chat surface. Every turn picks a **profile** that bundles model + transport + history mode + user-message template.

The profiles are the workspace config's `anthropic.profiles` (`.tom/tom_vscode_extension.json`), edited in `@T: Open Prompt Template Editor`. Besides a few task profiles (read-only research, precise code edits, role + quest context) and the Local LLM profiles, the Anthropic models each come in three flavors:

- **Direct** — raw Anthropic SDK. History injected via `trim_and_summary` compaction. Memory placeholders (`${memory}`, `${memory-shared}`, `${memory-quest}`) expanded before send.
- **Agent SDK T&S** — routes through `@anthropic-ai/claude-agent-sdk` but still uses in-extension history compaction. Memory pulled via `tomAi_memory_*` tools on demand.
- **Agent SDK SDK-MM** — Agent SDK with SDK-managed continuity. The session id persists in a `<name>.session.json` in `_ai/quests/<quest>/history/` (gitignored; `chat` for the panel, `default@default` for the queue, or a named session) so the next turn resumes in place. Works with Claude Code's session selector.

Around the prompt: the profile picker with its edit button and the user-message template picker on the first row. The action row, all icon buttons, reads left to right: Preview, the **Keep** and **Fresh** toggles and the **queue mode** toggle; **Save to Queue** and **Queue next** — they queue into the **default run** with the prompt queue's settings (below); then the **session and run** — two lines of link text, the session above the run (the Copilot subpanel has the run only), each opening VS Code's picker on a click; then what uses them: **Send**, **Stop**, **Save to Queue with this panel's session, run, profile and template** and **Queue next with this panel's session and run**. The queue buttons are double icons: the second says where the item goes — the numbered list for the end of the queue, the arrow up in a circle for next — the first whose settings it takes: **+** the queue's, the person the panel's. Keep, Fresh and the queue mode are icon toggle buttons, pressed or not pressed, each with its tooltip; Tab reaches them and Enter or Space switches them.

- **No double sends**: **Send** and the four queue buttons (the Copilot panel's two too) are paused for 2 seconds after a click, and a queue add or send whose text, transport, profile and template equal one taken in the last 3 seconds is ignored — the status bar says *Already queued* / *Already sent*. The todo views (QUEST TODOS in the side bar, the @WS Quest TODO section) have the same guard on every way a todo goes out: the detail's **Send** / **Queue** and **Guide me**, the bar's **Save to Queue** and **Send** (one todo or the stack) and a group's 🔁 walk — a repeat of the same todo (or stack, or walk) the same way within 3 seconds is ignored, and the bar's buttons and the 🔁 are paused for 2 seconds.
- **One todo, one queue item**: a todo that is already in the prompt queue — an item with the same todo id (or the same `<prefix>*` walk) is staged, pending or sending — is not added again; a notice says so and offers **Queue again** for a deliberate repeat. Once that item has run (or failed), the todo can be queued again.
- **Queue mode** (the toggle before **Save to Queue**): pressed (▶, the default), both Save to Queue buttons add the prompt **pending**, so the queue sends it when it gets there; not pressed (⏸), they add it **staged**, so it waits in the queue until you send it from the queue editor. The tooltip names the mode. **Queue next** always adds pending. The Copilot subpanel has its own queue mode. Each is kept per subpanel, in the panel's state and with the drafts, so it holds over a window reload.
- **Keep** (pin icon) decides, for each prompt slot 1–9 on its own, whether the slot's text stays after **Send** or a queue add (pressed, the default) or is cleared. The toggle shows the active slot's setting; it is saved with the drafts, so it holds over a window reload. A queue add clears the slot only once the queue has taken the prompt.
- **Fresh** (sparkle icon, after Keep; not pressed by default, saved with the drafts) sends the prompt in a new one-prompt session based on the panel's session: it starts from that session's conversation and changes nothing in it. The session is deleted, its trail and history included, as soon as the answer is in, so it never shows in the session list and no follow-up prompt can reach it — the next Send with Fresh starts another one. A fresh session is never busy, so the send never waits for its base. The status line names it: *Fresh session (based on chat, discarded)*. The prompt and its answer stay in the prompt queue's CHAT SENT entry. The status bar holds the Chat Variables and Process editors, the prompt queue and queue templates, the Status Page, Recreate history / Recreate memory, Run Quest Refresh, `history.md`, the quest memory and the shared memory in the MD Browser, and a model list (read-only: the models the API returns; the profile's configuration decides the model). The live trail, the session's history, the raw and summary trails, the memory panel and clearing a session's history are in the @CHAT **Logs** section, behind its session switch (see [Logs Panel](#logs-panel)).

#### Named sessions

A conversation lives in a **session**: a `<name>.session.json` file in the quest's `history/` folder (machine-local, gitignored). On the Agent SDK transport with SDK-managed history it holds the SDK conversation the session continues; on the direct API transport the session has a history of its own (below). The panel uses its own session `chat`, the prompt queue the run's **default session** `default@<run>` — `default@default` in the default run (an older build named it `default`; a window moves it to the new name when it starts) — and any number of named sessions can be created and chosen. Every run has its default session from the moment it is created (based on `default@default`); switching the panel's **Run** select switches the panel to that run's default session, created when missing. The session button stays free to choose any other session afterwards.

- **The ANTHROPIC/LLM toolbar** (gsel6): the profile, user-prompt template, session, Run and role dropdowns have no labels and take 60% of their former width; each one's tooltip names it. The template dropdown's empty entry is **No template** (the Copilot subpanel's too).
- **Run default**: the profile, user-prompt template and session pickers and the Copilot template dropdown start with **Run default (<value>)**, naming the panel's run's default now. **Send** looks the run's default up when it sends; what the panel queues with its own target gets no profile, session or template of its own and takes its run's when it is sent — change the run's defaults (in its Prompt Queue tab) and everything queued that way follows. Switching the panel's **Run** select puts the session on Run default. The panel switched once to Run default for its templates and role, and for its session when that was the run's default session.
- **The role dropdown** (right of the session and run) is the role of the panel's sends: **Run default** (the step's role, the run's default role or the chat variable), or one of the roles of `_ai/roles/`. A send — and what the panel queues with its own target, or because the session is busy — runs as that role: its tools, its guideline choices and `${role}`, ahead of the process step's role and the chat variable `role`. The run's chat variable is not changed. The choice is kept per window and quest until you change it; a role deleted meanwhile puts it back on Run default. The Copilot subpanel has no role dropdown.
- **The guideline button** (book icon, after the role dropdown; in the Copilot subpanel after its run) sets the guideline choices of the panel's sends — their item level, kept until you change them (see [Aspect guidelines](#aspect-guidelines)). It shows only a dot when the panel chose something and the effective selection on hover; no list beside it. What the panel queues with its own target carries the choices as the item's own.
- **The role editor icon** (person icon, in the row under the input area) opens the Role Editor on the panel's role.
- **The session** (the upper link of the two lines, right of the queue buttons) shows the session the panel sends in — its name, what it is based on, its lifetime when it is not one conversation, and its model when it has a profile (e.g. *walk based on prep (per iteration) · claude-opus-5-5*). A click opens VS Code's picker: the quest's sessions with what each one does, **New session…**, and **New session based on…**. The choice is kept per quest; **Run default (<session>)**, first in the picker, follows the run's default session; *The panel's own session (chat)* goes back to `chat`. Picking a session that has a profile selects that profile in the panel; you can still choose another. **Send** runs in the session picked here. **Save to Queue** (add + list icon) always queues the prompt into the **default run** with the prompt queue's own profile, session (`default@default`) and default template — nothing from the panel but the text and the repeat count. **Queue next** (add + step-into icon) does the same so it is the **next one sent**: it goes in pending directly under the item of the default run that is sending (in front of the other pending items), and when that item is repeating (a repeat count above 1 or a `prefix*` walk) it is marked to go **between its iterations** — what Save to Queue, Send next and Send between iterations in the queue editor would do. After the session and Run select, **Save to Queue with this panel's session, run, profile and template** (add + person icon) and **Queue next with this panel's session and run** (person + step-into icon) queue the prompt in the panel's run and session, with its profile and template, so it continues the panel's conversation as Send would; the second, pending at the front of that run's lane, between a running loop's iterations. The confirmation names the run (and session) each went to.
- **The user-input panel — one open question per run**: everything a prompt waits for you on — a question (*tomAi_askUser*, the Agent SDK's own question with choices), a tool approval, a plan proposal, a picker that could not be a QuickPick, and the asks waiting in the MD Browser — is in one panel, **Tom AI — Waiting for you**, with **one tab per process run** that has something open (a badge counts them). Sessions of different runs ask at the same time: each run has at most one open question (a second ask of the same run is refused as before), and you answer them in any order. The panel opens when a question, a picker or a plan arrives and nothing is open; while you work in it, another run's question only adds or updates its tab. An approval also shows in the @CHAT panel (the run named), a plan as its overlay there; either answers it. Asks in the MD Browser stay in their own panels (two runs asking about one file get two panels); the panel lists them with **Show it**. Pickers: VS Code shows one QuickPick at a time, so while one run's picker is on screen, another run's is answered in the panel (items, your own words, Dismiss). Plan mode is per run, too. Stopping a turn denies only that turn's approvals. From Telegram, with several questions open, reply `<run>: your answer`. The questions journal names each question's run.
- **A reload keeps the question**: when you reload the window while a queue item's prompt waits for your answer — a question, a picker, an ask in the MD Browser — the ask comes back after the reload (the user-input panel opens again with the same questions and choices, the picker, the MD Browser with its buttons) and the item stays running instead of going back to pending. Your answer is sent to the item's session as its next prompt, telling the agent that the window was reloaded and quoting its question and your answer, and the item goes on where it was. Resend, Skip or Stop on the item close the restored ask instead. A send of the @CHAT panel that waits for your answer comes back the same way: your answer goes out as a new send in the same session and run, which continues the conversation; the send's queue entry says so. A reload in any other state works as before.
- **Waiting for your reply**: while the prompt of a running queue item waits for you — a question (*tomAi_askUser*, the picker, a question in the MD Browser, the Agent SDK's own question) or a tool approval — its entry in the Prompt Queue editor turns **orange** and carries **[⏳ waiting for your reply]** (or *approval*, *your decision on a plan*, *your answer in the MD Browser*), until you answer — a running chat send too. A click on it opens the user-input panel on the item's run tab, or brings its MD Browser to the front. A *tomAi_askUser* question says since when — **[⏳ waiting for your answer since 20:31 (9 h 25 min)]** — with an **Open question** button: closing the user-input panel leaves everything waiting, and the button, the command **@T: Show Pending Question** or the status-bar item **Waiting for you** (shown while anything waits, with the count per run) opens it again. **Continue** on a running item always asks first: **Answer now** (only while its turn waits for your answer: opens the question, the turn goes on with your answer), **Resend this stage** (ends the turn and sends the same prompt again; the agent is told its turn was interrupted), **Skip to the next todo** (or *stage*) — or Cancel, which does nothing. Resend and Skip close a waiting question unanswered, and so does Stop; the agent is told why. The ↻ button on a running item resends its stage directly (it asks first when a question is waiting).
- **Answering in the item**: while the turn of a running item waits in an ask, the item shows an ask panel, always visible like the wait panels. A question (*tomAi_askUser*): the questions with their choices as buttons — an answer choice is selected (click again to clear), a choice that acts (a process move, a branch) acts at once — and a text area with **Send**. A picker (*tomAi_askUserPicker*): its items, an *Other…* field, **Choose** and **Dismiss**. An ask in the MD Browser (*tomAi_askInMdBrowser*): the document's name, its buttons, and **Show document**. Answering there is answering in the user-input panel, the picker or the MD Browser: the agent gets the same answer, and the ask closes everywhere, on Telegram too. **Open question** still opens the full panel; a tool approval and a plan proposal are named in the item and answered there. **Continue** offers **Type an answer…** beside **Answer now** for a question.
- **Waiting on something outside the turn**: an agent that has to wait for something only time resolves — pub.dev's 12 new versions of a package in 24 hours, a rate window — calls `tomAi_waitFor`. Its item shows **⏳ Waiting: pub.dev limit: 12 versions in 24 h — until 14:20 (1 h 5 min left)** in the Prompt Queue editor (the time left counts down; the details are in the tooltip), and its run's tab names the wait. Its run sends nothing else meanwhile; other runs do. The wait ends by itself at its time and the agent goes on. **Interrupt the wait and move on** (on the line, or under **Continue**, which also offers **Keep waiting**, Resend and Skip) tells the agent you moved on: it ends its turn with a note of what is still to do, and the item steps back behind the next item of its run (held as staged when nothing follows). When it runs again, its stage is sent again with a note, and the agent goes on from its note. Stop, Resend and Skip end the wait with the turn.
- **Writing to a waiting turn**: both wait panels — the `tomAi_waitFor` line and the background-work line — have a **Message** button. It opens a text area right there in the item, with **Send** and **Cancel** (Ctrl/Cmd+Enter sends). Your message goes straight to the item's own turn, in its session and run; no chat panel, no session to pick. The agent gets it at once, answers or acts on it, and goes on waiting: a `tomAi_waitFor` wait resumes with the same end time, a background-work wait goes on after the agent's answer. Each message is listed under the panel with what became of it — *the agent has it*, *answered* (with the answer, where the transport reports it), *the wait goes on* — and is recorded in the quest's Questions journal and in NOTIFICATIONS (*You wrote*). **Continue** offers the same as **Message…**. The button is absent while no message can reach the turn.
- **Waiting for background work**: a running item whose turn ended while work it started still runs (a background command, a command stream) shows **⏳ Waiting for background work — 2 tasks, 1 h 20 min of 6 h** in the Prompt Queue editor (not in the @CHAT panel). **?** lists the running tasks with their commands and output file (or handle). **Wait without limit** waits until they end, **Keep waiting up to 6 h** starts the limit again from now, **Stop waiting** ends the turn now and the queue goes on; **Continue** offers the same three, plus Resend and Skip. A turn that ended with work still running — the limit reached, or Stop waiting — has a **red** answer chip, and its answer names what was still running.
- **The background-work reminder**: when such a turn ends its answer, the queue first sends the agent one reminder into the same session and turn: what still runs (each task or command with its id, command and output file), since when, and the limit — the turn is not finished; wait for the work actively, check its progress periodically, check the result, then answer again with it, without starting new work. On the Agent SDK it goes into the running query while the wait begins (the wait and its buttons go on as above); on the direct API and Local LLM the turn goes on with it before the queue waits. Once per wait: work the agent was already reminded about is waited for silently; new work in a later wait gets it again. The text is the Assist prompt **Background work reminder** (Status Page › Assist prompts, edited in the Global Template Editor; placeholders `${backgroundWork}`, `${waitingSince}`, `${limitMinutes}`); a template whose text is empty sends no reminder.
- **A todo walk checks each todo**: when an iteration's turn ends and its todo is not completed (and is not blocked, waiting for a decision, or waiting for your answer), the queue asks the agent in the same session to finish it — at most twice by default (`walkContinuations` on the item, `walk-continuations` for the queue). The chip then says **1 continuation**, and the answer shows the final turn with the earlier answer folded below. Still unfinished: the item shows **[⚠ needs attention]** with the reason, auto-send goes off, and the walk waits; turn auto-send on to go on with the next todo. In a question panel, an *answer* button selects that answer for its question (click it again to clear it); each such question has a field for your own words, and nothing is sent until **Send answers**, which sends every question's selection and words together. A button that moves the process or starts a branch or subprocess acts on its click. A question panel closes when its question is answered, times out, is cancelled — or when the prompt that asked ends first (stopped, aborted, failed): the question then ends unanswered and the agent is told so. An answer typed into a panel whose question has already closed is not sent; the panel closes and says so.
- **The run** (the lower link, under the session; its tooltip names the run in full; the Copilot subpanel has it alone after its Save to Queue) shows the process run the subpanel works on; a click opens VS Code's picker: `default` first, then the quest's other runs, the one the PROCESS view shows marked *(PROCESS view)*. Picking a run in the ANTHROPIC/LLM subpanel switches its session to that run's default session `default@<run>`, created when missing. **Send** runs in the run's session — the session picked with the session button in that run, `<session>@<run>` (the panel's own `chat` stays shared; a run's default session already names its run) — and while it runs it reads and writes that run's chat variables and sees that run's process position (`${process}`, `${step}`, the *Current process* section); the Copilot subpanel resolves the placeholders of its send the same way. The buttons after it queue in that run (ANTHROPIC/LLM: with the panel's target; Copilot: **Save to Queue in this panel's run**); **Save to Queue** and **Queue next** before it always go to the default run. The choice is kept per subpanel, window and quest, independent of the PROCESS view's run — a run other than the PROCESS view's is shown in yellow — and a run deleted elsewhere puts the subpanel back on `default`.
- **Chat sends in the prompt queue**: every send to the ANTHROPIC/LLM chat — the panel's Send, *Send to Anthropic/LLM* from the editor, a todo's Send or Guide me, Telegram — is shown in the prompt queue: **SENDING CHAT** while it runs, **SENT CHAT** once it ended. The entry is drawn like every other queue item, set apart only by the colour of its headline (light purple, darker while it runs): the same header — the label, its source (`[panel]`, `[editor]`, `[todo panel]`, …), the profile, the tokens, the run and session chips, the live-trail button, the times — and the same collapse / expand (its chevron, and *Collapse* / *Expand* in the toolbar), with the complete prompt and the answer as soon as it arrived — its first 600 characters with the expand / collapse toggle that shows the whole answer in place, and the two buttons that show it as Markdown (over the queue, in the preview editor) — or the error. Controls that act on a queued item are not shown on it: no move up / down, edit, reminder, *pause after this*, transport, stage / pending, send or resend. The queue never sends, retries or counts these items; *Clear sent* removes the finished ones. A CHAT entry can always be removed: a send still running is stopped with it, one that no longer runs is only removed. A chat send that gets no result within the prompt queue's response timeout (the queue editor's *Timeout*, default 60 minutes) is stopped and its entry ends with that error. One chat send runs per session; sends in different sessions run side by side. The todo panel's sends ask for a free session; sends from places without a session picker (the editor command, Telegram) run in the `chat` session.
- **A session Claude Code no longer has** — when a prompt resumes a session whose conversation Claude Code does not have (*No conversation found with session ID …*; it keeps conversations per machine, and the session files travel with `_ai` to the other hosts), the extension forgets the stored id and sends the prompt again in a new session, once and by itself. The live trail says so; the session continues in the new conversation from then on, without the earlier one's context.
- **Two prompts never share a session.** A session is busy while a queue item or another chat send runs in it (in this window or another of the quest). A chat send into a busy session is not started; you choose. When the prompt running there is an Agent SDK prompt, the first choice is **Send now as an update to the running prompt in session X**: your text goes into that conversation as another message while it runs (the SDK's streaming input), so the running prompt takes it into account; the queue lists it as a chat send (source *update*) that ends with the answer to the update. The other choices: **Run next in session X** (queued directly under the running item, between its iterations when it repeats — as **Send between iterations** does), **Run after the current item in session X** (queued after it, once all its iterations are done), or **Send now in session Y** for each session that is free at that moment (no queue item and no chat send runs in it). Chat sends hold one busy slot per session: sends in different sessions — the panel's, the todo panel's, Telegram's, a script's, an assist's — run side by side, and only a second send into the same session is refused. The panel shows itself busy while its own send runs or a chat send runs in its session; a chat send in another session does not make it busy. The panel's Send button stays enabled while its prompt runs, so a second Send reaches this choice. Dismissing the choice sends nothing and keeps the text. Telegram and scripts, which cannot be asked, are refused with the name of the running item. The other way round, the prompt queue does not start an item while a chat send runs in its session: the item shows **[waiting for session X]** and goes once the chat send has ended.
- **New session…** and **New session based on…** (which first asks for the base) ask for the session's lifetime:
  - **Continue** — one conversation. With a base, its first prompt starts from the base's conversation (an SDK fork); later prompts continue the new session, and the base is never changed.
  - **New for every prompt** — every prompt starts again, from the base's current conversation or fresh without a base, and nothing is saved, so the base can hold preparatory context (read the spec, the guidelines, …) while the prompts in this session never change the context of the ones after them.
  - **New for every queue iteration** — each round of a queued item's repeat count, or each todo of a `<prefix>*` walk, starts again from the base (or fresh); that iteration's pre-prompts, main prompt and follow-ups continue it.
- Then for the **profile** the session runs with: its prompts use it unless the queued item names its own profile; without one they use the queue default. The session list shows each session's model.
- **The SESSIONS view** (@TOM sidebar, above SESSION TODOS) lists the quest's sessions — `default` (the queue's) and `chat` (the panel's) always, then every session file — with what each is based on, its lifetime, profile and model, whether it has a conversation yet and when it was last used. **+** in its title bar creates a session (the picker's new-session steps); per row, **Reset** forgets the conversation — its history and its Agent SDK session — and keeps the base, lifetime, profile, its trails and its quest memory (a based session starts from its base again; `default` and `chat` can be reset too), and **Delete** removes the session with its whole storage after a confirmation naming what goes: `history/sessions/<name>/` (history, prompts/answers trail, live trail, raw trail, tool results) and its quest memory `_ai/memory/<quest>/<name>/` — not while another session is based on it. **Remove unused sessions** (the trash icon in the title bar) offers, in one multi-select, every named session nothing uses any more — no queue item still to run (any status but sent) runs in it or is created from it, it is not the queue's default session, no process definition names it (as session or base, a name with `${…}` placeholders standing for every session it can become; a process run's session `<name>@<run>` counts as named while `<name>` is and its run exists, so a deleted run's sessions are offered), no other session is based on it, and it is not a temporary session; those without a conversation are ticked, the rest are yours to tick. The ticked ones are deleted like Delete does, after one confirmation; when nothing is unused it says so and names what keeps the others.
- **Clear** (the @CHAT Logs section's clear-history action) forgets the selected session's conversation; a session you created keeps its definition (base, lifetime and profile) and starts again from it.
- A queued item can name a session that does not exist yet, as a name or with its base, lifetime and profile: it is created before the item's first prompt is sent. An item whose profile keeps its conversation elsewhere than the session's existing one (an Agent SDK session continued by a direct-API profile, or the reverse) is refused when it is queued.

On the **direct API transport** the extension sends the history itself — the compacted history, the last raw turns and the rounds not yet compacted — so a session's history is files of its own:

- every session keeps its own in `history/sessions/<name>/`, `chat` (the panel) and `default` (the queue) included, so the panel and the queue no longer share a history, and a queued prompt or a process step that names a session reads and writes only that history;
- **Continue** with a base: the session's history is copied from the base's once, on its first prompt, and continues on its own; the base is never changed;
- **New for every prompt**: every prompt reads the base's current history, or none without a base, and nothing is saved or compacted;
- **New for every queue iteration**: the session's folder holds the current iteration's history and is started again from the base's (or empty) when the next iteration begins.

The trails are per session too (§9); **Recreate history from trail** rebuilds each chosen session's history from its own trail.

### Plan mode

An agent can enter **plan mode** (`tomAi_enterPlanMode`) to read and plan before it changes anything. While it is on, the ANTHROPIC/LLM subpanel shows a yellow **Plan mode: read and plan only** badge, and every write tool — the extension's and Claude Code's Bash, Write, Edit, … — is refused on every transport; reading and asking you still work. When the agent has a plan it proposes it: the plan appears in the user-input panel on its run's tab (and in the @CHAT panel) with **Accept and leave plan mode** and **Keep planning** (with an optional note to the agent). Only you end plan mode — by accepting a plan, or with the badge's **Leave plan mode** button. Plan mode is per process run: a turn of one run that enters it does not hold another run's writes, and the badge shows the plan mode of the panel's run.

### Claude Code hooks

The hooks you set up for Claude Code (`~/.claude/settings.json`, the workspace's `.claude/settings.json` and `.claude/settings.local.json`) run on every profile: on direct, Local LLM and VS Code LM the extension runs them itself — PreToolUse, PostToolUse, UserPromptSubmit, Stop and SessionStart, with Claude Code's input and its exit-code and decision rules — and on the Agent SDK they run once, in the SDK. A hook's messages and failures show in the status line and the live trail. Details: [anthropic_handler.md §8](anthropic_handler.md#8-claude-code-hooks-all-transports).

### MCP servers on direct and Local LLM

The MCP servers you set up for Claude Code — in the workspace's `.mcp.json`, or with `claude mcp add` (they land in `~/.claude.json`) — give their tools to direct and Local LLM profiles too, named `mcp__<server>__<tool>`. Project servers from `.mcp.json` run only once approved (as Claude Code asks you to; or list them in `enabledMcpjsonServers` in `.claude/settings.local.json`). Their tools ask for approval like the extension's write tools, unless the server marks them read-only. Details: [llm_tools.md §4.11c](llm_tools.md#411c-tools-of-external-mcp-servers).

### Tools by role: roles and role types

A prompt runs as a role: its tools, `${role}` and the role text (`${role-description}`) follow it. The first of these that names a role decides:

1. **The todo's role**: the todo a walk or TODO item runs. It applies from the iteration's main prompt on, so its continuations and follow-ups too. The todo panel and editor set it in the **Role** field (*Default role*: none of its own).
2. **The queue item's role**: set with the person chip in its header. A click on a staged or pending item picks one of the roles under `_ai/roles/`, or *Default role*.
3. **The process step's role**: a Proceed prompt, and every item that prompt queued.
4. **The run's default role**: **Default role** in the context bar of the run's tab in the Prompt Queue editor.
5. **The chat variable `role`.**

While a queue item whose role comes from its todo, itself or its run's default sends, the chat variable `role` shows that role. It is put back when the item stops sending, however it stops: done, failed, interrupted, stopped or removed. A role you change by hand meanwhile stays.

The built-in chat variables are the window's, so with items of several runs sending at once the newest item's role is shown. Each send still runs as its own role.

**Where to see the role a prompt runs as:**

- **On the queue item:** the person chip in its header shows the role the item runs as. When the role is not the item's own, the chip is dimmed and says where it comes from: `idea_author · from its todo`, `coder · process step`, `reviewer · run default`. A TODO item shows its todo's role from the todo file; a walk or GROUP item shows the role of the todo it runs while it runs, and before that the item's, the step's or the run's (each todo's own role still wins). The hover names the order. Without any of these the chip is a grey person icon: the prompt runs as the chat variable `role`, if one is set.
- **In the live trail:** every prompt's header names the role it ran as and where it came from, `## 🚀 PROMPT 20261121_163000 [direct / opus-5-5-direct · role idea_author (todo)]` (`item`, `process step`, `run default`, `chat variable`). A prompt with no role adds nothing. @CHAT › Logs › MD Trail shows it.
- **In the system prompt:** the role's text under `## Role` (@CHAT › Logs › Current Prompt, variant *Queue / System*). Agents set roles with `role` on `tomAi_addQueueItem`, `tomAi_updateQueueItem`, `tomAi_sendItemToQuest`, `tomAi_createQuestTodo` and `tomAi_updateQuestTodo`.

The tools come from the role's **role type**:

- **Role types** live in `_ai/role-types/<type>/role-type.yaml`. A type's tools are either **the profile's default** (the profile's own tool selection, unchanged) or **a selection**. A selection replaces the profile's tools on every transport — direct, Agent SDK, VS Code LM and Local LLM.
- **Roles** live in `_ai/roles/<role>/`: the role's `role.md`, and a `role-config.yaml` that names its type (`roleType: document-author`).
- A role without `role-config.yaml`, a role whose type keeps the profile's default, and a run without a role keep the profile's tools, as before.
- **Always on:** some tools every prompt keeps, whatever the role type or the profile selects. These are asking you (`tomAi_askUser`, the picker, the MD Browser ask), notifications, the process position (`tomAi_getProcessState` / `tomAi_setProcessState`), the quest todo tools a walk reports with, ids and `tomAi_waitFor`. Both editors show them greyed and on, and a profile with a tool selection of its own gets them too.
- **Not affected:** Claude Code's own tools on the Agent SDK (the profile's *Use Built-In Agent SDK Tools*), the tools of external MCP servers, and a sub-agent's tools.

One page edits them, the **Role Editor**, with a **Roles** tab and a **Role Types** tab. Two commands open it, both in the Extension Tools overview: **@T: Open Role Editor** (`tomAi.editor.roles`; also the person icon of the @CHAT ANTHROPIC/LLM subpanel, on the panel's role) on Roles, and **@T: Open Role Editor on Role Types** (`tomAi.editor.roleTypes`) on Role Types. An open page switches to the tab the command names.

- **Roles** lists the roles. You edit `role.md`, pick the role type (*none* keeps the profile's tools) and the role's guideline choices; **+** adds a role. Roles are not deleted here: retire one by archiving it first.
- **Role Types** lists the role types with the roles that use them. You set the name, the description, the tools (the profile's default, or a selection by tool group: all / none per group) and the type's guideline choices. **+** adds a type and the trash deletes one no role names.
- **Guidelines:** each role and role type has the guideline picker ([Aspect guidelines](#aspect-guidelines)), with its own choices listed beside it; a new one has none. A role's popup shows its role type's choices as *from role type* (the type picked in the form, so changing it shows the other type's). The choices are saved with **Save**, together with the rest of the form; a list entry with choices of its own shows a book icon.

The page checks every file against its JSON schema before writing it (`.tom/json-schema/roles/role-type.schema.json` and `role-config.schema.json`; each file's first line names its schema). The workspace comes with two example types, neither assigned to a role: `document-author` (reading, editing files and documents, questions, specs, todos; no commands, git writes, queue or process control) and `coder` (everything but the process and queue controls). Details: [llm_configuration.md §6.1](llm_configuration.md#61-tools-by-role-role-types).

### Aspect guidelines

A prompt gets the guideline aspects chosen for it, aspect by aspect: an answer style, night mode, any aspect you add. Each aspect has choices; a level picks one choice per aspect.

- **The store:** each aspect is a folder under `_ai/aspect_guidelines/`. It holds an `aspect.yaml` (its name, a short label, where the text goes — `system` or `user` — a default choice and the choices' order) and one `<choice>.md` per choice, the file name being the choice's short name. A workspace from before `_ai` format version 10 has `section.yaml` with `options:` instead; **Upgrade the workspace** renames both.
- **Guideline files:** a choice's text is either its **Own text** (the `<choice>.md` in the aspect's folder) or a **Guideline file**, `_agent_guidelines/aspects/<aspect>/<choice>.md` — a guidelines file Claude Code can import outside the extension. Guideline files are looked up in the Tom root and in each workspace folder down to the window's (a nested workspace folder sees the root's, the outer folder's and its own); the nearest file wins for the same aspect and choice, and an own text wins over every file. An aspect may have guideline files only; its definition, `aspect.yaml`, is always in `_ai/aspect_guidelines/` (an `aspects/` folder without one is listed as a problem, and the editor's Save creates it).
- **The skills list** is the aspect `skills` (choice `all`, the default): the `## Skills` section naming the skills of `.claude/skills/` (text `${skills-list}`), sent on the direct, Local LLM and VS Code LM transports when the send carries `tomAi_loadSkill`; the Agent SDK loads skills itself. *Remove* it on a level — a workspace, the quest default, a role — for prompts that need no skills; `tomAi_loadSkill` still loads a skill by name.
- **Placeholders:** a choice's text may use the prompt placeholders (`${guidelines-<name>}`, `${file-<path>}`, …), resolved before the text is sent.
- **Which choices a prompt gets:** the levels are the aspect's default, workspace, quest default, window, run, role type, role, queue item and todo, each later one over the ones before. An aspect may take **several choices** at once (contradictory ones too); their texts are sent in the aspect's choice order. On each level its choices either **replace** those of the levels below (the default) or are **added** to them; *Remove* on a level sends nothing for the aspect, and a level above it may choose again. In the files a level's entry is a choice (`night: on`), a list that replaces (`js_ts: [vscode_extension, react]`), a list of `+` entries that adds (`js_ts: [+react]`), or `remove`; a single choice written before reads as it always did.
- **Conditional choices:** a choice in `aspect.yaml` may carry `when:` — an expression as in `${{ … }}` — and is then sent only while it holds, whichever level chose it (the default too). A chosen choice whose condition fails is simply not sent; no lower level's choice steps in for it, and a choice nobody chose is never sent, even when its condition holds. `remove_when:` on the aspect sends nothing while it holds, whatever was chosen. Conditions read the chat variables, the placeholders and the prompt facts (`prompt.transport`, `prompt.kind`, `prompt.todo`, `prompt.role`, `prompt.roleType`, `prompt.run`, `prompt.process`, `prompt.quest`, `prompt.workspace`, `prompt.night`). An expression that cannot be evaluated never stops a prompt: it is logged and the choice is not sent (an invalid `remove_when` removes nothing).
- **The workspace level** is two files in the Tom root and optionally in each workspace folder. In `workspace_aspects.md`, each line that holds only `@<path>` (relative to the file) names one choice file: `@_agent_guidelines/aspects/<aspect>/<choice>.md` or `@_ai/aspect_guidelines/<aspect>/<choice>.md`; every other line is free text. `workspace_aspects.yaml` beside it lists `remove: [<aspect> …]`, the aspects the workspace sends nothing for. The root's files apply everywhere; a nested workspace folder's override them per aspect. Within one folder, a remove wins over a choice of the same aspect. A path that names no file chooses nothing and is listed in the Aspect Guidelines editor and on the Status Page (Configuration Errors). **Set as workspace default** in the Prompt Queue editor (or **@T: Set Guideline Choices as Workspace Default**) writes the window's choices into the window workspace folder's two files; **Clear workspace default** (**@T: Clear Workspace Default Guideline Choices**) empties them, keeping their free text. Beside each CLAUDE.md, `CLAUDE-aspects-template.md` imports the same files plus the aspects' default choices and `workspace_aspects.md`: copied over the CLAUDE.md, it gives Claude Code on its own every chosen rule (the real CLAUDE.md does not import them, or the Agent SDK would get them twice).
- **Where it goes:** system aspects join the system prompt; user aspects go before the prompt text. On Copilot both go before the prompt text. The aspects follow each other by their `order:` in `aspect.yaml` (lowest first; the Aspect Guidelines editor's **Order** field), those without one after them by id.
- **The guideline indexes** reach the prompt as four aspects, each with one choice `all` and on by default: `index_root` (the root's `index_root_group.md`), `index_workspace`, `index_dart` and `index_checks` (the workspace folder's `index_workspace_group.md`, `index_dart_group.md`, `index_checks_group.md`). `index_root.md` and `index_workspace.md` are lists of `@<path>` lines importing them, so they read whole outside the extension, and `tomAi_readGlobalGuideline` without a file name answers the whole index. Removing an aspect removes exactly its group from the prompt.
- **The guideline picker** sets a level's choices. It is a book icon with a dot when its level chose something itself; its hover help lists the effective selection (`Answer: brief · Night: on`). A click opens a popup with one row per aspect: the choice in effect and where it comes from — **✓ here**, or in grey *from workspace* / *from quest* / *window* / *run* / *role type* / *role* / *item* / *default*. The hover help also lists where each choice in effect comes from (`Where from: Answer: brief (quest), long (here)`), the conditions, and the file each choice in effect comes from (`From: Answer: _agent_guidelines/aspects/answer/brief.md`), as does each choice in the popup. Hovering an aspect opens its choices as **checkboxes** (this level's choices; ✓ marks the ones in effect), a **Replace / Add** switch (whether this level's choices replace those below or are added to them), **Don't add** (no entry on this level) and **Remove** (nothing is sent for the aspect). Ticking a choice keeps the popup open; Don't add and Remove close it. A conditional choice shows `?`; its hover help names the condition and whether it holds for the kind of prompt the level stands for (a todo's, a queue item's, else a chat send's). A choice takes effect at once and closes the popup (in the Role Editor: with Save). **Edit aspects…** at the bottom opens the Aspect Guidelines editor.
- **Where the picker is:**
  - **Prompt Queue editor**, right of the compaction and memory model buttons (shared by every run): the window's button, the all-windows button (broadcast icon: each change sets one aspect in every window open on this machine), then two groups of icon buttons, the quest's (compass icon) and the workspace's (root-folder icon). In each, the icon with **save** sets the level from the window's choices (*Set as quest default*: the quest default, shared by every machine; *Set as workspace default*: this workspace folder's `workspace_aspects.md` / `.yaml`), with **×** clears it (disabled while the level has no choices), and with the **book** (the guidelines icon) opens the guideline picker on that level to choose its own selection directly. Each button's hover help says what it does; the same actions are the commands *@T: Set / Clear Guideline Choices as Quest Default* and *… Workspace Default*.
  - **The run's info line** (above each run's queue): *Guidelines:* with the run's effective selection, the run's own choices starred (`Answer: full*`); a click opens the run's picker.
  - **Queue items:** a staged or pending item's details hold its button and its selection; the list row shows only an indicator when the item chose something, with the details on hover.
  - **Todos:** the todo editor (the todo panel's detail form and the `*.todo.yaml` editor) has a *Guidelines* row with the button and the todo's own choices beside it; a todo row with choices of its own shows an indicator. Session and workspace todos have none.
  - **Role Editor:** each role and role type, saved with the item (see [Tools by role](#tools-by-role-roles-and-role-types)).
  - **@CHAT:** each subpanel (ANTHROPIC/LLM and Copilot) has a button for its sends' choices — the item level, kept until changed —, with a dot and the hover help only. Its popup counts the quest default, the window, the subpanel's run and, in ANTHROPIC/LLM, the role picked in its role dropdown.
- **Who wins:** each picker shows the levels up to its own. An item's choices count its run's and its role's; a todo's count the window's run and its role.
- **Every page follows:** a change of the window, a run or the quest default, made in the Prompt Queue editor, a todo panel, the @CHAT panel or another window (the all-windows button), shows at once in the Prompt Queue editor, every open todo panel and the @CHAT panel of the window, without a reload.
- **The Aspect Guidelines editor** (**@T: Open Aspect Guidelines Editor**, `tomAi.editor.aspectSections`; *Edit aspects…* in every picker, and the Extension Tools overview) edits the store. The list on the left holds the aspects: **+** adds one (it asks for its short name, the folder), the pencil renames the folder, the trash deletes an aspect with its choices (after a confirmation), the folder icon shows it in the Explorer. An aspect's form has its name, its short label (shown in the hover help; empty: the name), its placement (system or user prompt), its default choice (or none), **Remove when** (the aspect's `remove_when`) and its choices in order — each a short name (its file name), **Own text** or **Guideline file**, its text (Markdown with placeholders) and its **Condition** (`when`). A condition is checked as you type, an error naming its position, and an invalid one is refused at Save. The checkboxes under each condition write or take out a term, combined with `&&`: *only in todo prompts* (`prompt.kind == "todo"`), *only while a process runs* (`prompt.process != ""`), *only on the direct API*, *only on the Agent SDK* (`prompt.transport == …`), and *only for role types* with one or more of the folders of `_ai/role-types/` (`(prompt.roleType == "a" || prompt.roleType == "b")`). In Guideline file mode the text area shows and edits that file in place, and the line above it names the file and whose it is (the root's or a workspace folder's); **Create the workspace's own copy** writes the text into the window's workspace folder instead, the other file left as it is. A new Guideline file choice starts with its own text, in the root's file. Switching a choice to Own text keeps the file and offers **Copy the guideline file's text into the field**; switching to Guideline file drops the own text with Save. **Add choice**, the arrows and the trash change the choices; renaming the default choice keeps it the default. Edits are a draft, marked ● in the list and kept while you look at another aspect, until **Save** (Ctrl/Cmd+S) writes the aspect as a whole — a choice deleted or renamed loses its old file — or **Revert** drops them. Removing or renaming a Guideline file choice deletes the file it edits with Save (a farther copy then shows through); renaming an aspect moves its guideline folders too, deleting one keeps them. A save refuses an aspect without a name, a choice named `remove` (the levels' Remove), a choice twice, or a default that is no choice. A folder that does not make an aspect is listed with its problems, to be repaired. Renaming an aspect (the pencil) or a choice (in the draft, then Save) keeps every choice in effect: the choices saved under the old name are carried over to the new one on every level this machine reaches — the quest defaults and every host's window and @CHAT choices in the quests' `extension_config` files, the runs' queue settings, queue items, templates and inbox items, every quest's todos (session todos and archived ones included), roles and role types — and the other open windows on this machine carry over what they hold in memory. A message and a line above the form say what was rewritten. Every pickers' page and the Role Editor read the aspects again after a save.

Details: [llm_configuration.md §6.2](llm_configuration.md#62-aspect-guidelines).

### Send to Anthropic/LLM

The editor's text goes to the @CHAT ANTHROPIC/LLM panel's current profile and session, as if it had been typed there — on an Anthropic or a Local LLM configuration. From the command palette, the editor context menu or the `Ctrl+Shift+L` chord menu:

- `@T: Send to Anthropic/LLM` (`l`) — the selection, with the default user-message template;
- `@T: Send to Anthropic/LLM (Default Template)` (`s`) — the selection, or the whole file without one, with the default template;
- `@T: Send to Anthropic/LLM (Pick Template)` (`t`) — the same with a template picked from the one template store.

The answer appears in the panel and in the session's live trail. While a turn is running, a second send is refused with a notice.

### Copilot

Use command palette or editor context menu:

- `@T: Send to Copilot`
- `@T: Send to Copilot (Default Template)`
- `@T: Send to Copilot (Pick Template)`

Each opens Copilot Chat with the text — the selection, or the whole file for the template variants without one — wrapped in the template for the two template variants. They always go to Copilot; the ANTHROPIC/LLM panel has its own commands (above).

The templates are the one template store, the user-message templates (template editor: **Anthropic — User Message**); **Default Template** uses the one marked default. The extension seeds these into it:

- **With asking** (`with-asking`): before the work, the agent asks about every point the prompt leaves unclear, all at once, with the ask tools — `tomAi_askUser` (with choices), `tomAi_askUserPicker` or `tomAi_askInMdBrowser` — without a timeout. It files decision-needed todos only for what you leave open.
- **Execute TODO**, **Explain TODO**, and the todo buttons' **Guide me through a user action** and **Specify TODO**. Each names the ask tools for whatever it leaves open. Explain TODO writes its explanation into `_ai/quests/<quest>/explanations/<todo id>.md`, puts its questions there and asks through `tomAi_askInMdBrowser`.
- A seeded template you have not edited is brought to the current text when the extension starts; an edited one stays as it is.
- The former `with-context` and `with-role-banner` templates are gone. A queue item, timed request or default that still names one uses `default-raw`. A template (or a process step's prompt) can name the tools its prompts need with a line `<!-- tools: tomAi_specApplyEdits, TomSpecs (edit) -->`: on the direct API they are sent in full next to the core set and the rest is found by tool search, on Local LLM and VS Code LM the core set plus these tools are the whole list ([llm_tools.md §5.0](llm_tools.md#50-tools-a-request-carries)). In `@CHAT`, Copilot supports templates, prompt slots, answer-file notifications, and response-value extraction.

The **Copilot Queue Wrapper** (template editor: **Copilot — Queue Wrapper**, config `copilot.queueWrapper`; a built-in default when not set) goes around every Copilot send that waits for an answer — queue items, the todo panel's buttons, a script's send to Copilot — and makes Copilot write the answer file the queue waits for. The subpanel's own **Send** wraps only when its **Wrap** checkbox is ticked (off by default); Preview shows the prompt as Send would send it.

#### CHAT Action Bar

The Copilot section in `@CHAT` includes an action bar with:

- **R** (Repeat count): Number of times to repeat the prompt (text input, 24px wide). Accepts a plain integer, a chat-variable name (resolved at dispatch), or a `prefix*` pattern (see [Repeat and Affix Support](#repeat-and-affix-support))
- **W** (Answer wait minutes): Minutes to wait before auto-advancing without an answer file. When set to 0, uses classic answer-file detection. When > 0, the queue auto-advances after the specified time (text input, 24px wide)
- **Template picker**: Select a prompt template (the user-message templates)
- **Wrap** (icon toggle beside Send): send the prompt inside the Copilot Queue Wrapper, so Copilot writes an answer file
- **Keep** (pin icon toggle, beside Wrap): pressed, the text stays after Send or a queue add; not pressed, it is cleared. Kept for this window
- **Auto-hide** (dropdown, after the queue and trail buttons): close the side bar Copilot Chat runs in this long after a send — **Off** (keep it open), **3s**, **5s**, **10s** or **20s**. Kept for this window, across reloads (workspace state `tomAi.copilot.autoHideDelay`)
- **Queue mode** (icon toggle before the queue button): pressed (▶, the default), the queue button adds the prompt pending; not pressed (⏸), staged. Kept like the ANTHROPIC/LLM subpanel's
- **Queue button**: Add the current prompt to the queue with the configured repeat count and wait time

### Local LLM (Ollama / OpenAI-compatible)

A local model is used through an **Anthropic profile** whose configuration is a Local LLM configuration (`localLlm.configurations`, edited in the Status Page's **LLM Configurations** section). Pick that profile in the ANTHROPIC/LLM subpanel or name it on a queue item: the Anthropic handler's tool loop, approval gate, templates, sessions and trails apply, and each model call goes to the configured Ollama or OpenAI-compatible endpoint. See [llm_configuration.md §5](llm_configuration.md#5-local-llm-configuration-localllm-section).

The tool trail's past-tool-access tools (`tomAi_listPastToolCalls`, `tomAi_searchPastToolResults`, `tomAi_readPastToolResult`) let the model recall prior tool output by replay key (`t1`, `t2`, …) across turns, on every Anthropic profile.

## 4) Prompt Queue

The prompt queue manages sequenced prompt dispatch to Copilot with answer detection, repeat logic, and automation settings.

### Queue Storage

Queue entries are stored as individual YAML files (one file per entry) in the queue folder (`_ai/queue/`, setting `tomAi.queueFolder`), named `<host>_<workspace>_<yymmdd>_<hhmmss>-<token>_<quest>.<type>.entry.queue.yaml`; `<token>` is the first eight characters of the item's id, which the file holds as `meta.id`. The item's **Open YAML file** button opens it. Queue settings are stored separately in `queue-settings.yaml`. This file-per-entry approach enables cross-window sync via file watchers.

Files are prefixed with the hostname to prevent cross-workspace collisions when multiple machines share a workspace folder.

### Queue Entry Fields

Each queued prompt tracks:

- **Status**: `staged` → `pending` → `sending` → `sent` (or `error`). **Send Now** (the play icon) sends a staged or pending item at once and also works on a `sent` item: the whole item runs again from its first prompt (every repetition or `prefix*` todo, every follow-up). With auto-send off an item sends its first prompt and then holds as `SENDING (PAUSED)` until auto-send is turned on; an item with nothing left becomes `sent`.
- **Type**: `normal`, `timed`, or `reminder`
- **Template**: Prompt template name (or "(None)")
- **Answer wrapper**: Whether to wrap with answer file template
- **Request ID**: Unique ID for matching answer files
- **Pre-prompts**: Sent before the main prompt
- **Follow-ups**: Sent after receiving the main answer
- **Repeat settings**: `repeatCount`, `repeatIndex`, `repeatPrefix`, `repeatSuffix`
- **Reminder settings**: Template, timeout, repeat, enabled flag
- **Answer wait minutes**: Time-based auto-advance timeout

### Repeat and Affix Support

Prompts can repeat multiple times with customizable prefix and suffix text:

- **repeatCount**: Total number of times to send the prompt. Accepts three forms:
  - A **plain integer** (e.g. `3`).
  - A **chat-variable name** — resolved to its numeric value at dispatch time (not at enqueue), so the count reflects the variable's value when the item is actually processed.
  - A **`prefix*` pattern** (e.g. `tod*`) — switches the main prompt into **todo iteration**, described below. The displayed count is the highest number among the active quest's todo ids that start with `prefix` and hold a number. The number is the first run of digits after the prefix, wherever it starts, and anything after it is ignored: `tod3`, `tod3b`, `tod3-review` and `tod-groupa3` all count as `3`. The prefix itself may hold digits — `p2s2ss3-*` walks `p2s2ss3-1`, `p2s2ss3-2`, … — but must not end in one: `p2s2ss3*` is refused with an error instead of being queued, because after it `p2s2ss31` could be todo 1 or another group. Only the quest's **live** todo files are scanned — todos in the `-archived` / `-deleted` siblings do not contribute.
- **repeatIndex**: Current iteration (0-based internally, displayed 1-based)
- **repeatPrefix / repeatSuffix**: Template text inserted before/after each repetition, supporting placeholders `${repeatNumber}` (1-based), `${repeatIndex}` (0-based), `${repeatCount}` (total)

#### Todo iteration (`prefix*`)

A `prefix*` repeat count does not repeat a fixed number of times — it **walks the active quest's numbered todos**, one per dispatch. This applies to the **main prompt only**; a `prefix*` entered on a pre-prompt or follow-up keeps the plain counter behaviour.

- **Which todo goes next**: the lowest-numbered todo whose status is `not-started`. Todos sharing a number (`dsa2-a`, `dsa2-b`) are walked in alphabetical order. The walk starts at the first number that actually exists — a series of `dsa7`, `dsa9` starts at 7.
- **Todo groups**: the prefix is matched literally, dashes included, and the number may come after more text. So `xyz*` walks `xyz-groupa1`, `xyz-groupa2`, `xyz-groupb1` … together, by number (`xyz-groupa1`, `xyz-groupb1`, `xyz-groupa2`, …), while `xyz-groupa*` walks one group only. Every id that starts with the prefix and holds a digit joins the walk, so pick prefixes that no unrelated todo family starts with (`vsc*` would also take `vsctsa…` and `vscimpa…`).
- **A blocked todo holds the item**: the queue knows which todo an item is about — the todo a walk takes next, or the todo a plain item queued from the todo panel names — and reads its blockers before the prompt goes out. Blockers completed in the meantime never hold it. A blocker that is not completed holds the item: it turns amber with **[⛔ blocked: todo … waits for … (status)]**, its run is paused, and USER NOTIFICATIONS says so (*Queue item item-blocked*), exactly as an open decision does. Complete the blocker and resume the run: the item goes back to pending and runs. A blocked todo further down a walk holds nothing until the walk reaches it; a todo marked `blocked` with nothing that says why holds it too (set it back to not-started when it may run). A member checked in a GROUP item's selection is sent although blocked. **A blocker that runs first does not hold**: one the item itself runs earlier (it comes before the blocked todo in the walk's order, or the group's), or one a queue item ahead of it runs (a todo it names, or an open todo of its walk or group) counts as done by the time the blocked todo is reached. **A walk or GROUP item runs its in-progress todos too** — a reload or a stopped run leaves them in progress — unless it ran them itself or another running item works on them. On a held item the header offers **Stop** (back to staged: rearrange the todos, e.g. renumber them so the blocked one comes after its blocker, then set it to pending to restart it), **Continue** (a walk or GROUP item: skip the blocked todo and go on with the next; the skipped todo is left as it is) and **Run anyway** (run the blocked todo now, when its blocking information is out of date; a todo marked `blocked` is set to not-started). The tab's **Stop** and **Interrupt** buttons put a held item back to staged too.
- **Queueing a group with blockers outside it**: before a group todo or a `<prefix>*` group is queued from the todo panel, its members' Blocked By entries are checked first. When members wait for todos outside the group — still open, or already in the queue ahead — a dialog names each member and what it waits for and asks **Queue anyway**; blockers inside the group are the walk's own order and are not asked about.
- **Blocked todos**: before each pick, every `blocked` todo of the series is checked against its `blocked_by` list. When each todo named there is completed or cancelled (in the live files or archived), the todo is set back to `not-started` and runs in its turn — usually the completion has done that already (*Blocked todos follow their blockers*), and the walk only catches what a script or hand edit left — so a todo that waits on an earlier todo of the same list runs once that one is done. A todo with an open or unknown blocker stays blocked, and so does a blocked todo with no `blocked_by` list (a block written only in its notes) or with a `blocked_until` release condition, which only the completion of its blocker evaluates; when the walk reaches such a todo it holds there (*A blocked todo holds the item*, above). A blocker in another quest is written `<quest>/<todo id>`.
- **Claiming**: before the prompt is sent, the picked todo is set to `in-progress`. That is what makes the walk terminate — a claimed todo no longer qualifies, so every dispatch shrinks the candidate set. Todos that are already `in-progress`, `blocked`, `completed`, or `cancelled` are skipped.
- **The user's own todos are passed**: a todo marked `user_action: true` (👤 in the todo panel; the *Your to do* checkbox in the new-todo and detail forms) is work only you can do — a review, an answer, a look at a screen. The walk does not send it: it stays `not-started`, the next todo of the series goes instead, and the Prompt Queue log names the passed ids. When only such todos are left the main stage ends.
- **An open decision holds the walk when it is next**: a `decision-needed` todo is never run. The walk runs the todos before it (lowest number first) and holds when the todo it would take next is the `decision-needed` one: the queue item goes to `DECISION-NEEDED`, auto-send switches off, and the waiting id is logged. A decision at the end of a group therefore stops nothing before it.
- **The held item does not hold the rest of the queue**: restart the queue and the other prompts run — the blocked one is skipped for as long as its decisions are open. Answer them (set the todo back to `not-started`) and it returns to `PENDING` by itself the next time the queue picks an item; there is nothing to click. It is never overridden — an item is released only once the todo it was held at has its decisions answered (a later `decision-needed` todo of the series holds it again when the walk reaches it).
- **The answer stays on the todo**: when the prompt's answer arrives and the todo is completed by then, that answer is written onto the todo (`last_answer`, the last run's only). The todo panel shows it in the completed todo's Dates section: **Answer** with the two markdown preview buttons (below). An agent cannot set the field, and archiving the todo removes it.
- **Markdown preview buttons**: beside **Description**, **Notes** and **Agent answer** in the todo detail, beside **Instructions** and **Notify prompt** in its After done section, and beside each decision's **Decision needed** and **Decision** sit two small icons. The eye shows the text rendered as Markdown in an overlay over the whole panel, list and detail (close it with ✕, Escape or a click outside); the second opens it in the markdown preview editor in the editor area. Description and Notes are shown as they are in the form, unsaved edits included. The Prompt Queue editor has the same two icons in the **Answer** block of an item (a finished item, or a repeating one after its first round). A repeated item keeps the answer of **every repetition**: chips under its Answer, one per repetition — the todo's id for a todo walk (`<prefix>*`), the repetition's number for a counted repetition — the latest highlighted; a click shows that repetition's answer (its key in the Answer title, and in the two Markdown buttons). A repetition answered again (a resend) replaces its answer. A sent todo walk whose answers were not recorded (it ran before this) gets its chips from the session trails: the latest answer that reported each of its todos.
- **Agent answer**: every saved todo has this row, whatever its status. Its buttons show the newest answer in the quest's session trails that reported the todo (the `TODO=<ref>` response value an agent adds when it worked on a todo, from the chat or the queue); without one, the answer a todo walk stored (`last_answer`); without that, a note that none is recorded yet.
- **Where a todo is queued and sent**: the panel has no session or run of its own. Every queue button — a todo's **Queue**, the bar's **Save to Queue**, the stacked todos, **Queue as todo item** and a group's queue button, **Queue Group Prompt**, Guide me's queue path and every *Queue again* — asks in three quick picks:
  1. **Quest**: the quests with an open window on this machine. The default is the window's quest; in a list of several quests, the todo's own quest when it has a window.
  2. **Run** of that quest: its runs, `default` first, each with its state — busy (an item out, or waiting for you, an event or a task), paused or idle — as RUNS shows them.
  3. **Session**: only the sessions of that run that are free (no queue item sends in them, no chat send runs in them), then **Run default (<session>)** — no session of its own: the item runs in its run's default session when it is sent, whichever that is then — and **New session…** (a name; the session is made when the item is sent). Picking a run preselects Run default, unless the last target was another session of that run.

  The place in the queue is not asked: the **Next** toggle decides it for every queue button of the panel, the default ones included. It is the first button of a todo's **Run** row and sits before the queue buttons in the bar; off (the numbered list), an item goes to the **end** of the run's queue (staged); on (the arrow up in a circle, the queue item's own *Send next* icon), it is queued **next**, at the front, sent after the item or iteration that is running. Beside it is the **Fresh** toggle (a sparkle, pressed while on), as in the ANTHROPIC/LLM panel: on, a todo the panel queues or sends runs in a new one-prompt session based on the session picked (the run's default session for the default buttons) — it starts from that session's conversation, changes nothing in it and is removed when the prompt is done; a **New session…** is fresh as it is. Both toggles are one state for the bar, every Run row and every todo panel of the window, and their tooltips say what they do.

  After the first use the quest pick starts with **Last: <quest> / <run> / <session> / <next|end>**: one Enter queues there again, at the place the Next toggle says. Picking anew preselects the last run and session. Each panel (QUEST TODOS, the @WS section, @TOM TODO) keeps its own last target. Escape at any step queues nothing. An item for another quest goes through that quest's window's inbox, with its run, session and position, and arrives there as the same TODO / GROUP / plain item; the confirmation names quest, run, session and position. A TODO item or a walk runs over its quest's todos, so it is only queued into that quest. **Send** and Guide me's send ask only for a session — the free sessions of this window's runs, with their own **Last: …** — and send there, as that run. The bar's Send follows the transport of this window's run's queue defaults.
- **Send and Queue**: every saved todo's detail has a **Run** row of icon buttons: the **Next** and **Fresh** toggles, then **Queue in the default run** (add + list), **Send**, **Queue** (person + list) and **Queue as todo item**; a group todo has two more behind them, **Queue as group in the default run** (add + layers; a GROUP item in `default@default`, without asking) and **Queue as group with options** (person + layers; a GROUP item where you pick). On a group todo, **Queue as todo item** in this row queues the group todo itself as a TODO item, its members not walked: the queue claims it when it sends it (`group` → in-progress) and puts it back to `group` when the prompt ends without completing it. **Queue in the default run** adds the todo straight into its quest's default run, `default@default`, without asking; **Send** runs the todo now in a free session you pick (with the @CHAT ANTHROPIC/LLM panel's profile), **Queue** adds it to a prompt queue you pick (see *Where a todo is queued and sent*). The bar has the same pair: **Save to Queue in the default run** (the stacked todos, else the selected one) first, then **Save to Queue** that asks. Both always send on Anthropic, whatever the queue's transport, and pick the template themselves: the Status Page's **Todo buttons** template for user-action todos (default *Guide me through a user action*) for a todo marked 👤, the one for other todos (default *Execute TODO*) for every other todo.
- **Guide me**: beside the **Your to do** (👤) checkbox of a saved todo, two buttons send the todo with the Todo buttons template for user-action todos: the speech-bubble one in the @CHAT ANTHROPIC/LLM panel now, the list one into the prompt queue (on Anthropic, staged). When the speech-bubble one's turn has ended and the todo is not completed, the question panel asks what now: **Mark it completed**, **Mark it in progress** (unless it is), **Queue it** (into the prompt queue, staged, with the template for other todos — default *Execute TODO*) or **Leave it as it is**, selected and sent with **Send answers**; your own words in the field under the question (with a choice or alone) are added to the todo's notes with the date. The same happens after **Send** of a todo marked 👤, which runs the same template.
- **If the send fails**: the todo is handed back to `not-started`, so the retry picks up the same todo rather than skipping it.
- **When nothing is left**: the main stage ends and the item proceeds to its follow-ups.
- **Nothing to walk over from the start**: an item whose walk has nothing to do when it is queued — no todo of the prefix, or only completed, cancelled, in-progress or your own (👤) todos — goes to `ERROR` at once, and the error says why (*Nothing to iterate over: …*, with the count of each status). It does not fall back to a single run. Add or reopen a todo and set the item to staged or pending: the check runs again, and the item goes back when the walk has work. An item queued with pre-prompts is not checked, since a pre-prompt may create the todos; adding a pre-prompt to a held item stages it again.
- **Placeholders**: `${repeatTodoId}` is the picked todo's full id, `${repeatTodoTitle}` its title (its description when it has none), and `${repeatNumber}` its number. All three work in the prompt text and in the repeat prefix/suffix.
- **The todo comes with every prompt**: each prompt the walk sends for a todo — its pre-prompts (with the todo it picks next), the main prompt and its follow-ups (with the todo walked last) — ends with *Here is the complete YAML of the todo:* and the todo as stored (every field, decisions with their answers, notes, references; not `blocking`), headed by its file. Your own walk prompts need no placeholder for it, and a stage running in a fresh session still has the whole todo.
- **In the queue entry header**: the current todo's full id appears as a badge next to the `[MP …]` progress, e.g. `SENDING [MP 7/9] [dsa7-review]`. The rep-number is read-only in this mode, since the walk is driven by todo status rather than by the counter.
- **Caveat**: if a prompt resets its todo back to `not-started`, that todo will be picked up again.

#### TODO and GROUP items

A queue item knows what it holds — its **kind**, shown by `tomAi_listQueue` and written into its entry file (`item-kind`): **todo**, **group**, **prefix** (a `prefix*` walk), **iteration** (a repeated prompt), **chat** (a chat send) or **prompt** (a plain prompt).

- A **TODO item** runs one todo the way a walk runs each of its todos: the prompt with the todo's record appended, the todo claimed (`in-progress`) when it is sent, and after the turn the completion check with its continuations (*A todo walk checks each todo*). It reports done, or needs attention when the todo is still not completed. Its repeat count is `todo:<quest>/<id>`.
- A **GROUP item** walks a group todo's members (*Todo groups*) in their order in **Members**, one per iteration, by the walk's rules: it sends a member that is not started, releases one whose blockers are done, passes your own (👤) and the completed ones, and holds at an open decision. Members of another quest are not walked (the item runs in the window's quest). Its repeat count is `group:<quest>/<id>`.

Queue them from the todo panel with **Queue as todo item** (in the detail view; the queue button of a todo group, and ⏩ on a group todo's tile): a todo becomes a TODO item — its prompt is the todo panel's todo prompt, the Todo buttons template for that todo around a line naming it, on Anthropic, as the Queue button beside it does — and a group todo a GROUP item with the quest's group prompt, like a group walk. (In a group todo's detail **Run** row the button queues the group todo itself as a TODO item; the row's two group buttons queue the GROUP item.) Both go where you pick (quest, run, free session, at the place the Next toggle says; see *Where a todo is queued and sent* under the Quest TODO panel). The **Queue** button beside them still queues a plain prompt with the todo's text. Agents queue them with `tomAi_addQueueItem` (`todo` / `group`, `position: 0` for the front) and into another quest's queue with `tomAi_sendItemToQuest` (`todo` / `group`).

A GROUP item lists its group's **members** in the queue editor, in their order in **Members**, each with its id, status and title, and a marker for what the walk does with it:

- **→** the member being sent now;
- **✓** a member this item sent, with its outcome: *completed*, or *needs attention* when it is not completed;
- a **checkbox** for every member still to come, checked when the walk will send it.

The checkboxes start from the walk's rules (open, not blocked, not your own, its decisions answered). You may check any member — a completed or blocked one too — and uncheck any; **Select all** checks every member still to come, **Reset to rules** drops your choices. The walk then sends exactly the checked members, in their order, each once. Your choices are stored on the item (`group-selection` in its entry file); a member added to the group later starts as the rules say, and a member removed from it is gone from the list. The list can be changed while the item is staged, pending or sending (for the members still to come), and while it waits because its walk had nothing to send. Agents read the members with their marker in `tomAi_listQueue` (`members`: → being sent, ✓ sent, ☑ will be sent, ☐ will not) and set them with `tomAi_updateQueueItem` (`groupSelection`: the member ids to send).

### Answer Detection

The queue uses RequestId-based answer file matching:

- A unique request ID is embedded in each prompt via the answer wrapper template
- The file watcher monitors the answer directory for `*_answer.json` files
- A fallback polling mechanism (every 30 seconds) catches missed file events
- When `answerWaitMinutes` > 0, the queue auto-advances after the specified time without requiring an answer file

### Automation Settings

Every process run has its own queue settings: the ones below, the defaults new items take (transport, profile, session, prompt template), the walk continuations, and the Copilot answer timeout and reminder template. Each run's tab (see *Process runs* below) shows and sets that run's settings. Only the compaction and memory-extraction models are shared by all runs (above the tabs). The settings are kept per quest, in `queue-settings.yaml` under `runs-by-quest:` → the quest → the run: the file is shared by every window of every quest, and two quests' runs of the same name (every quest's `default`) keep their own settings. A window writes only the runs it changed, so one window never switches another window's run on or off; a quest without its own entry yet starts from the older shared `runs:`. The file's top-level keys (one set for the whole queue, also the old shape of the file) are the start values: the settings of a run that has none of its own yet. **Make default** (the pin button in a tab's toolbar, *Make these settings the default for new runs*) writes the tab's settings there: runs without settings of their own and runs created later start from them, runs with their own keep them. The status bar says what changed; the button is disabled while the tab's settings already are the default. The walk continuations are not copied.

**Apply run defaults to all items** (the arrow-down-circle button in a run's toolbar): a picker lists **Profile**, **Template**, **Session** and **Role**, each with the run's current default, all ticked; untick what should stay as it is. OK writes the run's defaults onto every **staged and pending** item of that run's queue; items that already started, and items of other runs, stay as they are. Tick **Remove per-item settings** as well to remove the items' own values instead, so they follow the run's defaults from then on (the template becomes **Run default**: the run's template, taken when the item is sent). An item whose profile cannot continue the new session keeps its session, and the message after OK says so, together with how many items changed.

**Move items to another run** (the arrow-swap button in a run's toolbar) opens an overlay over the queue with that run's items, each with the first line of its prompt and its status, transport, session, role and template, and a peek of the prompt below (click it to see more). Staged and pending items have a checkbox; an item that already started, an item of a Proceed run and a process-move marker are greyed, with the reason. **Select all** ticks every item that can move. Pick the target run and **Move**: the items go to the end of that run's queue and lose their own profile (transport, profile, configuration), session, role and template, so they follow the target run's defaults — the template as **Run default**. The message after Move says how many moved and why any did not.

**Run default** in the pickers: an item's template select (main prompt, pre-prompts, follow-ups) offers **Run default (<template>)**, the run's template, taken each time the item's text is built — so changing the run's template changes it for every such item. The @CHAT panel and the todo panel offer the same choice (below); what they queue with it carries no setting of its own and follows the run.

| Setting | Default | Description |
| --- | --- | --- |
| Auto-send | Off | Send the run's pending items one after another |
| Auto-start | Off | Turn the run's auto-send on when the window starts |
| Auto-pause | On | Pause the run's auto-send when its items are all done |
| Auto-continue | Off | Resume the run after a reload (see below) |

Without Auto-start a run starts paused at every window start: its auto-send is
off until you turn it on (or Auto-continue does). **Auto-continue** (only when
Auto-start is off) turns the run's auto-send on 30 s after the window starts if
one of its items is interrupted or is pending with repetitions left. A run
created after the window started takes the start values.

Turning **Auto-send** off never interrupts the item that is already running —
it finishes its stages and then its run stops instead of starting the next
one; the other runs go on. This holds for every transport and however the running item finishes
(answer file, answer-wait timeout, manual **Continue**, or a resend).

A few explicit actions deliberately start an item even while its run's
auto-send is off, because that is what they are for: **Send now** on an item,
the per-item **Retry now** on a waiting or retrying item, and **Retry All
Errors** (which turns the auto-send of the runs it retries back on for the
cascade). The background health check also resumes an item whose rate-limit or
retry window has just elapsed. Everything that stops a run by itself — an
error, an interrupt for continuation, a walk that needs attention or waits for
a decision, out of credit, Auto-pause, *pause after this* — stops only the run
the item belongs to.

### Send between iterations

A queue item that repeats its main prompt — a repeat count above 1 or a
`prefix*` todo walk — holds the queue until its loop ends. To send something in
between, put that prompt directly under the running loop item (Send next does
that). On that item, Send next turns into **Send between iterations** (the
step-into icon): click it and the item is marked **[⇄ between iterations]**.
When the loop has finished its current iteration, it steps aside: the marked
item is sent, and the loop then goes on with its next iteration. Click the
icon again to unmark; marking another item moves the mark. If the loop ends
with its current iteration, the marked item simply runs next. With auto-send
off the loop holds as usual and the mark stays. **Queue next** in the
ANTHROPIC/LLM subpanel does all of this in one click for a new prompt.

### Let the next item go first

The other way round: an iteration item (a repeat count above 1 or a `prefix*`
todo walk), pending or sending, has a **Let the next item go first** button
(the step-over icon; also among Continue's choices on a running item). On a
**sending** one the running iteration finishes normally — its answer is kept,
its todo handled as usual, its waits (background work, a question) and the
check of an unfinished todo first — and then, instead of its next iteration,
the item steps back to pending with its walk position kept and moves behind
the next pending item of its run's lane; that item is sent, and when it ends
the walk resumes with its next todo. Until it yields the item shows
**[yields after this iteration]**; click the button again to keep iterating
instead. On a **pending** item the button moves it at once behind the next
pending item of its lane. Without a following pending item in its lane the
button is disabled and its tooltip says why. Agents do the same with
`tomAi_updateQueueItem` and `letNextGoFirst: true` (`false` cancels it).

### Waiting for a session

A pending item whose session a chat send is running in waits: it shows
**[waiting for session X]** and the queue (and **Send now**) starts it only
once that chat send has ended, so two prompts never share a conversation.
From the chat, a send into a session a queue item runs in offers to queue it
next or after the current item, or to send it in a free session (see
*Two prompts never share a session* under the ANTHROPIC/LLM panel).

### Editing a pending item

A pending item has an **edit** button (pencil) in its header. It opens the
prompt in a text box with **Save** and **Cancel**; the item keeps its place in
the queue. While the box is open the queue does not send that item: when its
turn comes (also as the item sent between iterations), the queue waits until
you save or cancel, then sends it. Typing goes on undisturbed while the queue
redraws. Closing the queue editor ends an open edit without saving. A staged
item's prompt is edited in place as before.

### Pause after this

Every queue item carries a **pause icon** in its header. Clicking it arms
"pause after this" and the icon switches to an inverted (white-on-black)
state so the armed item is unmistakable at a glance. Click again to disarm.

The armed item still runs to completion — all pre-prompts, every repetition of
its main prompt, and all follow-ups. Only *after* its last stage does the queue
stop: auto-send flips off and the next pending item is not started. Items that
repeat only once behave the same way.

The hold is honoured on every path an item can finish on, including a manual
**Continue** on the item and a resend — an item never slips past the pause
because of *how* it happened to finish.

The flag stays on the item rather than being consumed, so re-staging and
sending it again pauses the queue again. Clear it with the same button; it
remains visible (inverted) on a finished item precisely so a leftover flag
cannot hide. The one exception is an item with a done notification: the
flag moves to the notification, so the queue pauses after the notification.

### Done notification

Under every item's prompt is a collapsible **Done notification** section: a
prompt queued right after the item when the item is finished — all its
pre-prompts, repetitions (or `<prefix>*` todos), follow-ups and template
iterations done — or when it ended in an error that will not recover (no API
key, a request the API refused, retries exhausted). Waiting out a usage quota
or a rate limit is not such an error, so nothing is queued then.

- The notification is queued ahead of every other pending item and runs with
  the item's transport, profile and session. Its header reads *notification of
  `<item>`*.
- `${itemOutcome}` in it reads `done` or `error: <message>`; `${itemAnswer}`
  the item's answer (for a walk one section per todo, for repetitions one per
  repetition; cut at 4,000 characters with a note on where to read the rest);
  `${itemTitle}` the first line of the item's prompt; `${itemTodos}` the todos
  it ran with their status.
- The bell icon in the section's title switches it off (the prompt is kept, not
  queued) and on again. The prompt can be changed until the item is sent, also
  while it is running.
- It is queued once per run: a failed item retried by hand that then succeeds
  does not notify twice; Send Now on a sent item starts a new run.
- **Posted to** under the prompt says where it goes: *this queue* (the
  default), another **run** of this quest (it is queued in that run's lane and
  runs in that run's session, `<session>@<run>`), or another **quest** and a
  run there. The button opens a quest picker — this quest, then the quests
  with a window running, then the others — and a run picker of the chosen
  quest. For another quest the notification goes into that quest's inbox and
  is queued there with that queue's defaults; the item's *pause after this*
  stays with the item. With no window of that quest running it waits in the
  inbox until one starts: the item says so in its header (`notification waits
  in <quest>`) and under the prompt.
- `${senderQuest}` and `${senderRun}` in it read the quest and run it comes
  from.

### Items from other quests

An agent in one quest's window can put a prompt into the queue of another
quest's window on the same machine with `tomAi_sendItemToQuest` (also over
MCP). The target window takes it up at once — or when a window of that quest
starts — and queues it with its own defaults; the item shows **from
`<quest>`** in its header. The sender may give the profile, an existing session
of the target quest, or a new session based on one (without a name, a
temporary session deleted when the item and its notification are done; the
SESSIONS view lists it last, tagged *temporary*), and a
done-notification prompt, typically one that sends a message back, and where
that notification is queued (back in the sender's quest and run, so it hears
back directly). The item can go into a process run of the target quest, and
it can be a todo walk there: `repeatCount: "<prefix>*"` walks the target
quest's todos with that prefix in that run's lane. Without a run it goes into
the target quest's `default` run (and its queue's default session) — never the
run the target window happens to work on, so its *pause after this* holds
`default`, not the run you work on there. A run the target quest does
not have is refused when the item is sent; a sent item never creates a run. In
those prompts `${senderQuest}` and `${senderRun}` are the sending quest and
run.

### Interrupt for continuation

**Stop** and **Pause** each cover one kind of interruption: Stop cancels the
running prompt and reverts the item to Staged (a fresh restart from repetition
1); Pause lets the running repetition finish and holds before the *next* one.
Neither fits the case where *you* have to interrupt — the network is about to
go away, the machine is about to sleep — and want the running prompt to go on
once you are back. That is the **Interrupt for continuation** button
(`codicon-debug-disconnect`, next to Stop in the toolbar, and on the running
item's own row). It interrupts **softly first**:

- The running prompt is stopped at the next possible point: the result of its
  next tool call is **held** — not handed to the model — so the turn stays open
  without anything in flight. Auto-send of the item's run switches off. The row
  says `INTERRUPTING` (with the seconds left) and then `HELD` (*held since 14:05
  at the result of Bash*); the run's tab shows the disconnect icon.
- A prompt waiting for your answer to a question, waiting in
  `tomAi_waitFor`, or done with its answer and waiting for its background work,
  counts as held at once; the question stays open (an answer you give is kept
  until you resume), the wait goes on.
- If the prompt ends its turn within 15 seconds, that stage is simply done and
  the run stays paused.
- **Waiting without a limit**: click the button a second time while it still
  waits for its hold point (after the first click it shows a watch icon) and it
  waits for that point however long it takes. There is no hard interrupt after
  15 seconds: a prompt running a tool for half an hour is held at that tool's
  result, or simply ends its turn. The row says `INTERRUPTING (NO LIMIT)`.
- While it waits (and while it holds), a panel under the item's header says so,
  with **Hard interrupt now** (end the turn at once, as below) and **Cancel
  interruption**: the turn goes on as if you had never pressed. A request still
  waiting is withdrawn, a held result is handed back, and the run sends again
  if the press had switched its auto-send off; if it was already off, it stays off.
- Re-enabling Auto-send (the play toggle, Auto-start on reload, Auto-continue,
  Telegram `continue`), or **Continue → Resume** on the item, hands the held
  result back: the prompt goes on where it stopped — nothing is sent again. A
  result held longer than a minute tells the model how long it was held.
- **Hard interrupt**: when nothing could be held within 15 seconds (a long
  command still running, text without a tool call) and you did not ask to wait
  without a limit; when you click the button a third time, or once it is held
  (then it shows a stop icon: *click again for a hard interrupt now*); with
  **Hard interrupt now** in the item's panel or **Continue → Hard interrupt**;
  and always for a Copilot prompt (it has no hold point). The running prompt is cancelled;
  the item is held at its **current repetition** as `INTERRUPTED <KIND> — RESENDS ON
  RESUME` (e.g. `INTERRUPTED TODO — RESENDS ON RESUME`). Re-enabling Auto-send re-sends that repetition first — with a note
  that it was interrupted (and a tool result it never saw) — in the same
  conversation it ran in; the held row also offers **Resend** (replay now) and
  **Move back to Staged** (abandon the continuation).
- A window reload or restart while the prompt is held leaves the item
  `INTERRUPTED` with its run paused. Resuming continues a direct-API or Local
  LLM prompt exactly where it stopped; an Agent SDK prompt is resent with the
  note and the result it was holding.

Between two stages (no turn running) the button only pauses the run. Each run
tab shows what its run does: held, ❓ (an answer is needed), ⏳ (waiting in
`tomAi_waitFor`), sending, paused, waiting or idle — hover for the details. The
queue's status bar item shows the same for the window's run (e.g. `held: Bash`,
`❓ answer needed`, `⏳ until 14:20`). Restart Queue leaves a held item alone.

### Watchdog and Health Check

A background watchdog runs every 60 seconds to ensure queue reliability:

- Verifies the answer directory exists and is accessible
- Checks the file watcher is active and restarts it if needed
- Detects stalled pending items and triggers processing
- Supplements primary file watching with polling every 30 seconds

### Queue Editor

Open with `Ctrl+Shift+6` or `@T: Open Prompt Queue`. The editor provides:

- **Compaction models** (the row above the run tabs): two label-less choice buttons — the compaction model (fold icon) and the memory-extraction model (light-bulb icon), each showing the chosen configuration as link text; the hover help names which it is. A click opens VS Code's picker with *not set* and every configuration, the current one marked. The same choices and settings as the Status Page's History Compaction section (`compaction.compactionModel`, `compaction.memoryExtractionModel`) — a change in either place shows in the other.
- **The run's defaults** (the bar under the run's context): its transport, model (the Anthropic profile), session and template as label-less link text in one line; the hover help names each, and a click opens VS Code's picker.
- **Toolbar**: Auto-send, Auto-start, Auto-pause, Auto-continue toggles, Restart Queue, **Stop** (cancel the running prompt and revert it to Staged) and **Interrupt for continuation** (see above)
- **Entry list**: Per-item cards with status color coding, type badges, progress indicators. Each card's header starts with its **status and kind in one label**: `PENDING TODO`, `SENDING GROUP`, `STAGED PROMPT`, `PENDING PREFIX`, `PENDING ITERATION`, `SENT CHAT`, `ERROR GROUP`, … — the kind says what the item holds (a TODO or GROUP item, a `prefix*` walk, a repeated prompt, a chat send, or a plain **PROMPT**; see *TODO and GROUP items*). The colour stays by status. What holds or delays the item follows the label: `SENDING TODO (PAUSED)`, `PAUSED TODO`, `SENDING PROMPT — RATE LIMITED, RETRY 2 AT …`, `WAITING PROMPT FOR …`, `RETRYING GROUP 2/7 — NEXT …`, `INTERRUPTED TODO — RESENDS ON RESUME`, `SENDING TODO — ❓ ANSWER NEEDED`, `DECISION-NEEDED PREFIX`; *needs attention* stays a chip beside it
- **Staged item form**: Template, repeat count, answer wait minutes, repeat prefix/suffix, pre-prompts; the prompt and the repeat prefix/suffix take `Ctrl+Shift+Space` completion — slash commands, skills, files (see [Keyboard productivity](#10-keyboard-productivity))
- **Per-item controls**: Preview, send now, move up/down, delete, toggle reminder, pause after this, interrupt for continuation (on the running item: soft first, a second click waits for the hold point without a limit, a third — or one once held — is the hard interrupt; the item's panel offers Hard interrupt now and Cancel interruption); a held item's Continue offers Resume and Hard interrupt; an interrupted item offers Resend and Move back to Staged
- **Out of budget**: when a prompt stops because the API credit balance is too low, the item shows an *Out of budget* panel — the profile and session that stopped, a profile picker, **Continue on profile** (sends it on the picked profile with a note pointing to the stopped session's live trail — the *Out of budget* Assist prompt, see [Assist prompts](#assist-prompts)) and **Resend** (the last request again, once there is credit). A profile can name the profile to continue on and switch to it by itself (profile editor: *Out of Budget: Continue On*, *Switch Automatically*); the picker then starts on that profile. An agent can do the same (also when you ask it from Telegram): `tomAi_resendQueueItem` with `profileId`.
- **Live trail of an item**: the type icon at the right end of an item's headline (the speech bubble, a watch for a timed item, a bell for a reminder) is a button: it opens the live trail of the session the item runs in (its own session, else its run's queue session, `default@<run>`) in the MD Browser in live mode. A Copilot item writes no live trail; the button says so. On a running item whose prompt runs on the Agent SDK the button writes into it instead: it opens a message box under the header (**Send**, **Cancel**, **Open live trail**; Ctrl/Cmd+Enter sends), and the message goes into the running conversation as another user message, which the agent answers in the same turn (while the turn waits in `tomAi_waitFor` or for its background work, the message goes to that wait, as the wait panel's **Message** does). The message and its answer stay listed under the item's header, also after it has ended, and the queue shows it as a chat send (*update*). Other transports take no message while they run — the direct API, Local LLM and Copilot — so there the button opens the live trail and its tooltip says why.
- **Profile**: an item that names its own profile shows the profile's name in its header (blue chip; the tooltip names model and kind). An item without one shows a person icon button instead: it runs with its session's profile, else the queue default, which the tooltip names. A click on either opens a picker with **every profile**, whatever it runs on — Agent SDK, direct API, VS Code LM, Local LLM; the chosen one becomes the item's own, with the profile's own configuration, and the icon button is replaced by the name. *No profile of its own* in the picker takes it away again. The profile can change until the item has finished; on a sending item it applies from its next stage or iteration. When the chosen profile cannot continue the conversation of the item's session (an Agent SDK session and a profile with its own history, or the reverse), you are asked whether the item runs in the queue's default session instead.
- **Header texts**: every text of an item's header is 11px, normal weight; the header names the prompt template in brackets when the item has one.
- **Sessions**: an Anthropic item shows the session it runs in (speech-bubble chip in its header), with a `*` after the name when that session is based on another; its tooltip names the base and the lifetime (new for every prompt or every queue iteration), and a session the item will create when it is sent reads from the item's spec. A click on a staged or pending item opens the session picker (an existing session, a new one, one based on another, or the queue default). The transport gear asks for the session as its last step. The context bar at the top of a run's tab reads *Quest: … | Run: … | Position: … | Role: … | Session: … | Variables: …*, all of that tab's run: **Position** is the run's process position (a click opens its state file, `process-state.<quest>.<run>.yaml`); **Role** is the role chat variable for the window's run, and for another run the role its step names (shown, not picked); **Default role** is the role the run's items run as when neither their todo, they nor a process step names one (a click picks it; see [Tools by role](#tools-by-role-roles-and-role-types)); **Session** is the run's default session, the one every item of the run that names none runs in (unset: the run's own `default`), shown with its base and lifetime, e.g. *Session: walk based on prep (per iteration)*; **Variables** counts the run's own chat variables (they are listed in its tooltip) and opens the Chat Variables editor for the run. The Chat Variables button opens its editor for the tab's run too; the editor names the run in its title (*Chat Variables — run collab*) and in a run line. The bell beside it opens the Status Page's reminder settings (the alive check and the window's run's default reminder template). The Chat Variables editor then shows and edits that run's custom variables and shows its process position; the built-in variables (quest, role, projects, todo) are the window's, shared by every run. Both are underlined links: a click opens a VS Code picker — the roles under `_ai/roles/` (or none), or the session picker. Agents set it with `session` on `tomAi_addQueueItem` / `tomAi_updateQueueItem` and create sessions with `tomAi_createSession` — see [Named sessions](#named-sessions).
- **Process runs, one tab each**: right below the headline and the shared compaction / memory-extraction models, the editor has a tab per process run — the quest's runs and any run that has items, `default` first. Each tab is that run's queue: its items only, its context bar and its toolbar. Two **context bars**, one field per setting, its label above its value. The first, with the icon buttons (chat variables, reminder settings, prompt and queue templates), is the run's context: Position, Role, Default role, Guidelines, Variables. The second holds the defaults the run's items take: Transport, Model (the Anthropic profile; only when the transport is Anthropic), Session, Template. Quest and run are not repeated there: the window and the tabs show them. A value you can change is a link; a click opens VS Code's picker (role, default role, transport, profile, session, template), the guideline picker, the run's state file or its chat variables. The answer timeout and reminder template sit in a row of their own, only while the run's default transport is Copilot. The **toolbar** is icon buttons, each acting on the run's items: Add, auto-send play / pause, Auto-Start, Auto-Pause, Auto-Continue, Make default, Move items, Apply run defaults, Restart, Stop, Interrupt, then double icons — **Send all staged** (send + layers), **Retry all errors** (refresh + error), **Delete errors** (trash + error), **Clear sent** (trash + check-all), **Clear all** (trash + layers) — and **Collapse all** / **Expand all** (the todo bar's icons). The tab says whether its run sends, waits or is paused and how many open items it has; the window's run is marked and selected first, and the selected tab is kept over a reload. Every item belongs to a run (the chip `run chg1` in its header, beside the todos chip): the run of the Proceed it was queued from, else the tab it was added in; its sessions are that run's (`<session>@<run>`). On a staged or pending item the run chip is a button: it lists the quest's other runs, and the item moves into the one you pick — to the end of that run's queue, its session becoming that run's (`<session>@<run>`), a *between iterations* or *let the next item go first* mark dropped. An item of a Proceed run stays in its run. A chat send shows in the tab of the run it ran in, else the default run's. A run deleted in the PROCESS view while it still has items keeps its tab, so you can still look at them: the tab is greyed and says **(deleted run)**, and a trash button beside it (*Remove this deleted run's queue: delete its items*) removes it. It asks first, with the number of items. When some items are not finished yet (staged, pending, sending), you choose: **Delete all** (a sending item is stopped) or **Delete only the finished items** (sent and failed; the others and the tab stay). Once the run's items are gone, its queue settings go too and the tab disappears. Creating a run with the same name again makes its tab a normal one again, with its old items and without the button. The headline, the compaction models and the tabs stay in view: only the part below the tabs scrolls, and each tab keeps its own scroll position, so you can switch runs and see their state from anywhere in a long list.
- **One lane per run**: each process run has its own lane — one item sends per lane at a time, the lanes send in parallel, and each run's items go in their order (a lane whose next item cannot start waits; its later items do not jump ahead), so a run's process-move marker moves it exactly when its own step is done. Two prompts never share a conversation: an item waits while another sending item runs in its session, and the Copilot transport sends one item at a time. A tab's play / pause is its run's auto-send: a paused run starts nothing, and its sending item stops before its next prompt (SENDING (PAUSED)). Chat sends are outside the lanes. `tomAi_listQueue` reports a run's settings (`run`, default the window's) and every run's auto-send (`runs`); the Status Page's *Queue & Timer* switches and Telegram's `queue_pause`, `halt` and `continue` act on the window's run unless a run is named.

## 5) Timed Requests

Timed requests fire prompts on a schedule or at regular intervals. Open the editor with `Ctrl+Shift+7` or `@T: Open Timed Requests`.

### Schedule Modes

- **Interval**: Fire every N minutes (configurable `intervalMinutes`)
- **Scheduled**: Fire at specific times (`HH:MM` format), optionally date-restricted

### Entry Fields

| Field | Description |
| --- | --- |
| Template | Prompt template to use |
| Answer wrapper | Whether to apply answer wrapper |
| Interval (minutes) | Time between fires (interval mode) |
| Scheduled times | Specific fire times (scheduled mode) |
| Repeat count | Number of times to repeat each fire |
| Repeat prefix/suffix | Text affixes per repetition |
| Send maximum | Maximum total fires before auto-pause |
| Sent count | Fires so far (tracking) |
| Answer wait (minutes) | Auto-advance timeout instead of answer file wait |
| Reminder | Template, timeout, enabled flag |

### Send Maximum and Auto-pause

When `sendMaximum` is set on an interval entry, the entry automatically pauses after `sentCount` reaches the limit. This prevents unbounded firing when the user is away.

### Global Schedule Slots

Timer entries respect global schedule slots that restrict when entries can fire:

- Day-of-week restrictions (weekday, specific days)
- Time-of-day windows (`timeFrom` / `timeTo`)
- Month filtering

### Tick Process

The timer engine ticks every 30 seconds. On each tick:

1. Checks global schedule slots
2. For each active entry, evaluates whether it should fire
3. Skips entries that already have a pending item in the queue (prevents duplicates)
4. Enqueues via the prompt queue manager (never sends directly)
5. Updates `lastSentAt`, `sentCount`, and persists state

## 6) Bridge operations

Bridge and automation commands:

- `@T: Restart Bridge`
- `@T: Switch Bridge Profile...`
- `@T: Start Tom CLI Integration Server`
- `@T: Stop Tom CLI Integration Server`
- `@T: Start Tom Process Monitor`

They need DartScript, the `tom_bs` bridge binary, for the platform the window runs on. A VSIX carries it only for the platform it was built on, and only when that build had a Dart SDK. Without it the bridge is not started (one line in the bridge log, no message), and every DartScript command — these, `@T: Execute File`, `@T: Execute as Script`, `@T: Toggle Bridge Debug Logging`, `@T: Print Configuration`, `@T: Run Tests`, Telegram `/bridge restart`, `/bridge mode` and `/cli-integration start` — stops with `"<feature> needs DartScript, which is not available on <platform>: the tom_bs binary is missing."` (its name and platform filled in) and a **What does this mean?** button that opens the Missing Dart Binaries page (§7). A `tom_bs` configured or copied in later works on the next `@T: Restart Bridge`, without a reload.

## 7) Status, config, and diagnostics

Use:

- `@T: Extension Status Page`
- `@T: Open Extension Settings`
- `@T: Open Config File`
- `@T: Toggle Bridge Debug Logging`

The Status Page opens with **Editors and pages**: every editor, page and viewer of the extension in four groups — Prompts & templates, Queue & automation, Quest & process, Trails, logs & setup — each with what it is for and an **Open** button (**Go to** for the ones that are sections of the Status Page itself, such as Telegram, the MCP server and Usage).

Its **Queue & Timer** section also holds **After Reload** (*Send prompt after reload*, stored for the current quest): when a window starts, the prompt is queued at the front of the window's run's queue, with that run's defaults (transport, profile, session, template), and sent as Continue sends it — also while the run is paused, without switching its auto-send on; while the run's lane is busy it waits until the running stage ends. The queue editor marks it **after reload**; a newer reload of the same window replaces an unsent one. It goes to Copilot only when the run's default transport is Copilot. The section also holds the reminder settings: the **Alive check** (On / Off, and after how many minutes without an answer a queue item gets a reminder prompt) and the **Default reminder template** of this window's run (the one a new queue item takes; *none* means the reminder default). **Edit templates** opens the Prompt Template Editor on the reminder templates; **Save** stores the timeout and the template. The bell button of the Prompt Queue and Timed Requests editors opens this place.

### VS Code settings (`tomAi.*`)

Most of the extension's configuration is in its config file (`@T: Open Config File`). The VS Code settings it contributes, each read by the extension:

| Setting | What it does |
| --- | --- |
| `tomAi.configPath` | The extension config file, for a layout without a root `.tom` (`~`, `${workspaceFolder}` and `${tomRoot}` resolved) |
| `tomAi.layout.root` | The root of the Tom workspace, absolute or relative to the workspace folder (the window's first folder); empty: the nearest folder above with `.tom/tom_root.yaml` |
| `tomAi.layout.aiFolder` | The `_ai` folder, absolute or relative to the workspace folder; empty: the workspace folder's `_ai`, else the root's |
| `tomAi.layout.configFolder` | The workspace folder's configuration folder (default `.tom`) |
| `tomAi.layout.guidelinesFolder` | The workspace folder's guidelines folder (default `_agent_guidelines`) |
| `tomAi.aiFolder` | Deprecated alias of `tomAi.layout.aiFolder`: the AI folder's name under the workspace folder |
| `tomAi.queueFolder` | The prompt queue's folder (default `${aiFolder}/queue`) |
| `tomAi.panelStoragePath` | The folder of the panels' local state files (default `${aiFolder}/local`, absolute or workspace-relative): the timed requests (`<host>_<workspace>.timed.yaml`), the chat variables (`<workspace>.chatvars.yaml`) and the chat panels' drafts (`<workspace>.<section>.prompt-panel.yaml`). The window state files stay in `${aiFolder}/local` (the config file's `windowStatus.localFolder`) |
| `tomAi.bridge.requestTimeout` | How long a Dart bridge request may take, ms (default 30 000, at least 1 000) |
| `tomAi.bridge.restartDelay` | The wait before the bridge restarts after it stopped, ms (default 5 000) |
| `tomAi.bridge.maxRestarts` | Automatic restarts in a row before the extension gives up (default 10; 0: none); the count starts again when the bridge answers, or when you start it |
| `tomAi.timedRequests.tickInterval` | How often the timed-request engine looks for due entries, ms (default 30 000, at least 1 000; read when the engine starts) |
| `tomAi.todo.workspaceTodoFile`, `tomAi.todo.questTodoPattern`, `tomAi.notes.questNotesPattern` | The files of the WORKSPACE TODOS, QUEST TODOS and quest-notes views |
| `tomAi.guidelines.excludeGlobs` | Projects the Guidelines panel's Project list leaves out (default `tom/zom_*/**`) |

The trail is switched on and off on the Status Page (the config file's `trail.raw.enabled`), not by a VS Code setting.

### Provider SDKs

The extension does not carry the model providers' SDKs; it installs them on request into its own storage, where they stay across extension updates. **`@T: Provider SDKs`** (also the **Provider SDKs** button in the Status Page's first section, which names the providers installed) opens the page:

- a row per provider with a checkbox, the installed versions and the versions this build is tested with; check or uncheck and click **Install / Uninstall**;
- **Check for updates** asks the npm registry for newer releases; a provider with one shows **update to …** (with *(new major)* when the API may change), which installs it; **Update all** installs every update found; **install this build's versions** goes back. Nothing updates by itself;
- the log of the last run and its outcome.

When no provider is installed, the page opens when the extension starts. The **Anthropic** provider is the direct API SDK (`@anthropic-ai/sdk`, also used by history compaction and memory extraction) and the Agent SDK with its Claude CLI for this platform — on Linux the glibc or the musl CLI, whichever C library the machine has (musl only where the musl loader `/lib/ld-musl-*.so.1` is, as on Alpine). An install downloads the packages from the npm registry (no npm or Node needed), checks each one's integrity, and is used by the next prompt without a reload. The 🤖 dot of the ANTHROPIC/LLM panel shows whether the Agent SDK and its CLI are installed.

### Missing binaries on this platform

Features that run programs a VSIX carries only for some platforms: DartScript (`tom_bs`), and CodeSpecs validation and mapping and the TomSpecs process checks (`tomspecs`, tom_specs_clitool's binary). The extension checks them when it starts, for the platform it runs on, so the same VSIX gives the right answer on every machine. The Anthropic transports need the provider SDKs, which no VSIX carries: see [Provider SDKs](#provider-sdks).

- **`@T: Missing Dart Binaries (DartScript / CodeSpecs validation)`** opens a page filled for this machine: what is missing, what does not work and what keeps working, how to install the Dart SDK, how to build the binaries there, and how to configure prebuilt ones (`bridge.executables.tom_bs` / `bridge.executables.tomspecs` per platform in `.tom/tom_vscode_extension.json`) or copy them into the extension's `bin/<platform>/`. It opens by itself once per extension build and platform when a binary is missing.
- The status bar shows **Dart binaries missing** while one is; a click opens the page.
- The Status Page has a **Dart binaries** section: the platform, each binary as *configured*, *bundled* or *missing* (warned), and **Open the page**. The bridge row says *Not available (tom_bs missing)* instead of *Disconnected*.
- CodeSpecs mapping (`tomAi_specCodeSpecsMap`) needs no Dart SDK: the bundled `tomspecs` (`:ir-map`) formats what the Dart + Tom mapper writes itself, in the layout `dart format` gives.
- Without `tomspecs`, `tomAi_specCodeSpecsValidate` answers that it is missing; Trace and Status skip validation and a warning `"CodeSpecs validation skipped: tomspecs is not available on <platform>."` with **What does this mean?** shows once per tool and window session.
- **`@T: Missing Agent SDK (provider SDK or Claude CLI not installed)`**: without the Anthropic provider (or with no Claude CLI for this platform) an Anthropic prompt fails before it runs, and the error (once per window session) has **Install provider SDKs** (the Provider SDKs page) and **What does this mean?** (this page).

WINDOW STATUS marks a window with **no Dart binaries**; agents read the same as `dartBinaries` in `tomAi_getWorkspaceInfo` and `tomAi_getQuestWindowStatus`.

### Todo buttons

The Status Page's **Todo buttons** section chooses the templates the todo detail's **Send** / **Queue** buttons wrap a todo in: one for todos marked 👤 user action (also used by the **Guide me** buttons; *(default: Guide me through a user action)*), one for every other todo (*(default: Execute TODO)*). Both dropdowns offer the Anthropic templates; ✏️ opens the template the row runs in the Global Template Editor (category *Anthropic — User Message*); **Save Todo Buttons** stores the choices (`anthropic.todoButtonTemplates`).

### Assist prompts

The prompts the extension runs to help you are templates of one category, **Assist Prompts**, in the Global Template Editor (`@T: Open Prompt Template Editor`): **Grill me** and **Explain in detail** on an open question in the MD Browser, **Explain a decision** and **Grill me at a decision** at a process decision (the Decide… dialog), **Finish review round** at a review, **Gate decision** at the end of a gate's prompt (`${gate-decision}`), **Out of budget** — the prompt a queue item continues with on another profile when its profile ran out of credit — and **Background work reminder** — the prompt a queue turn gets when it ends its answer while its own background work still runs (an empty template sends none). Eight default templates of those names are put into the config when a window starts (`assistPrompts.templates`, ids `grill-me`, `explain-in-detail`, `explain-decision`, `grill-me-decision`, `finish-review-round`, `gate-decision`, `out-of-budget`, `background-work-reminder`); an edited one is kept, an unedited earlier default is brought to the current one.

Which template each use runs is chosen on the Status Page, section **Assist prompts**: one row per use with a dropdown — *(default: …)* runs the use's default template — and ✏️ (opens the template the row runs in the editor), ➕ (a new template) and 🗑️ (deletes the chosen template; the uses that chose it run their default again); **Save Assist Prompts** stores the choices (`assistPrompts.selected`). Each use fills its own placeholders before the prompt expands as any prompt does; the editor lists them under the template — Out of budget's are the stopped profile (`${stoppedProfile}`, `${stoppedProfileId}`), its model (`${stoppedModel}`), session (`${stoppedSession}`), the time it stopped (`${stoppedAt}`), the API's message (`${budgetMessage}`), the session's live trail (`${liveTrail}`), the profile it continues on (`${toProfile}`, `${runsInSession}`, `${sessionNote}`) and the original prompt (`${originalPrompt}`); Background work reminder's are the work still running (`${backgroundWork}`, one line each with id, command and output file), when the wait began (`${waitingSince}`) and its limit in minutes (`${limitMinutes}`).

## 8) Output Channels

The extension provides dedicated output channels for observability:

| Channel | Source | Purpose |
| --- | --- | --- |
| Tom Prompt Queue | `promptQueueManager.ts` | Queue state changes, send events (each naming where the prompt goes: `via copilot`, or `via anthropic (profile …, session …)`), answer detection, watchdog health checks |
| Tom Timed Requests | `timerEngine.ts` | Tick heartbeats, fire decisions, schedule evaluation, entry lifecycle |
| Tom Extension Debug Log | `debugLogger.ts` | General debug logging across all categories |
| Tom Tests | `tests.ts` | Test execution output |
| Tom Dartbridge Log | `vscode-bridge.ts` | Bridge communication logs |
| Tom Tool Log | `toolLog.ts` | Tool invocation logs (one line per agent tool call) |
| Tom AI Anthropic Chat | `anthropic-output-channels.ts` | Anthropic turns |
| Tom AI Anthropic Chat Responses | `anthropic-output-channels.ts` | Anthropic response content |
| Tom AI Compaction and Memory Extraction | `compaction-log.ts` | History compaction and memory extraction passes |
| Tom AI: MCP Server | `mcpServerLog.ts` | MCP server requests |
| Tom AI Local Log | `localLlm-handler.ts` | Local LLM debug output (endpoint, timing, retries) |

The Tom Extension Debug Log is also written to
`ztmp/tom_extension_debug.<quest>.log` in the workspace, one file per quest
window, started afresh when the window activates. Its start-up lines show why a
panel was slow to appear: how long each step of the activation took, when each
view was resolved and first shown (`webview.startup`), every time the extension
host was busy for 250 ms or more in the first two minutes (`extension.startup`,
whichever extension held it), and every panel message that took 500 ms or more
to handle.

Queue and timed request channels include ISO timestamps on every log line and can be enabled/disabled at runtime.

## 9) Trails and history

Every Anthropic session — `chat` (the panel), `default` (the queue) and every named one — keeps all it writes in its own folder, `_ai/quests/<quest>/history/sessions/<session>/`:

- **History** — `compacted_history.md`, `history.json` (+ `history.md` rendering), `rawTurns.json`, `compaction_rounds.json`. Rolling compacted context used by `trim_and_summary`; read back from the same folder. SDK-managed mode keeps the conversation in the Agent SDK, its id in `<session>.session.json`.
- **Trail pair** — `<quest>.anthropic.prompts.md` / `.answers.md`, the session's prompts and answers; **Recreate history** and **Recreate memory** rebuild from this session's own pair.
- **Live trail** — `live-trail.md`. Rolling-window markdown (last 5 prompt blocks; a prompt header quoted inside a tool result does not count). Streams thinking / tool_use / tool_result / assistant-text events as they arrive. Best viewed via the live-trail action in the @CHAT Logs section (for the session selected there; the MD Browser in live mode follow-tails the file).
- **Raw trail** — `trail/`. Every turn produces `<ts>_prompt_<rid>.userprompt.md`, `<ts>_payload_<rid>.payload.md`, `<ts>_answer_<rid>.answer.json`, plus tool request / answer files; `compaction/` and `memory/` hold the background passes, `tool_results/t<n>.json` the session's tool results (keys continue past what is stored, so nothing is overwritten). Inspect via the Raw Trail Viewer editor.
- **Quest memory** — `_ai/memory/<quest>/<session>/`; `${memory}` and the memory tools use the running session's, plus `_ai/memory/shared/`.
- **Retention** — the raw trail keeps at most **Max raw files per folder** (Status Page, Trail; default 1000) in `trail/`, `compaction/` and `memory/` each. The stored tool results (`tool_results/t<n>.json`) are pruned after each send: older than **Stored tool results — keep days** (default 30) or beyond **at most per session** (default 1000, the newest kept) go; 0 switches a limit off. `tomAi_readPastToolResult` answers a pruned key *pruned by retention*. `rawTurns.json` and `compaction_rounds.json` are the conversation itself and are kept bounded by compaction.

Git tracks a session's `compacted_history.md`, snapshot and `live-trail.md`; the rest is machine-local. On a quest's first use a window moves its files from the older per-quest layout (`history/`, the quest folder's `live-trail.md`, `_ai/trail/anthropic/<quest>/`, `_ai/memory/<quest>/`) into the `default@default` session (the default run's default session), once per machine.

**Choosing the sessions.** Every button that works on this storage asks which sessions first: a multi-select of the quest's sessions (the SESSIONS view's list — `default@default`, `chat`, the session files, temporary ones marked, and storage left without a file) with **All sessions** on top and the panel's session preselected. That holds for the subpanel's **Recreate history** and **Recreate memory** — both then confirm, naming the sessions — and for the panel's **Recreate** actions. **Open session history**, **Open live trail**, the summary trail, the raw trail, the memory panel and **Clear** are in the @CHAT Logs panel behind its session switch and work on the session selected there (Clear asks first). The Status Page's compaction **Dry Run** (each chosen session's rolling history) and **Trail Viewer**, the memory panel (its **Session** button: whose quest memory it shows and edits) and the command `Tom AI: Migrate compaction format` (the chosen sessions in every quest; **All sessions** means every session of every quest) ask the same way. To clear the queue's `default` session, use **Clear** in the Logs section with `default` selected, or **Reset** on its row in the SESSIONS view.

## 10) Keyboard productivity

See [quick_reference.md](quick_reference.md) for every keybinding and the commands they run.

**Completion in prompt fields.** `Ctrl+Shift+Space` in a prompt field (the @CHAT panels, the Queue Editor's add form, timed requests, notes): after `/` it offers the **slash commands** (`.claude/commands/<name>.md`, a sub-folder making `/<folder>:<name>`) and the **skills** (`.claude/skills/`) of the workspace and its parent folders, after `@` the **files of the quest folder** (`_ai/quests/<quest>/`) — no queue files, other quests or code: your own files first (those open in an editor at the top), then the technical ones (the `history/` folder, `extension_config.*`, `process-state.*`, session files, archived and deleted todos). With no quest open it offers the workspace's files. Choosing a command asks for its arguments (its `argument-hint` shown) and inserts its prompt with them filled in — `$ARGUMENTS` the whole text, `$1` … `$9` the words (quotes keep words together); a command without placeholders gets them appended as `ARGUMENTS: …`. Escape on the question inserts nothing.

## 11) Reinstall and reload

If extension changes do not appear:

1. reinstall the extension package in the target VS Code host,
2. reload window,
3. rerun the affected command.

Building and installing the package is described in the extension README's
Installation section.
