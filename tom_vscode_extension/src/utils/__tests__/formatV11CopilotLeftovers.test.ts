/**
 * Format version 11, step `copilot-leftovers` (src/utils/formatV11/copilotLeftovers.ts): what the Copilot
 * transport, the answer wrapper and the reminders left in stored files (ai_format_migration.md § 3.6, § 3.7).
 *
 *   CL-1 a dry run lists every rewrite and deletion (queue entries and templates, queue settings, timed requests,
 *        the configuration, the quests' extension configs, the drafts, the chat variables' change log, the
 *        folders nothing writes) and writes nothing
 *   CL-2 applied: `transport: copilot` is `anthropic` (main, pre-prompt, follow-up, last dispatch), the dropped
 *        keys are gone, `__answer_file__` is `(None)`, a reminder item is deleted, the settings keys are gone at
 *        every level, the timed requests are clean, the configuration sections are gone, the Copilot draft and
 *        the Copilot folders and trail pairs are deleted, `source: copilot` is `agent`; everything else stays
 *   CL-3 a second run lists nothing
 *   CL-4 layout: the user overlay and a quest config keep their comments and the text of every value not
 *        changed; a queue entry keeps its schema line and its folded text; a file without leftovers is not
 *        rewritten; a section the step empties goes with it
 *   CL-5 an unreadable queue entry holding a leftover is a problem and stays as it is; one holding none is left
 *        alone
 *   CL-6 through migrateAiFormats (format version 11): the step runs, the stamp is written, a second run lists
 *        nothing of it
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse } from 'yaml';

import { migrateAiFormats } from '../aiFormatMigration';
import { dropCopilotConfig, migrateV11CopilotLeftovers } from '../formatV11/copilotLeftovers';
import type { V11Context, V11Step } from '../formatV11/context';

interface Entry { quest: string; step: V11Step | string; detail: string }

/* eslint-disable @typescript-eslint/naming-convention -- the stored files' keys as they are */

const LONG = 'Do the quest todo x1 — a long prompt text that is folded by the queue writer because it is longer than '
    + 'the line width of one hundred and twenty characters, and stays the same text after the rewrite.';

const CUT = LONG.lastIndexOf(' ', 100);

const ENTRY = `# yaml-language-server: $schema=../schemas/yaml/queue-entry.schema.json
meta:
  id: a1
  quest: qa
  status: sent
  main-prompt: P1
prompt-queue:
  - id: P1
    name: Main Prompt
    type: main
    prompt-text: >-
      ${LONG.slice(0, CUT)}
      ${LONG.slice(CUT + 1)}
    template: __answer_file__
    answer-wrapper: true
    answer-wait-minutes: 5
    transport: copilot
    pre-prompt-refs:
      - PRE1
    follow-up-refs:
      - FU1
    reminder:
      enabled: false
      template-id: __none__
      repeat: false
      sent-count: 0
      last-sent-at: null
      queued: false
    execution:
      request-id: null
      expected-request-id: r-2
      sent-at: 2026-11-25T10:00:00.000Z
      error: null
      last-dispatched:
        kind: main
        expanded-text: hello
        transport: copilot
        dispatched-at: 2026-11-25T10:00:00.000Z
  - id: PRE1
    type: preprompt
    prompt-text: before
    transport: copilot
    answer-template: __answer_file__
  - id: FU1
    type: followup
    prompt-text: after
    transport: anthropic
    reminder:
      enabled: true
`;

const REMINDER_ENTRY = `meta:
  id: r1
  status: pending
  type: reminder
prompt-queue:
  - id: P1
    type: main
    prompt-text: Are you still there?
`;

const CLEAN_ENTRY = `meta:
  id: c1
  status: staged
prompt-queue:
  - id: P1
    type: main
    prompt-text:   "kept as written"
    transport: anthropic
`;

const TEMPLATE = `meta:
  id: t1
  name: tpl
prompt-queue:
  - id: P1
    type: main
    prompt-text: from a template
    transport: copilot
    answer-wrapper: false
`;

const SETTINGS = `auto-send-enabled: true
response-timeout-minutes: 60
default-transport: copilot
default-reminder-template-id: __none__
default-anthropic-profile-id: p1
runs:
  default:
    auto-send-enabled: false
    default-transport: anthropic
runs-by-quest:
  qa:
    default:
      response-timeout-minutes: 60
      default-transport: anthropic
      default-reminder-template-id: __none__
      walk-continuations: 2
    collab:
      default-transport: anthropic
      default-role: reviewer
`;

