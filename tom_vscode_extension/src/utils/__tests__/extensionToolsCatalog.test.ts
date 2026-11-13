/**
 * The overview of every editor and page (src/utils/extensionToolsCatalog.ts, vscimpb73).
 *
 *   TC-1 package.json: every `tomAi.editor.*` / `tomAi.panel.*` command and every page command is in the catalogue
 *        or excluded with a reason; every command the catalogue runs is contributed; an exclusion is not also listed
 *   TC-2 the catalogue: ids unique, the four groups in the decided order (Prompts & templates, Queue & automation,
 *        Quest & process, Trails, logs & setup) each with entries, every entry a command or a Status Page section
 *        (one of the two), a purpose of one line; every section an entry names exists on the page
 *   TC-3 the rendered section: at the top of the Status Page, the Editors section it replaces gone; every entry with
 *        its purpose and an Open / Go to button; the page's action opens by id (the host looks the command up)
 *   TC-4 in the page: Open posts `openExtensionTool` with the entry's id; Go to opens a collapsed section and scrolls
 *        to it; `tomAi.statusPage <section>` reveals one after the page has rendered (revealSection)
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { CATALOG_EXCLUDED_COMMANDS, EXTENSION_TOOLS, TOOL_GROUPS, extensionToolsOverviewHtml, toolById, toolsOfGroup } from '../extensionToolsCatalog.js';

const ROOT = join(__dirname, '..', '..', '..');
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf-8');
const pkg = JSON.parse(read('package.json')) as { contributes: { commands: Array<{ command: string; title: string }> } };
const contributed = new Set(pkg.contributes.commands.map((c) => c.command));

/** The page commands besides the `tomAi.editor.*` / `tomAi.panel.*` ones: they open a page, a guide or a setup flow. */
const PAGE_COMMANDS = [
    'tomAi.statusPage', 'tomAi.providerSdks', 'tomAi.createQuest', 'tomAi.setupWorkspaceFolder', 'tomAi.showDartBinariesHelp',
    'tomAi.showAgentSdkCliHelp', 'tomAi.openConfig', 'tomAi.openSettings', 'tomAi.showHelp', 'tomAi.showQuickReference',
    'tomAi.openInMdBrowser', 'tomAi.openInMdViewer', 'tomAi.process.startNested',
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

describe('the overview of editors and pages', () => {
    test('TC-1: package.json and the catalogue agree', () => {
        const catalogued = new Set(EXTENSION_TOOLS.map((t) => t.command).filter((c): c is string => !!c));
        const pages = [...contributed].filter((c) => /^tomAi\.(editor|panel)\./.test(c)).concat(PAGE_COMMANDS);
        for (const c of pages) {
            assert.ok(contributed.has(c), `${c} is contributed`);
            assert.ok(catalogued.has(c) || c in CATALOG_EXCLUDED_COMMANDS, `${c}: in the catalogue or excluded with a reason`);
        }
        for (const c of catalogued) { assert.ok(contributed.has(c), `${c}, which the catalogue runs, is contributed`); }
        for (const [c, why] of Object.entries(CATALOG_EXCLUDED_COMMANDS)) {
            assert.ok(contributed.has(c), `${c} (excluded) is contributed`);
            assert.ok(!catalogued.has(c), `${c} is excluded and listed`);
            assert.ok(why.length > 10, `${c}: a reason`);
        }
    });

    test('TC-2: the catalogue', () => {
        const ids = EXTENSION_TOOLS.map((t) => t.id);
        assert.equal(new Set(ids).size, ids.length, 'unique ids');
        assert.deepEqual(TOOL_GROUPS.map((g) => g.label), ['Prompts & templates', 'Queue & automation', 'Quest & process', 'Trails, logs & setup']);
        for (const g of TOOL_GROUPS) { assert.ok(toolsOfGroup(g.id).length > 0, `${g.label} has entries`); }
        assert.deepEqual(toolsOfGroup('prompts').map((t) => t.id),
            ['promptTemplates', 'queueTemplates', 'reusablePrompts', 'groupPrompts', 'processTemplates', 'assistPrompts']);
        assert.deepEqual(toolsOfGroup('queue').map((t) => t.id), ['promptQueue', 'timedRequests', 'providerSdks', 'telegram', 'reminders', 'mcpServer']);
        assert.ok(['process', 'processBranching', 'chatVariables', 'memory', 'createQuest', 'setupWorkspaceFolder']
            .every((id) => toolById(id)?.group === 'quest'));
        assert.ok(['rawTrailViewer', 'summaryTrailViewer', 'mdBrowser', 'openConfig', 'openSettings', 'quickReference', 'help', 'dartBinariesHelp', 'statusPage']
            .every((id) => toolById(id)?.group === 'trails'));
        const pageSource = read('src', 'handlers', 'statusPage-handler.ts') + read('src', 'utils', 'mcpServerCard.ts') + read('src', 'utils', 'usageSection.ts') + read('src', 'utils', 'reminderSettingsSection.ts');
        for (const t of EXTENSION_TOOLS) {
            assert.ok(!!t.command !== !!t.statusSection, `${t.id}: a command or a section`);
            assert.ok(t.purpose && !t.purpose.includes('\n'), `${t.id}: one line`);
            if (t.statusSection) {
                assert.ok(pageSource.includes(`id="sp-${t.statusSection}-content"`) || pageSource.includes(`data-section="${t.statusSection}"`),
                    `${t.id}: the section ${t.statusSection} is on the page`);
            }
        }
    });

    test('TC-3: the rendered section, at the top of the page', () => {
        const html = extensionToolsOverviewHtml();
        for (const t of EXTENSION_TOOLS) {
            assert.ok(html.includes(`data-tool="${t.id}"`), t.id);
        }
        assert.equal((html.match(/data-status-action="openExtensionTool"/g) ?? []).length, EXTENSION_TOOLS.filter((t) => t.command).length);
        assert.equal((html.match(/data-sp-jump=/g) ?? []).length, EXTENSION_TOOLS.filter((t) => t.statusSection).length);
        const handler = read('src', 'handlers', 'statusPage-handler.ts');
        assert.match(handler, /<div class="sp-panel">\s*\$\{extensionToolsOverviewHtml\(\)\}/, 'first on the page');
        assert.doesNotMatch(handler, /data-collapse="editors"/, 'the old Editors section is gone');
        assert.match(handler, /case 'openExtensionTool': \{\s*const tool = toolById\(String\(message\?\.toolId \?\? ''\)\);/, 'by id');
        assert.match(handler, /await vscode\.commands\.executeCommand\(tool\.command\);/);
        assert.match(read('src', 'extension.ts'), /'tomAi\.statusPage',[\s\S]{0,200}showStatusPageHandler\(typeof section === 'string' \? section : undefined\)/);
    });

    test('TC-4: in the page', () => {
        const dom = new JSDOM(`<!DOCTYPE html><body><div class="sp-panel">${extensionToolsOverviewHtml()}
            <div class="sp-section"><div class="sp-section-header sp-collapsible" data-collapse="telegram"><span class="sp-section-title"><span class="sp-collapse-icon">▶</span> Telegram</span></div>
            <div class="sp-collapse-content sp-collapsed" id="sp-telegram-content">bot</div></div>
            <div class="sp-section" data-section="usage">Usage</div></div></body>`, { runScripts: 'outside-only' });
        const window = dom.window as Win;
        const posted: Array<Record<string, unknown>> = [];
        window.vscode = { postMessage: (m: Record<string, unknown>) => { posted.push(m); } };
        const scrolled: string[] = [];
        window.HTMLElement.prototype.scrollIntoView = function (this: Win) { scrolled.push(this.textContent.trim().slice(0, 20)); };
        window.eval(read('media', 'statusPage', 'listeners.js'));
        window.eval('attachStatusPanelListeners(true)');
        window.document.querySelector('[data-tool-id="promptQueue"]').click();
        assert.deepEqual(JSON.parse(JSON.stringify(posted.at(-1))), { type: 'statusAction', action: 'openExtensionTool', toolId: 'promptQueue' });
        window.document.querySelector('[data-sp-jump="telegram"]').click();
        const content = window.document.getElementById('sp-telegram-content');
        assert.equal(content.classList.contains('sp-collapsed'), false, 'opened');
        assert.equal(content.previousElementSibling.querySelector('.sp-collapse-icon').textContent, '▼');
        assert.ok(scrolled.some((s) => s.includes('Telegram')), 'scrolled to');
        window.eval("spRevealSection('usage')");
        assert.ok(scrolled.some((s) => s.startsWith('Usage')), 'a section marked data-section');
        assert.match(read('media', 'statusPage', 'main.js'), /msg\.type === 'revealSection' && typeof spRevealSection === 'function'/);
    });
});
