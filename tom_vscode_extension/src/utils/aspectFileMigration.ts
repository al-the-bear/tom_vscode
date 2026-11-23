/**
 * The `_ai` format version 10 step (gsel16, guideline_sectioning.md D-26):
 * every aspect's definition file `_ai/aspect_guidelines/<aspect>/section.yaml`
 * becomes `aspect.yaml`, its key `options:` becomes `choices:`, and its schema
 * line names `aspect-guideline.schema.json` instead of
 * `aspect-guideline-section.schema.json`. Comments and the text of every other
 * entry stay as they were.
 *
 * A folder that has both files is left as it is and named as a problem: which
 * of the two is the definition is for its owner to say. vscode-free.
 */

import { isMap, isScalar, parseDocument, Scalar, YAMLMap } from 'yaml';

/** The file before version 10 and the file from version 10 on. */
export const LEGACY_DEFINITION_FILE = 'section.yaml';
export const DEFINITION_FILE = 'aspect.yaml';

const LEGACY_SCHEMA = 'aspect-guideline-section.schema.json';
const SCHEMA = 'aspect-guideline.schema.json';

/**
 * `section.yaml`'s text as `aspect.yaml`'s: `options` renamed `choices` in
 * place (its comments and position kept), the schema line pointing at the new
 * schema. Answers the text and what changed; `changed` is empty when the text
 * needed nothing but the new file name. Throws when the text is no YAML map.
 */
export function aspectDefinitionText(text: string): { text: string; changed: string[] } {
    const changed: string[] = [];
    let out = text;
    if (out.includes(LEGACY_SCHEMA)) {
        out = out.split(LEGACY_SCHEMA).join(SCHEMA);
        changed.push(`schema line: ${SCHEMA}`);
    }
    const doc = parseDocument(out);
    if (doc.errors.length) { throw new Error(doc.errors[0].message); }
    const root = doc.contents;
    if (root !== null && root !== undefined && !isMap(root)) { throw new Error('the file is no YAML map'); }
    const map = root as YAMLMap | null;
    const pair = map?.items.find((p) => isScalar(p.key) && (p.key as Scalar).value === 'options');
    if (map && pair) {
        if (map.items.some((p) => isScalar(p.key) && (p.key as Scalar).value === 'choices')) {
            throw new Error('it has both `options` and `choices`');
        }
        (pair.key as Scalar).value = 'choices';
        changed.push('`options` → `choices`');
        out = doc.toString({ indentSeq: !/^( *)[^\s#-][^\n]*:\n\1- /m.test(text) });
    }
    return { text: out, changed };
}
