/**
 * The TomSpecs object model (SOM), loaded once for the whole extension.
 *
 * Every spec / DocSpecs / CodeSpecs tool works against the same model: the
 * lossless meta-data the typed facade `tom_som_typescript_v0` ships, read
 * through the generic runtime `tom_som_typescript_runtime`. Both are real
 * packages in this extension's node_modules, installed from the tarballs
 * `scripts/build-som-packages.cjs` builds out of tom_ai/ai_build. Nothing here
 * reaches into ai_build: every file is found through the packages' own names,
 * so the installed extension works on a machine that has no checkout.
 *
 * The model is about 1250 classes. Parsing it takes a noticeable moment, and
 * each tool call has a 5 s budget, so it is parsed once, on first use, and
 * cached; so are the per-root meta trees the YAML codec needs.
 *
 * The typed facade module itself is never loaded here (it is tens of
 * thousands of lines). Only its meta file and its schema accessor are.
 *
 * vscode-free, so it runs under `node --test`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { CodeSpecsAreaCatalog, SpecModel, SpecReflection, buildSomMetaTree } from 'tom_som_typescript_runtime';
import type { DocSpecsSchema, SomMetaTree, SpecRoot } from 'tom_som_typescript_runtime';

/** The facade's schema accessor (`tom_som_typescript_v0/schemas`). */
interface SomSchemaAccessor {
    somDocSpecsSchema(id: string): DocSpecsSchema;
    somDocSpecsSchemaIds: readonly string[];
    somDocSpecsSchemaYaml: Readonly<Record<string, string>>;
}

/** The installed versions of the two SOM packages. */
export interface SomPackageVersions {
    runtime: string;
    facade: string;
}

export class SomModelService {
    private static _instance: SomModelService | undefined;

    /** The extension-wide service; the model behind it loads on first use. */
    static get instance(): SomModelService {
        if (!SomModelService._instance) {
            SomModelService._instance = new SomModelService();
        }
        return SomModelService._instance;
    }

    private _model: SpecModel | undefined;
    private _reflection: SpecReflection | undefined;
    private _schemas: SomSchemaAccessor | undefined;
    private _catalog: CodeSpecsAreaCatalog | undefined;
    private readonly _trees = new Map<string, SomMetaTree>();

    /** The SOM model, parsed from the facade's meta on first use. */
    get model(): SpecModel {
        if (!this._model) {
            const metaPath = require.resolve('tom_som_typescript_v0/meta');
            this._model = SpecModel.fromJson(JSON.parse(fs.readFileSync(metaPath, 'utf8')));
        }
        return this._model;
    }

    /** Value-free path resolution and enumeration over {@link model}. */
    get reflection(): SpecReflection {
        if (!this._reflection) {
            this._reflection = new SpecReflection(this.model);
        }
        return this._reflection;
    }

    /** The model version as `major.minor`, the form documents are stamped with. */
    get modelVersion(): string {
        return this.model.modelVersionString;
    }

    /**
     * The document root named by its type (`D00SolutionBlueprint`) or its
     * section id (`SBP`). Throws naming the known roots when neither matches.
     */
    root(typeOrSectionId: string): SpecRoot {
        const root = this.model.roots.find((r) => r.type === typeOrSectionId || r.sectionId === typeOrSectionId);
        if (!root) {
            const known = this.model.roots.map((r) => `${r.sectionId} (${r.type})`).join(', ');
            throw new Error(`No TomSpecs document root '${typeOrSectionId}'. Known roots: ${known}.`);
        }
        return root;
    }

    /**
     * The meta tree of one document root, which the YAML codec walks to place
     * keys. Built once per root and cached; the type and the section id give
     * the same tree.
     */
    metaTree(typeOrSectionId: string): SomMetaTree {
        const root = this.root(typeOrSectionId);
        let tree = this._trees.get(root.type);
        if (!tree) {
            tree = buildSomMetaTree(this.model, root.type);
            this._trees.set(root.type, tree);
        }
        return tree;
    }

    /** The ids of the generated DocSpecs schemas (one per document root). */
    get schemaIds(): readonly string[] {
        return this.schemaAccessor.somDocSpecsSchemaIds;
    }

    /** A generated DocSpecs schema by id (e.g. `solution-blueprint`); throws for an unknown id. */
    schema(id: string): DocSpecsSchema {
        return this.schemaAccessor.somDocSpecsSchema(id);
    }

    /**
     * The version a generated schema declares in its `# Schema: <id>/<version>`
     * header line, or null when it has none. Schema findings carry it so a
     * finding that is the schema's fault can be traced to the schema that made it.
     */
    schemaVersion(id: string): string | null {
        const text = this.schemaAccessor.somDocSpecsSchemaYaml[id] ?? '';
        return /^# Schema: [^/\s]+\/(\S+)$/m.exec(text)?.[1] ?? null;
    }

    /**
     * The packaged copy of the CodeSpecs area catalogue (areas, slices,
     * authoring steps). scripts/build-som-packages.cjs copies it from
     * tom_specs_model into resources/codespecs/, which ships in the VSIX.
     */
    get codeSpecsCatalog(): CodeSpecsAreaCatalog {
        if (!this._catalog) {
            const file = SomModelService.codeSpecsCatalogFile;
            if (!fs.existsSync(file)) {
                throw new Error(`The CodeSpecs area catalogue is missing at ${file}. Run \`npm run som:pack\` in the extension (it copies the catalogue from tom_specs_model).`);
            }
            this._catalog = CodeSpecsAreaCatalog.fromJson(JSON.parse(fs.readFileSync(file, 'utf8')));
        }
        return this._catalog;
    }

    /** Where the packaged catalogue lives: <extension>/resources/codespecs/ (this file is out/services/). */
    static get codeSpecsCatalogFile(): string {
        return path.resolve(__dirname, '..', '..', 'resources', 'codespecs', 'codespecs_areas.json');
    }

    /** The installed package versions; they move together with the model version. */
    get packageVersions(): SomPackageVersions {
        const read = (pkg: string): string =>
            (JSON.parse(fs.readFileSync(require.resolve(`${pkg}/package.json`), 'utf8')) as { version: string }).version;
        return { runtime: read('tom_som_typescript_runtime'), facade: read('tom_som_typescript_v0') };
    }

    private get schemaAccessor(): SomSchemaAccessor {
        if (!this._schemas) {
            // The accessor embeds about 4 MB of schema YAML, so it is loaded
            // only when a schema is first asked for.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            this._schemas = require('tom_som_typescript_v0/schemas') as SomSchemaAccessor;
        }
        return this._schemas;
    }
}