const TIMED = `$schema: ../../.tom/json-schema/panels/timed.schema.json
updated: 2026-11-25T10:00:00.000Z
timerActivated: true
entries:
  - id: e1
    enabled: true
    template: __answer_file__
    originalText: ping
    scheduleMode: interval
    intervalMinutes: 30
    answerWrapper: true
    answerWaitMinutes: 10
    reminderEnabled: false
    reminderTemplateId: default
    reminderTimeoutMinutes: 5
    reminderRepeat: false
    status: active
`;

const CHAT_VARIABLES = `quest: qa
custom:
  TODO: x1
changeLog:
  - timestamp: 2026-11-25T10:00:00.000Z
    key: TODO
    oldValue: ""
    newValue: x1
    source: copilot
  - timestamp: 2026-11-25T10:01:00.000Z
    key: TODO
    oldValue: x1
    newValue: x2
    source: user
`;

const PANELS = `sections:
  copilot:
    text: draft
  anthropic:
    text: kept
`;

const USER_OVERLAY = `# my overlay
userName: me # who I am

# the Copilot answer wrapper
copilot:
  queueWrapper: wrap
reminders:
  config:
    enabled: true
trail:
  raw:
    # where the raw trail goes
    paths:
      anthropic: \${ai}/trail/anthropic/\${quest}
      copilot: \${ai}/trail/copilot/\${quest}
`;

const QUEST_SHARED = `# the shared config
telegram:
  defaultChatId: 1
copilot:
  answerFolder: x
`;

const QUEST_HOST = `questRefresh:
  panels:
    anthropic:
      active: true
      count: 3
    copilot:
      active: false
      count: 0
aspectGuidelines:
  # the chat panels' choices
  chat:
    copilot:
      language: en
    anthropic:
      language: de
cliServer:
  autostart: false
`;

const QUEST_OTHER_HOST = `questRefresh:
  panels:
    copilot:
      active: false
      count: 0
cliServer:
  autostart: true
`;

const WORKSPACE_CONFIG = {
    userName: 'me',
    copilot: { queueWrapper: 'wrap' },
    reminders: { templates: [] },
    questRefresh: { anthropic: { interval: 5 }, copilot: { interval: 3 } },
    trail: { raw: { enabled: true, paths: { anthropic: 'a', copilot: 'c' } } },
    timedRequests: [{ id: 't1', template: '__answer_file__', answerWrapper: true, reminderEnabled: true, originalText: 'x' }, { id: 't2', template: 'Review' }],
};

function sandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v11-copilot-'));
    const ai = path.join(root, '_ai');
    fs.mkdirSync(path.join(ai, 'quests'), { recursive: true });
    const write = (rel: string, text: string): string => {
        const p = path.join(ai, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, text);
        return p;
    };
    const exists = (rel: string): boolean => fs.existsSync(path.join(ai, rel));
    const read = (rel: string): string => fs.readFileSync(path.join(ai, rel), 'utf8');
    const workspaceConfigPath = path.join(root, '.tom', 'tom_vscode_extension.json');
    const userConfigPath = path.join(root, 'user', 'tom_vscode_extension.user.yaml');
    const step = (apply: boolean): { changes: Entry[]; problems: Entry[] } => {
        const changes: Entry[] = [];
        const problems: Entry[] = [];
        const quests = fs.readdirSync(path.join(ai, 'quests')).sort();
        const ctx: V11Context = {
            aiRoot: ai, hostSlug: 'mbp', apply, quests, allQuests: quests,
            workspaceConfigPath: fs.existsSync(workspaceConfigPath) ? workspaceConfigPath : undefined,
            userConfigPath: fs.existsSync(userConfigPath) ? userConfigPath : undefined,
            change: (quest, s, detail) => changes.push({ quest, step: s, detail }),
            problem: (quest, s, detail) => problems.push({ quest, step: s, detail }),
            rel: (p) => path.relative(ai, p).split(path.sep).join('/'),
        };
        migrateV11CopilotLeftovers(ctx);
        return { changes, problems };
    };
    return { root, ai, write, exists, read, step, workspaceConfigPath, userConfigPath };
}

