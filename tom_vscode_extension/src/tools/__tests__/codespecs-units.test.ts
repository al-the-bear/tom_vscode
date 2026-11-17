/**
 * IR document names (tools/codespecs-units.ts; vscimpb149, tom_specs irout2).
 *
 *   CU-1 snakeCase as irspecs' (`DataAccess` → `data_access`, digits and runs of capitals as it treats them)
 *   CU-2 every active area of the bundled catalogue: `<CE-CODE>_<snake(canonicalId)>.ir.yaml`, all distinct, each
 *        naming its own area before the first `_`; an area without a canonical id keeps `<CE-CODE>.ir.yaml`
 *   CU-3 irDocumentOf: the new name first, else the older one, else none; both present is reported
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from './_vscode-stub.js';
installVscodeStub({});

import { SomModelService } from '../../services/som-model-service.js';
import { canonicalIdOf, irDocumentName, irDocumentOf, legacyIrDocumentName, snakeCase } from '../codespecs-units.js';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-units-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('IR document names', () => {
    test('CU-1: snakeCase', () => {
        assert.equal(snakeCase('DataAccess'), 'data_access');
        assert.equal(snakeCase('ServerApi'), 'server_api');
        assert.equal(snakeCase('ServiceUnit'), 'service_unit');
        assert.equal(snakeCase('I18n'), 'i18n');
        assert.equal(snakeCase('Oauth2Flow'), 'oauth2_flow');
        assert.equal(snakeCase('APIKeys'), 'apikeys', 'a run of capitals after a capital stays joined, as in irspecs');
    });

    test('CU-2: every active area', () => {
        const catalog = SomModelService.instance.codeSpecsCatalog;
        const deps = { service: SomModelService.instance } as never;
        assert.ok(catalog.activeAreas.length > 20, `${catalog.activeAreas.length} active areas`);
        const names = catalog.activeAreas.map((a) => {
            const name = irDocumentName(a.code, canonicalIdOf(deps, a.code));
            assert.match(name, /^CE-[A-Z]+_[a-z0-9]+(_[a-z0-9]+)*\.ir\.yaml$/, name);
            assert.equal(name, `${a.code}_${snakeCase(a.canonicalId)}.ir.yaml`);
            assert.equal(name.slice(0, name.indexOf('_')), a.code, 'it names its own area');
            return name;
        });
        assert.equal(new Set(names).size, names.length, 'all distinct');
        assert.equal(irDocumentName('CE-DB', 'DataAccess'), 'CE-DB_data_access.ir.yaml');
        assert.equal(irDocumentName('CE-XX', undefined), 'CE-XX.ir.yaml');
        assert.equal(legacyIrDocumentName('CE-DB'), 'CE-DB.ir.yaml');
        assert.equal(canonicalIdOf(deps, 'CE-NOPE'), undefined);
    });

    test('CU-3: irDocumentOf', () => {
        assert.deepEqual(irDocumentOf(tmp, 'CE-DB', 'DataAccess'), { area: 'CE-DB', name: 'CE-DB_data_access.ir.yaml', found: null });
        fs.writeFileSync(path.join(tmp, 'CE-DB.ir.yaml'), '');
        assert.equal(irDocumentOf(tmp, 'CE-DB', 'DataAccess').found, 'CE-DB.ir.yaml', 'the older name');
        fs.writeFileSync(path.join(tmp, 'CE-DB_data_access.ir.yaml'), '');
        const both = irDocumentOf(tmp, 'CE-DB', 'DataAccess');
        assert.equal(both.found, 'CE-DB_data_access.ir.yaml', 'the new name first');
        assert.deepEqual(both.bothNames?.names, ['CE-DB_data_access.ir.yaml', 'CE-DB.ir.yaml']);
        fs.rmSync(path.join(tmp, 'CE-DB.ir.yaml'));
        assert.equal(irDocumentOf(tmp, 'CE-DB', 'DataAccess').bothNames, undefined);
        fs.mkdirSync(path.join(tmp, 'CE-SU_service_unit.ir.yaml'));
        assert.equal(irDocumentOf(tmp, 'CE-SU', 'ServiceUnit').found, null, 'a folder is no document');
    });
});
