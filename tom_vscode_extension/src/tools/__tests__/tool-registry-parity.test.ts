/**
 * Parity guard across the three lists a tool must appear in to be fully usable.
 *
 * Registering a tool touches more places than any one of them advertises:
 *
 *   1. `ALL_SHARED_TOOLS`   (tools/tool-executors.ts) — what a profile with
 *      `toolsEnabled !== false` receives.
 *   2. `AVAILABLE_LLM_TOOLS` (utils/constants.ts) — the option set every picker
 *      renders, and therefore the only names an `enabledTools` allow-list can
 *      ever contain.
 *   3. `CATEGORY_MAP`        (utils/toolCategories.ts) — the picker's grouping.
 *
 * Only step 1 has an obvious failure mode (the tool does not exist). Steps 2
 * and 3 fail *silently*: the tool works under `toolsEnabled: true` and is
 * invisible everywhere else, or it shows up dumped into "Other". That silence
 * let the two registries drift to 132 vs 105 before anyone noticed, so the
 * relationship is asserted here rather than left to the checklist in
 * doc/llm_tools.md.
 *
 * The contract is exact equality, not "subset" — a permissive guard would let
 * the next omission through, which is the entire failure being fixed.
 *
 * Run from the extension folder with:
 *   npm run compile && node --test out/tools/__tests__/tool-registry-parity.test.js
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

// Install the shared vscode stub BEFORE importing modules that require vscode.
import { installVscodeStub } from './_vscode-stub.js';
installVscodeStub({});

import { ALL_SHARED_TOOLS } from '../tool-executors.js';
import { AVAILABLE_LLM_TOOLS, DELIBERATELY_UNSELECTABLE_TOOLS } from '../../utils/constants.js';
import { CATEGORY_MAP } from '../../utils/toolCategories.js';

const registered = ALL_SHARED_TOOLS.map((t) => t.name);
const selectable = AVAILABLE_LLM_TOOLS as readonly string[];
const excluded = DELIBERATELY_UNSELECTABLE_TOOLS as readonly string[];

describe('tool registry parity — ALL_SHARED_TOOLS vs AVAILABLE_LLM_TOOLS', () => {
    test('every registered tool is either selectable or explicitly excluded', () => {
        const selectableSet = new Set(selectable);
        const excludedSet = new Set(excluded);
        const unaccounted = registered.filter(
            (name) => !selectableSet.has(name) && !excludedSet.has(name),
        );
        assert.deepEqual(
            unaccounted,
            [],
            'Registered but neither selectable nor listed in DELIBERATELY_UNSELECTABLE_TOOLS. '
            + 'Add the name to AVAILABLE_LLM_TOOLS (plus a CATEGORY_MAP entry), or — if it is '
            + 'meant to stay behind `toolsEnabled: true` — to the exclusion list with a reason.',
        );
    });

    test('no name is selectable without being registered', () => {
        const registeredSet = new Set(registered);
        const phantom = selectable.filter((name) => !registeredSet.has(name));
        assert.deepEqual(
            phantom,
            [],
            'Offered in the pickers but absent from ALL_SHARED_TOOLS — ticking it enables nothing.',
        );
    });

    test('the exclusion list names only registered tools', () => {
        const registeredSet = new Set(registered);
        const stale = excluded.filter((name) => !registeredSet.has(name));
        assert.deepEqual(
            stale,
            [],
            'DELIBERATELY_UNSELECTABLE_TOOLS mentions a tool that no longer exists — drop the entry.',
        );
    });

    test('the exclusion list and the picker set are disjoint', () => {
        const selectableSet = new Set(selectable);
        const both = excluded.filter((name) => selectableSet.has(name));
        assert.deepEqual(
            both,
            [],
            'A tool cannot be both deliberately unselectable and offered in the pickers.',
        );
    });

    test('exclusions are limited to write tools', () => {
        // The read-only floor is the justification for the whole exclusion list:
        // what is withheld is the queue/timer *control plane*, not information.
        // A read-only tool appearing here means the rationale no longer matches
        // the contents — revisit the entry rather than widening this assertion.
        const excludedSet = new Set(excluded);
        const readOnlyExclusions = ALL_SHARED_TOOLS
            .filter((t) => excludedSet.has(t.name) && t.readOnly)
            .map((t) => t.name);
        assert.deepEqual(
            readOnlyExclusions,
            [],
            'Read-only tools are being hidden from the pickers. Introspection carries no '
            + 'autonomy risk, so it belongs in AVAILABLE_LLM_TOOLS.',
        );
    });
});

describe('tool registry parity — AVAILABLE_LLM_TOOLS vs CATEGORY_MAP', () => {
    const categorised = Object.values(CATEGORY_MAP).flat();

    test('every selectable tool is categorised', () => {
        const categorisedSet = new Set(categorised);
        const uncategorised = selectable.filter((name) => !categorisedSet.has(name));
        assert.deepEqual(
            uncategorised,
            [],
            'Missing from CATEGORY_MAP — the picker buries these under "Other".',
        );
    });

    test('CATEGORY_MAP holds no tools the pickers never render', () => {
        const selectableSet = new Set(selectable);
        const orphans = categorised.filter((name) => !selectableSet.has(name));
        assert.deepEqual(
            orphans,
            [],
            'Categorised but not in AVAILABLE_LLM_TOOLS — the entry is dead weight.',
        );
    });

    test('no tool is listed under two categories', () => {
        const seen = new Set<string>();
        const duplicates = categorised.filter((name) => {
            if (seen.has(name)) { return true; }
            seen.add(name);
            return false;
        });
        assert.deepEqual(duplicates, [], 'Listed under more than one category.');
    });

    test('AVAILABLE_LLM_TOOLS itself has no duplicates', () => {
        const duplicates = selectable.filter((name, i) => selectable.indexOf(name) !== i);
        assert.deepEqual(duplicates, []);
    });
});