/** Every leftover kind of the step, and files that stay. */
function fixture(s: ReturnType<typeof sandbox>): void {
    s.write('queue/mbp_ws_1_qa.normal.entry.queue.yaml', ENTRY);
    s.write('queue/mbp_ws_2_qa.reminder.entry.queue.yaml', REMINDER_ENTRY);
    s.write('queue/mbp_ws_3_qa.normal.entry.queue.yaml', CLEAN_ENTRY);
    s.write('queue/tpl.template.queue.yaml', TEMPLATE);
    s.write('queue/queue-settings.yaml', SETTINGS);
    s.write('local/mbp_ws.timed.yaml', TIMED);
    s.write('local/ws.copilot.prompt-panel.yaml', 'text: draft\n');
    s.write('local/ws.anthropic.prompt-panel.yaml', 'text: kept\n');
    s.write('local/ws.panels.yaml', PANELS);
    s.write('chat_variables/ws.mbp.chatvariable.yaml', CHAT_VARIABLES);
    s.write('answers/copilot/1_answer.json', '{}');
    s.write('answers/other.md', 'stays\n');
    s.write('trail/copilot/qa/1.userprompt.md', 'p');
    s.write('trail/anthropic/qa/1.userprompt.md', 'stays');
    s.write('quests/qa/history/qa.copilot.prompts.md', 'p');
    s.write('quests/qa/history/qa.copilot.answers.md', 'a');
    s.write('quests/qa/history/qa.anthropic.prompts.md', 'stays');
    s.write('quests/qa/config/extension_config.qa.yaml', QUEST_SHARED);
    s.write('quests/qa/config/extension_config.mbp.qa.yaml', QUEST_HOST);
    s.write('quests/qa/config/extension_config.big.qa.yaml', QUEST_OTHER_HOST);
    fs.mkdirSync(path.dirname(s.workspaceConfigPath), { recursive: true });
    fs.writeFileSync(s.workspaceConfigPath, JSON.stringify(WORKSPACE_CONFIG, null, 4) + '\n');
    fs.mkdirSync(path.dirname(s.userConfigPath), { recursive: true });
    fs.writeFileSync(s.userConfigPath, USER_OVERLAY);
}

/** Every file below `dir` with its text. */
function snapshot(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (d: string): void => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { walk(p); } else { out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8'); }
        }
    };
    walk(dir);
    return out;
}

