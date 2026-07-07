/**
 * Pure helpers for the TODO Log view (`todoLogPanel-handler.ts`).
 *
 * A TODO reference is the fully-qualified id the model echoes back in an answer:
 * `<workspace-relative-path>/<file>.todo.yaml/<todoId>` (see CLAUDE.md →
 * "Reporting completed TODOs"). The view needs to (a) split that ref back into
 * its file path and todo id — to show a label and look up the title — and
 * (b) collapse duplicate refs, because a single answer commonly carries the
 * same TODO twice: the model writes its own `variables:` block and the trail
 * service appends a second one built from `responseValues`. Without dedup the
 * view renders one link per line instead of one per distinct TODO.
 *
 * Kept dependency-free so it can be unit-tested without the VS Code host.
 */

const TODO_YAML = '.todo.yaml';
const TODO_YAML_SEP = `${TODO_YAML}/`;

/** A TODO reference split into its parts. */
export interface ParsedTodoRef {
    /** The original ref, trimmed. */
    ref: string;
    /** Workspace-relative path to the `.todo.yaml` file (empty if not present). */
    file: string;
    /** Base name of the `.todo.yaml` file (empty if not present). */
    fileName: string;
    /** The todo id — the final segment after `.todo.yaml/`. */
    id: string;
}

/**
 * Split a qualified todo ref into its `.todo.yaml` file path and todo id.
 * When the ref has no `.todo.yaml/` marker the whole (trimmed) string is
 * treated as the id and the file parts are empty.
 */
export function parseTodoRef(ref: string): ParsedTodoRef {
    const trimmed = (ref ?? '').trim();
    const idx = trimmed.lastIndexOf(TODO_YAML_SEP);
    if (idx === -1) {
        return { ref: trimmed, file: '', fileName: '', id: trimmed };
    }
    const file = trimmed.slice(0, idx + TODO_YAML.length);
    const id = trimmed.slice(idx + TODO_YAML_SEP.length);
    const fileName = file.split(/[\\/]/).pop() ?? '';
    return { ref: trimmed, file, fileName, id };
}

/**
 * Deduplicate todo refs by their exact (trimmed) value, preserving first-seen
 * order and dropping blank entries.
 */
export function dedupeTodoRefs(refs: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of refs) {
        const ref = (raw ?? '').trim();
        if (!ref || seen.has(ref)) { continue; }
        seen.add(ref);
        out.push(ref);
    }
    return out;
}
