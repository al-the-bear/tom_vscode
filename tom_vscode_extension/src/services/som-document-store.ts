/**
 * File-backed TomSpecs (SOM) documents: load a file into a SpecDocument, let a
 * tool edit it, save it back in the file's own format.
 *
 * The TomSpecs editor's tools act on a live in-memory document behind a
 * controller. The extension's documents are files, so every spec tool goes
 * through this one store and none parses or writes a document on its own.
 * Tools are stateless per call: load, edit, save, with the file as the truth.
 *
 * Formats:
 *   - `*.docspecs.yaml`: the runtime's YAML codec. The `review:` pass is
 *     carried through unchanged. decode() reports an absent pass and an
 *     explicit `review: {}` alike, as an empty map, so the store looks for a
 *     top-level `review:` key in the text itself: no key, nothing is written
 *     back; a key, the decoded pass is (tom_specs vsctasb1 would let the
 *     runtime say this).
 *   - `*.md` rendered from a SOM document (headings carry `<!--[ID]-->`):
 *     SpecDocument.fromMarkdown in, toMarkdown out. The model-version stamp is
 *     the version in the `<!-- docspec: <schema>/<major.minor> -->` header.
 *
 * Guards (an edit is refused, with the reason, rather than writing a wrong file):
 *   - model version (SOM §4.2): a newer same-major or a cross-major stamp loads
 *     read-only; an older same-major stamp is upgraded when saved;
 *   - Markdown fidelity: the import must reproduce the file when rendered
 *     again, must encode as a document (every value placed), and must not put
 *     values where the model has no value leaf. tom_specs qrb8 is such a
 *     defect today: prose of a head-form section lands on the section node,
 *     re-renders identically, and only shows in validation and in encoding;
 *   - Markdown parse rejections: re-rendering would drop the rejected blocks;
 *   - revision: a file changed since it was loaded is never overwritten;
 *   - a document open and dirty in an editor is not written under the editor.
 *
 * vscode-free: the file access is a {@link SomDocumentIo}. nodeSomDocumentIo
 * writes atomically; the extension supplies one that writes through the open
 * editor when there is one (som-document-io-vscode.ts).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    SpecDocument,
    SomEditability,
    somEditabilityFor,
    staleReviewPaths,
    validateDocument,
    yamlDecode,
    yamlEncode,
} from 'tom_som_typescript_runtime';
import type { SpecMarkdownRejection, SpecRoot } from 'tom_som_typescript_runtime';

import { SomModelService } from './som-model-service';
import { unifiedDiff } from '../utils/unifiedDiff';

export type SomDocumentFormat = 'yaml' | 'markdown';

export type SomDocumentErrorCode =
    | 'notFound'
    | 'unknownFormat'
    | 'unknownRoot'
    | 'parse'
    | 'readOnly'
    | 'revisionConflict'
    | 'dirtyInEditor'
    | 'encode';

/** A refusal or failure with a code a tool can report and a message that says what to do. */
export class SomDocumentError extends Error {
    constructor(readonly code: SomDocumentErrorCode, message: string) {
        super(message);
        this.name = 'SomDocumentError';
    }
}

/** File access for the store; the extension swaps in an editor-aware one. */
export interface SomDocumentIo {
    read(filePath: string): string;
    /** The first `bytes` of the file (or all of it when shorter), for header-only reads. Optional: `read` is used without it. */
    readHead?(filePath: string, bytes: number): string;
    write(filePath: string, text: string): Promise<void>;
    /** True when the file is open in an editor with unsaved changes. */
    isDirty?(filePath: string): boolean;
}

/** The first `bytes` of a file on disk, decoded as UTF-8 (a character cut at the end is replaced). */
export function readFileHead(filePath: string, bytes: number): string {
    const fd = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(bytes);
        const read = fs.readSync(fd, buffer, 0, bytes, 0);
        return buffer.toString('utf8', 0, read);
    } finally {
        fs.closeSync(fd);
    }
}