describe('format version 11: the Copilot and reminder leftovers', () => {
    test('CL-1: a dry run lists, writes nothing', () => {
        const s = sandbox();
        fixture(s);
        const before = snapshot(s.root);
        const { changes, problems } = s.step(false);
        assert.deepEqual(problems, []);
        assert.ok(changes.every((c) => c.step === 'copilot-leftovers'));
        const said = (re: RegExp): boolean => changes.some((c) => re.test(c.detail));
        for (const re of [
            /^queue\/mbp_ws_1_qa\.normal\.entry\.queue\.yaml: .*transport copilot as anthropic \(2\).*drop answer-wrapper.*drop reminder \(2\).*template __answer_file__ as \(None\).*drop execution\.request-id.*execution\.last-dispatched\.transport copilot as anthropic/,
            /^delete queue\/mbp_ws_2_qa\.reminder\.entry\.queue\.yaml \(a reminder item \(pending\)/,
            /^queue\/tpl\.template\.queue\.yaml: transport copilot as anthropic; drop answer-wrapper$/,
            /^queue\/queue-settings\.yaml: .*drop default-transport.*drop runs\.<run>\.default-transport.*drop runs-by-quest\.<quest>\.<run>\.default-transport \(2\)/,
            /^local\/mbp_ws\.timed\.yaml: drop answerWrapper; drop answerWaitMinutes; .*template __answer_file__ as \(None\)$/,
            /^delete local\/ws\.copilot\.prompt-panel\.yaml/,
            /^local\/ws\.panels\.yaml: drop sections\.copilot/,
            /^chat_variables\/ws\.mbp\.chatvariable\.yaml: change source copilot as agent \(1\)$/,
            /^delete answers\/copilot\//, /^delete trail\/copilot\//,
            /^delete quests\/qa\/history\/qa\.copilot\.prompts\.md/, /^delete quests\/qa\/history\/qa\.copilot\.answers\.md/,
            /^quests\/qa\/config\/extension_config\.qa\.yaml: remove copilot$/,
            /^quests\/qa\/config\/extension_config\.mbp\.qa\.yaml: remove questRefresh\.panels\.copilot; remove aspectGuidelines\.chat\.copilot$/,
            /^quests\/qa\/config\/extension_config\.big\.qa\.yaml: remove questRefresh\.panels\.copilot$/,
            /tom_vscode_extension\.json: remove copilot; remove reminders; remove questRefresh\.copilot; remove trail\.raw\.paths\.copilot; drop timed answerWrapper; drop timed reminderEnabled; timed template __answer_file__ as \(None\)$/,
            /tom_vscode_extension\.user\.yaml: remove copilot; remove reminders; remove trail\.raw\.paths\.copilot$/,
        ]) {
            assert.ok(said(re), `listed: ${re}\n${changes.map((c) => c.detail).join('\n')}`);
        }
        assert.equal(changes.filter((c) => /mbp_ws_3_qa|anthropic\.prompt-panel|answers\/other|trail\/anthropic|qa\.anthropic/.test(c.detail)).length, 0, 'what stays is not listed');
        assert.deepEqual(snapshot(s.root), before, 'nothing written');
    });

    test('CL-2 / CL-3: applied, then nothing left', () => {
        const s = sandbox();
        fixture(s);
        const { problems } = s.step(true);
        assert.deepEqual(problems, []);

        const entry = parse(s.read('queue/mbp_ws_1_qa.normal.entry.queue.yaml'));
        const [main, pre, fu] = entry['prompt-queue'];
        assert.equal(main.transport, 'anthropic');
        assert.equal(main.template, '(None)');
        for (const key of ['answer-wrapper', 'answer-wait-minutes', 'reminder']) { assert.equal(key in main, false, key); }
        assert.deepEqual(Object.keys(main.execution), ['sent-at', 'error', 'last-dispatched']);
        assert.equal(main.execution['last-dispatched'].transport, 'anthropic');
        assert.equal(main['prompt-text'], LONG, 'the text as it was');
        assert.equal(pre.transport, 'anthropic');
        assert.equal('answer-template' in pre, false);
        assert.equal(fu.transport, 'anthropic');
        assert.equal('reminder' in fu, false);
        assert.equal(s.exists('queue/mbp_ws_2_qa.reminder.entry.queue.yaml'), false, 'the reminder item is gone');
        assert.deepEqual(parse(s.read('queue/tpl.template.queue.yaml'))['prompt-queue'][0], { id: 'P1', type: 'main', 'prompt-text': 'from a template', transport: 'anthropic' });

        assert.deepEqual(parse(s.read('queue/queue-settings.yaml')), {
            'auto-send-enabled': true, 'default-anthropic-profile-id': 'p1',
            runs: { default: { 'auto-send-enabled': false } },
            'runs-by-quest': { qa: { default: { 'walk-continuations': 2 }, collab: { 'default-role': 'reviewer' } } },
        });
        const timed = parse(s.read('local/mbp_ws.timed.yaml'));
        assert.deepEqual(timed.entries[0], { id: 'e1', enabled: true, template: '(None)', originalText: 'ping', scheduleMode: 'interval', intervalMinutes: 30, status: 'active' });
        assert.equal(timed.$schema, '../../.tom/json-schema/panels/timed.schema.json');

        assert.equal(s.exists('local/ws.copilot.prompt-panel.yaml'), false);
        assert.equal(s.read('local/ws.anthropic.prompt-panel.yaml'), 'text: kept\n');
        assert.deepEqual(parse(s.read('local/ws.panels.yaml')), { sections: { anthropic: { text: 'kept' } } });
        assert.deepEqual(parse(s.read('chat_variables/ws.mbp.chatvariable.yaml')).changeLog.map((e: { source: string }) => e.source), ['agent', 'user']);

        assert.equal(s.exists('answers/copilot'), false);
        assert.equal(s.read('answers/other.md'), 'stays\n');
        assert.equal(s.exists('trail/copilot'), false);
        assert.equal(s.exists('trail/anthropic/qa/1.userprompt.md'), true);
        assert.equal(s.exists('quests/qa/history/qa.copilot.prompts.md'), false);
        assert.equal(s.exists('quests/qa/history/qa.copilot.answers.md'), false);
        assert.equal(s.exists('quests/qa/history/qa.anthropic.prompts.md'), true);

        assert.deepEqual(parse(s.read('quests/qa/config/extension_config.qa.yaml')), { telegram: { defaultChatId: 1 } });
        assert.deepEqual(parse(s.read('quests/qa/config/extension_config.mbp.qa.yaml')), {
            questRefresh: { panels: { anthropic: { active: true, count: 3 } } },
            aspectGuidelines: { chat: { anthropic: { language: 'de' } } },
            cliServer: { autostart: false },
        });
        assert.deepEqual(parse(s.read('quests/qa/config/extension_config.big.qa.yaml')), { cliServer: { autostart: true } }, 'a section the step empties goes');

        const ws = JSON.parse(fs.readFileSync(s.workspaceConfigPath, 'utf8'));
        assert.deepEqual(ws, {
            userName: 'me',
            questRefresh: { anthropic: { interval: 5 } },
            trail: { raw: { enabled: true, paths: { anthropic: 'a' } } },
            timedRequests: [{ id: 't1', template: '(None)', originalText: 'x' }, { id: 't2', template: 'Review' }],
        });
        assert.match(fs.readFileSync(s.workspaceConfigPath, 'utf8'), /^\{\n {4}"userName"/, 'the indent kept');
        assert.deepEqual(parse(fs.readFileSync(s.userConfigPath, 'utf8')), { userName: 'me', trail: { raw: { paths: { anthropic: '${ai}/trail/anthropic/${quest}' } } } });

        const again = s.step(true);
        assert.deepEqual(again, { changes: [], problems: [] }, 'a second run lists nothing');
        const dry = s.step(false);
        assert.deepEqual(dry, { changes: [], problems: [] });
    });

    test('CL-4: the layout is kept', () => {
        const s = sandbox();
        fixture(s);
        s.step(true);
        const overlay = fs.readFileSync(s.userConfigPath, 'utf8');
        assert.match(overlay, /^# my overlay\nuserName: me # who I am\n/, 'the leading comment and the value\'s comment');
        assert.match(overlay, /# where the raw trail goes\n/, 'a comment inside a changed section');
        assert.doesNotMatch(overlay, /copilot|reminders/);
        const host = s.read('quests/qa/config/extension_config.mbp.qa.yaml');
        assert.match(host, /# the chat panels' choices/);
        assert.match(s.read('quests/qa/config/extension_config.qa.yaml'), /^# the shared config\ntelegram:\n {2}defaultChatId: 1\n/);
        const entry = s.read('queue/mbp_ws_1_qa.normal.entry.queue.yaml');
        assert.match(entry, /^# yaml-language-server: \$schema=\.\.\/schemas\/yaml\/queue-entry\.schema\.json\n/, 'the schema line');
        assert.match(entry, /prompt-text: >-\n {6}\S/, 'the folded text stays folded');
        assert.equal(s.read('queue/mbp_ws_3_qa.normal.entry.queue.yaml'), CLEAN_ENTRY, 'a file without leftovers is not rewritten');
    });

    test('CL-5: an unreadable entry', () => {
        const s = sandbox();
        const bad = 'meta:\n  id: b1\nprompt-queue:\n  - id: P1\n    transport: copilot\n   bad: [\n';
        s.write('queue/bad.entry.queue.yaml', bad);
        s.write('queue/other.entry.queue.yaml', 'meta: [\n');
        const { changes, problems } = s.step(true);
        assert.deepEqual(changes, []);
        assert.equal(problems.length, 1);
        assert.match(problems[0].detail, /^queue\/bad\.entry\.queue\.yaml is not readable YAML .*left as it is$/);
        assert.equal(s.read('queue/bad.entry.queue.yaml'), bad);
    });

    test('dropCopilotConfig: nothing to drop answers nothing', () => {
        const config = { questRefresh: { anthropic: {} }, trail: { raw: { paths: { anthropic: 'a' } } }, timedRequests: [{ id: 'x', template: 'T' }] };
        assert.deepEqual(dropCopilotConfig(config), []);
        assert.deepEqual(dropCopilotConfig(undefined), []);
        assert.deepEqual(dropCopilotConfig([]), []);
    });

    test('CL-6: through migrateAiFormats (format version 11)', () => {
        const s = sandbox();
        fixture(s);
        s.write('quests/qa/overview.qa.md', '# qa\n');
        const run = (apply: boolean) => migrateAiFormats({
            aiRoot: s.ai, hostSlug: 'mbp', apply, formatVersion: 11, today: '2026-11-25',
            merge: () => undefined, workspaceConfigPath: s.workspaceConfigPath, userConfigPath: s.userConfigPath,
        });
        const dry = run(false);
        assert.ok(dry.changes.some((c) => c.step === 'copilot-leftovers' && /transport copilot as anthropic/.test(c.detail)));
        const applied = run(true);
        assert.deepEqual(applied.problems.filter((p) => p.step === 'copilot-leftovers'), []);
        assert.equal(parse(s.read('queue/mbp_ws_1_qa.normal.entry.queue.yaml'))['prompt-queue'][0].transport, 'anthropic');
        assert.equal(s.exists('answers/copilot'), false);
        if (applied.problems.length === 0) {
            assert.equal(parse(s.read('format-version.yaml')).version, 11, 'the stamp');
        }
        const again = run(true);
        assert.deepEqual(again.changes.filter((c) => c.step === 'copilot-leftovers'), [], 'a second run lists nothing of the step');
    });
});
