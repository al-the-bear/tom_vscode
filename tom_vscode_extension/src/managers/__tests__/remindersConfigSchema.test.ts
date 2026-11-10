/**
 * The `reminders` section of `.tom/tom_vscode_extension.json` is declared in the config schema and the config
 * type (vscimpb27), and what the ReminderSystem writes and reads fits it.
 *
 *   RS-1 the schema declares `reminders` (templates: id, name, prompt, isDefault; config: enabled,
 *        defaultTemplateId, defaultTimeoutMinutes ≥ 1), closed; SendToChatConfig declares `reminders?: RemindersConfig`
 *   RS-2 the section the ReminderSystem writes (a template added, the config changed) validates; so does this
 *        workspace's live config section, when the checkout has one
 *   RS-3 a section the schema refuses: an unknown key, a template without its prompt, a timeout below 1
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Ajv from 'ajv';

const EXT = path.resolve(__dirname, '..', '..', '..');
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reminders-schema-')));
fs.mkdirSync(path.join(WS, '.tom'), { recursive: true });
const CONFIG = path.join(WS, '.tom', 'tom_vscode_extension.json');
fs.writeFileSync(CONFIG, '{}\n');

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub';
const stubbed = installVscodeStub({ workspaceFolders: [WS] });

import { ReminderSystem } from '../reminderSystem';

after(() => {
    try { ReminderSystem.instance.dispose(); } catch { /* not started */ }
    stubbed.restore();
    fs.rmSync(WS, { recursive: true, force: true });
});

const schema = JSON.parse(fs.readFileSync(path.join(EXT, 'src', 'config', 'tom_vscode_extension.schema.json'), 'utf8'));
// The whole config schema compiled; only the reminders section is given, the rest is optional.
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
const check = (reminders: unknown): string => (validate({ reminders }) ? '' : JSON.stringify(validate.errors));

describe('the reminders config section', () => {
    test('RS-1: declared in the schema and the type', () => {
        const section = schema.properties.reminders;
        assert.ok(section, 'reminders in the schema');
        assert.equal(section.additionalProperties, false);
        assert.deepEqual(Object.keys(section.properties), ['templates', 'config']);
        assert.deepEqual(Object.keys(section.properties.templates.items.properties), ['id', 'name', 'prompt', 'isDefault']);
        assert.deepEqual(Object.keys(section.properties.config.properties), ['enabled', 'defaultTemplateId', 'defaultTimeoutMinutes']);
        const type = fs.readFileSync(path.join(EXT, 'src', 'utils', 'sendToChatConfig.ts'), 'utf8');
        assert.match(type, /\n {4}reminders\?: RemindersConfig;/);
        assert.match(type, /export interface RemindersConfig \{\n {4}templates\?: ReminderTemplate\[\];\n {4}config\?: Partial<ReminderConfig>;\n\}/);
    });

    test('RS-2: what the ReminderSystem writes validates, and the live section', () => {
        ReminderSystem.init({ subscriptions: [] } as never);
        const reminders = ReminderSystem.instance;
        reminders.addTemplate({ name: 'Nudge', prompt: 'Still waiting after {{waitingMinutes}} min.', isDefault: false });
        reminders.updateConfig({ defaultTimeoutMinutes: 12, enabled: false });
        const written = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).reminders;
        assert.equal(written.templates.length, 3, 'the two built-ins and the added one');
        assert.equal(written.config.defaultTimeoutMinutes, 12);
        assert.equal(check(written), '');

        const live = path.resolve(EXT, '..', '..', '..', '.tom', 'tom_vscode_extension.json');
        if (fs.existsSync(live)) {
            const section = JSON.parse(fs.readFileSync(live, 'utf8')).reminders;
            if (section !== undefined) { assert.equal(check(section), '', 'this workspace\'s live reminders section'); }
        }
    });

    test('RS-3: what the schema refuses', () => {
        const template = { id: 'a', name: 'A', prompt: 'p', isDefault: true };
        assert.equal(check({ templates: [template], config: { enabled: true, defaultTemplateId: 'a', defaultTimeoutMinutes: 1 } }), '');
        assert.notEqual(check({ templates: [template], extra: 1 }), '', 'an unknown key');
        assert.notEqual(check({ templates: [{ id: 'a', name: 'A', isDefault: true }] }), '', 'no prompt');
        assert.notEqual(check({ config: { defaultTimeoutMinutes: 0 } }), '', 'a timeout below 1');
    });
});