/** Plain file access: read, and write atomically (temp file in the same directory, then rename). */
export const nodeSomDocumentIo: SomDocumentIo = {
    read: (filePath) => fs.readFileSync(filePath, 'utf8'),
    readHead: (filePath, bytes) => readFileHead(filePath, bytes),
    write: async (filePath, text) => {
        const temp = path.join(
            path.dirname(filePath),
            `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
        );
        fs.writeFileSync(temp, text);
        try {
            fs.renameSync(temp, filePath);
        } catch (e) {
            fs.rmSync(temp, { force: true });
            throw e;
        }
    },
};

/** A document loaded from a file. Tools edit {@link document} and hand it back to save. */
export interface LoadedSomDocument {
    readonly filePath: string;
    readonly format: SomDocumentFormat;
    readonly root: SpecRoot;
    readonly document: SpecDocument;
    /** The file text as loaded (or as last saved). */
    text: string;
    /** sha256 of {@link text}; a save refuses when the file no longer has it. */
    revision: string;
    /** The model version the file is stamped with, or null for an unstamped file. */
    stamp: string | null;
    editability: SomEditability;
    /** YAML only: the `review:` pass, or null when the file has none. */
    readonly review: unknown | null;
    /** Markdown only: blocks the parser rejected (they are not in {@link document}). */
    readonly rejections: readonly SpecMarkdownRejection[];
    /** Markdown only: ways the import does not reproduce the file faithfully. */
    readonly fidelityProblems: readonly string[];
    /** Why edits are refused, or null when the document is editable. */
    readOnlyReason: string | null;
}

/**
 * What a file is, read from its header lines only: no decode, no import. Cheap
 * enough to run over every candidate file of a workspace. The editability is
 * the model-version rule alone; Markdown fidelity and parse rejections are
 * known only after a full {@link SomDocumentStore.load}.
 */
export interface SomDocumentSummary {
    readonly filePath: string;
    readonly format: SomDocumentFormat;
    readonly root: SpecRoot;
    readonly stamp: string | null;
    readonly editability: SomEditability;
    /** Why the model version makes it read-only, or null. */
    readonly versionReason: string | null;
}

export interface SomSaveOptions {
    /** Refuse unless the file still has this revision (what the agent last saw). */
    expectedRevision?: string;
    /** Compute the new text and the diff, write nothing. */
    dryRun?: boolean;
}

export interface SomSaveResult {
    written: boolean;
    /** The file text after the save (or what it would be, for a dry run). */
    text: string;
    revision: string;
    diff: string;
    /** YAML: review entries whose section path no longer resolves (reported, never deleted). */
    staleReviewPaths: string[];
}

const DOCSPEC_HEADER = /^<!-- docspec: ([^/\s]+)\/(\d+\.\d+) -->/;
const YAML_ROOT_KEY = /^document:\s*\n {2}(\S+) (\S+):/m;
const YAML_REVIEW_KEY = /^review:/m;
const YAML_STAMP = /^modelVersion:\s*"?([^"\s]+)"?\s*$/m;
/** How much of a file peek reads: the header lines and the root heading or key are at the top. */
const PEEK_BYTES = 16 * 1024;
/** A SOM-rendered Markdown heading: `## <!--[SECTIONID]--> Title`. */
const SOM_HEADING = /^#{1,6} <!--\[([^\]\s]+)\]-->/m;

function sha256(text: string): string {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function formatOf(filePath: string): SomDocumentFormat {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.docspecs.yaml') || lower.endsWith('.yaml') || lower.endsWith('.yml')) { return 'yaml'; }
    if (lower.endsWith('.md')) { return 'markdown'; }
    throw new SomDocumentError('unknownFormat',
        `${path.basename(filePath)} is not a SOM document file: expected *.docspecs.yaml or a SOM-rendered *.md.`);
}

export class SomDocumentStore {
    constructor(
        private readonly service: SomModelService = SomModelService.instance,
        private readonly io: SomDocumentIo = nodeSomDocumentIo,
    ) {}

    /** Load a SOM document file. Throws SomDocumentError for a missing, unknown or unparsable file. */
    load(filePath: string): LoadedSomDocument {
        const format = formatOf(filePath);
        let text: string;
        try {
            text = this.io.read(filePath);
        } catch {
            throw new SomDocumentError('notFound', `${filePath} does not exist or cannot be read.`);
        }
        return format === 'yaml' ? this.loadYaml(filePath, text) : this.loadMarkdown(filePath, text);
    }

    /** The revision (sha256) of the file as it is now. Throws SomDocumentError notFound when unreadable. */
    currentRevision(filePath: string): string {
        try {
            return sha256(this.io.read(filePath));
        } catch {
            throw new SomDocumentError('notFound', `${filePath} does not exist or cannot be read.`);
        }
    }

    /**
     * Identify a SOM document from its header without loading it, or return
     * null when the file is not one (no root key, no SOM heading, unknown
     * root, unreadable). Never throws for a non-SOM file.
     */
    peek(filePath: string): SomDocumentSummary | null {
        let format: SomDocumentFormat;
        let text: string;
        try {
            format = formatOf(filePath);
            text = this.io.readHead ? this.io.readHead(filePath, PEEK_BYTES) : this.io.read(filePath);
        } catch {
            return null;
        }
        let rootKey: string | undefined;
        let stamp: string | null;
        if (format === 'yaml') {
            rootKey = YAML_ROOT_KEY.exec(text)?.[1];
            stamp = YAML_STAMP.exec(text)?.[1] ?? null;
        } else {
            rootKey = SOM_HEADING.exec(text)?.[1];
            stamp = DOCSPEC_HEADER.exec(text)?.[2] ?? null;
        }
        if (!rootKey) { return null; }
        const root = this.service.model.roots.find((r) => r.sectionId === rootKey || r.type === rootKey);
        if (!root) { return null; }
        const editability = somEditabilityFor(this.service.modelVersion, stamp);
        return {
            filePath,
            format,
            root,
            stamp,
            editability,
            versionReason: this.readOnlyReason(editability, stamp, [], []),
        };
    }

    /**
     * The file text for `loaded` as it stands. `stamp` defaults to the model
     * version, which is what a save writes; pass the document's own stamp to
     * reproduce the file unchanged.
     */
    render(loaded: LoadedSomDocument, options: { stamp?: string | null } = {}): string {
        const stamp = options.stamp === undefined ? this.service.modelVersion : options.stamp;
        if (loaded.format === 'yaml') {
            try {
                return yamlEncode(loaded.document, this.service.metaTree(loaded.root.type), stamp, loaded.review ?? null);
            } catch (e) {
                throw new SomDocumentError('encode', `The document cannot be written as YAML: ${(e as Error).message}`);
            }
        }
        const markdown = loaded.document.toMarkdown(this.service.model, loaded.root.type);
        return stamp ? markdown.replace(DOCSPEC_HEADER, (_m, schema: string) => `<!-- docspec: ${schema}/${stamp} -->`) : markdown;
    }

    /**
     * Write `loaded.document` back to its file, in its format, stamped with the
     * model version. Refuses (SomDocumentError) a read-only document, a
     * document dirty in an editor, and a file whose revision changed.
     */
    async save(loaded: LoadedSomDocument, options: SomSaveOptions = {}): Promise<SomSaveResult> {
        if (loaded.readOnlyReason) {
            throw new SomDocumentError('readOnly', loaded.readOnlyReason);
        }
        if (this.io.isDirty?.(loaded.filePath)) {
            throw new SomDocumentError('dirtyInEditor',
                `${path.basename(loaded.filePath)} has unsaved changes in an editor. Save or revert it there first.`);
        }
        let current: string;
        try {
            current = this.io.read(loaded.filePath);
        } catch {
            throw new SomDocumentError('notFound', `${loaded.filePath} no longer exists.`);
        }
        const currentRevision = sha256(current);
        if (currentRevision !== loaded.revision) {
            throw new SomDocumentError('revisionConflict',
                `${path.basename(loaded.filePath)} changed since it was loaded (revision ${currentRevision.slice(0, 12)}, loaded ${loaded.revision.slice(0, 12)}). Load it again and redo the edit.`);
        }
        if (options.expectedRevision !== undefined && options.expectedRevision !== currentRevision) {
            throw new SomDocumentError('revisionConflict',
                `${path.basename(loaded.filePath)} is at revision ${currentRevision.slice(0, 12)}, not the expected ${options.expectedRevision.slice(0, 12)}. Load it again.`);
        }

        const text = this.render(loaded);
        const result: SomSaveResult = {
            written: false,
            text,
            revision: sha256(text),
            diff: unifiedDiff(current, text, path.basename(loaded.filePath)),
            staleReviewPaths: loaded.review
                ? staleReviewPaths(this.service.model, loaded.document, loaded.review)
                : [],
        };
        if (options.dryRun) { return result; }

        await this.io.write(loaded.filePath, text);
        loaded.text = text;
        loaded.revision = result.revision;
        loaded.stamp = this.service.modelVersion;
        loaded.editability = SomEditability.editable;
        return { ...result, written: true };
    }

    private loadYaml(filePath: string, text: string): LoadedSomDocument {
        const rootKey = YAML_ROOT_KEY.exec(text);
        if (!rootKey) {
            throw new SomDocumentError('parse', `${path.basename(filePath)} has no 'document:' pass with a root key.`);
        }
        const root = this.rootFor(rootKey[1], filePath);
        let contents;
        try {
            contents = yamlDecode(text, this.service.metaTree(root.type));
        } catch (e) {
            throw new SomDocumentError('parse', `${path.basename(filePath)}: ${(e as Error).message}`);
        }
        const hasReviewPass = YAML_REVIEW_KEY.test(text);
        return this.loaded(filePath, 'yaml', root, contents.document, text, contents.modelVersion,
            hasReviewPass ? contents.review : null, [], []);
    }

    private loadMarkdown(filePath: string, text: string): LoadedSomDocument {
        const imported = SpecDocument.fromMarkdown(text, this.service.model);
        const roots = [...imported.result.rootPrefixes];
        if (roots.length !== 1) {
            throw new SomDocumentError(roots.length === 0 ? 'parse' : 'unknownRoot',
                `${path.basename(filePath)} must hold exactly one SOM document root; found ${roots.length === 0 ? 'none' : roots.join(', ')}.`);
        }
        const root = this.rootFor(roots[0], filePath);
        const stamp = DOCSPEC_HEADER.exec(text)?.[2] ?? null;
        const draft = this.loaded(filePath, 'markdown', root, imported.document, text, stamp, null, imported.rejections, []);
        const problems = imported.rejections.length > 0 ? [] : this.fidelityProblems(draft);
        return this.loaded(filePath, 'markdown', root, imported.document, text, stamp, null, imported.rejections, problems);
    }

    /** Ways a Markdown import fails to stand for its file (none when it is faithful). */
    private fidelityProblems(loaded: LoadedSomDocument): string[] {
        const problems: string[] = [];
        const again = this.render(loaded, { stamp: loaded.stamp });
        if (again !== loaded.text) {
            const firstDiff = unifiedDiff(loaded.text, again, path.basename(loaded.filePath)).split('\n').find((l) => l.startsWith('@@'));
            problems.push(`rendering the import again does not reproduce the file (${firstDiff ?? 'differs'})`);
        }
        try {
            yamlEncode(loaded.document, this.service.metaTree(loaded.root.type), null, null);
        } catch (e) {
            problems.push(`the imported document cannot be encoded: ${(e as Error).message}`);
        }
        for (const finding of validateDocument(this.service.model, loaded.document)) {
            if (finding.code === 'kindMismatch') {
                problems.push(`kindMismatch ${finding.path}: ${finding.message}`);
            }
        }
        return problems;
    }

    private rootFor(sectionIdOrType: string, filePath: string): SpecRoot {
        try {
            return this.service.root(sectionIdOrType);
        } catch (e) {
            throw new SomDocumentError('unknownRoot', `${path.basename(filePath)}: ${(e as Error).message}`);
        }
    }

    private loaded(
        filePath: string,
        format: SomDocumentFormat,
        root: SpecRoot,
        document: SpecDocument,
        text: string,
        stamp: string | null,
        review: unknown | null,
        rejections: readonly SpecMarkdownRejection[],
        fidelityProblems: readonly string[],
    ): LoadedSomDocument {
        const editability = somEditabilityFor(this.service.modelVersion, stamp);
        return {
            filePath,
            format,
            root,
            document,
            text,
            revision: sha256(text),
            stamp,
            editability,
            review,
            rejections,
            fidelityProblems,
            readOnlyReason: this.readOnlyReason(editability, stamp, rejections, fidelityProblems),
        };
    }

    private readOnlyReason(
        editability: SomEditability,
        stamp: string | null,
        rejections: readonly SpecMarkdownRejection[],
        fidelityProblems: readonly string[],
    ): string | null {
        const model = this.service.modelVersion;
        switch (editability) {
            case SomEditability.rejectedNewerMinor:
                return `The document is stamped model ${stamp}, newer than this extension's model ${model}. Update the extension to edit it (SOM §4.2).`;
            case SomEditability.readOnlyCrossMajor:
                return `The document is stamped model ${stamp}, a different major version than this extension's model ${model}; it can be read but not edited (SOM §4.2).`;
            case SomEditability.invalidVersion:
                return `The document's model stamp '${stamp}' is not a major.minor version; it is not edited until the stamp is fixed.`;
            default:
                break;
        }
        if (rejections.length > 0) {
            const lines = rejections.slice(0, 5).map((r) => `line ${r.line}: ${r.message}`).join('; ');
            return `The Markdown parser rejected ${rejections.length} block(s) (${lines}). Saving would drop them; fix the file first.`;
        }
        if (fidelityProblems.length > 0) {
            return `The Markdown import is not faithful to the file (a runtime import defect, tom_specs qrb8), so saving would change it: ${fidelityProblems.slice(0, 5).join('; ')}. Edit the YAML form of this document instead.`;
        }
        return null;
    }
}
