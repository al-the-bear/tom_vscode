/**
 * The model-version stamp of a TomSpecs sample document, for tests that read
 * the live samples in tom_ai/ai_build.
 *
 * ai_build re-stamps its samples whenever the model moves (`1.3` → `1.6` → …),
 * so a test that names the sample's stamp, or replaces it by a literal, starts
 * failing on a change that is backwards compatible. A test asks what it means
 * instead: the stamp the sample carries (`stampOf`), or the sample re-stamped
 * older, newer or across the major version (`withStamp`).
 */

const YAML_STAMP = /^modelVersion: "(\d+)\.(\d+)"$/m;
const MD_STAMP = /^(<!-- docspec: [a-z0-9-]+\/)(\d+)\.(\d+)( -->)$/m;

/** The `major.minor` stamp of a YAML or Markdown TomSpecs document. */
export function stampOf(text: string): string {
    const y = YAML_STAMP.exec(text);
    if (y) { return `${y[1]}.${y[2]}`; }
    const m = MD_STAMP.exec(text);
    if (m) { return `${m[2]}.${m[3]}`; }
    throw new Error('no model-version stamp found in the sample');
}

/** The document with its stamp replaced by `version`; throws when there is none to replace. */
export function withStamp(text: string, version: string): string {
    if (YAML_STAMP.test(text)) { return text.replace(YAML_STAMP, `modelVersion: "${version}"`); }
    if (MD_STAMP.test(text)) { return text.replace(MD_STAMP, `$1${version}$4`); }
    throw new Error('no model-version stamp found in the sample');
}

/** A stamp of the same major version as `modelVersion`, older than it (`1.0` for a `1.6` model). */
export function olderSameMajor(modelVersion: string): string {
    const [major, minor] = modelVersion.split('.').map(Number);
    if (minor === 0) { throw new Error(`model ${modelVersion} has no older minor of its major`); }
    return `${major}.0`;
}
