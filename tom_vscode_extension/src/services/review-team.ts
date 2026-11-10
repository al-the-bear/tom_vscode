/**
 * The review team of a document and the record of its rounds (SOM §11.9.8,
 * CC-89, CC-90), read from a SOM document and from a round folder's
 * `round.yaml`: what the round tools start a round with and what the MD
 * Browser names and colours the members by.
 *
 * vscode-free (the MD Browser's worker thread loads it).
 */

import * as fs from 'fs';
import * as path from 'path';

import { SpecQuery, SpecQueryEngine, type SpecDocument, type SpecModel } from 'tom_som_typescript_runtime';

import { ROUND_FILE, parseRound, type RoundMember } from '../utils/reviewRound';

/** A team's member list: a ReviewTeam's `members`. */
export const MEMBER_LIST = 'RVMEM-MEMB-LST';
/** A revision entry's team and reviewers (ReviewerRecord lists). */
const REVISION_TEAM_LIST = 'RVWER-TEAM-LST';
const REVISION_REVIEWERS_LIST = 'RVWER-RETN-LST';

export interface TeamMember extends RoundMember {
    owner?: boolean;
    /** A reviewer who is not on the team (CC-90). */
    guest?: boolean;
}

/** One revision with the round that led to it. */
export interface RevisionRecord {
    version: string;
    date: string;
    author: string;
    summary: string;
    /** The team the round started with. */
    team: TeamMember[];
    /** Who returned a reviewed copy, guests marked. */
    reviewers: TeamMember[];
}

const truthy = (v: string | null): boolean => /^(true|yes)$/i.test((v ?? '').trim());

/** The member records of a list at `listPath` (a ReviewTeam's members or a revision's ReviewerRecords); [] when the path is none of the document's. */
function readMemberList(doc: SpecDocument, listPath: string): TeamMember[] {
    let items: string[];
    try { items = doc.listItems(listPath); } catch { return []; }
    const out: TeamMember[] = [];
    for (const item of items) {
        const form = `${item}/content`;
        const memberId = (doc.formField(form, 'memberId') ?? '').trim();
        if (!memberId) { continue; }
        out.push({
            memberId,
            displayName: (doc.formField(form, 'displayName') ?? '').trim() || memberId,
            role: (doc.formField(form, 'role') ?? '').trim() || 'reviewer',
            ...(truthy(doc.formField(form, 'owner')) ? { owner: true } : {}),
            ...(truthy(doc.formField(form, 'guest')) ? { guest: true } : {}),
        });
    }
    return out;
}

/** The members of a ReviewTeam's member list at `listPath`, in order. */
export function readTeamMembers(doc: SpecDocument, listPath: string): Array<TeamMember & { owner: boolean }> {
    return readMemberList(doc, listPath).map((m) => ({ ...m, owner: m.owner === true }));
}

/** The nodes of `className` under the document's own root (the query also walks the model's other roots). */
export function pathsOfClass(model: SpecModel, doc: SpecDocument, rootId: string, className: string): string[] {
    const cursor = new SpecQueryEngine(model, doc).query(new SpecQuery({ className }));
    return cursor.take(cursor.count).map((m) => m.path).filter((p) => p.startsWith(`${rootId}/`));
}

/** The document's own review team (its root's `reviewTeam`); [] when it names none. */
export function documentTeam(doc: SpecDocument, rootId: string): Array<TeamMember & { owner: boolean }> {
    return readTeamMembers(doc, `${rootId}/reviewTeam/${MEMBER_LIST}`);
}

/**
 * The revision history of a document, in document order: every RevisionEntry
 * under its root with its version, date, author and summary, the team its
 * round started with and the reviewers who returned a copy — a reviewer not on
 * that team (or recorded as one) marked as a guest.
 */
export function readRevisionHistory(model: SpecModel, doc: SpecDocument, rootId: string): RevisionRecord[] {
    return pathsOfClass(model, doc, rootId, 'RevisionEntry').map((entry) => {
        const form = `${entry}/content`;
        const team = readMemberList(doc, `${entry}/${REVISION_TEAM_LIST}`);
        const ids = new Set(team.map((m) => m.memberId));
        const reviewers = readMemberList(doc, `${entry}/${REVISION_REVIEWERS_LIST}`)
            .map((r) => (r.guest || (ids.size > 0 && !ids.has(r.memberId)) ? { ...r, guest: true } : r));
        return {
            version: (doc.formField(form, 'version') ?? '').trim(),
            date: (doc.formField(form, 'date') ?? '').trim(),
            author: (doc.formField(form, 'author') ?? '').trim(),
            summary: (doc.formField(form, 'summary') ?? '').trim(),
            team,
            reviewers,
        };
    });
}

/**
 * The round a file belongs to: `round.yaml` in its own folder (a member's
 * copy, the base) or the folder above (`merged/<document>`). Its team in team
 * order, then its guests marked; null when the file is in no round folder or
 * the round file does not read.
 */
export function roundTeamFor(filePath: string): { roundFile: string; members: TeamMember[] } | null {
    const dir = path.dirname(filePath);
    for (const folder of [dir, path.dirname(dir)]) {
        const file = path.join(folder, ROUND_FILE);
        if (!fs.existsSync(file)) { continue; }
        try {
            const round = parseRound(fs.readFileSync(file, 'utf8'));
            return {
                roundFile: file,
                members: [...round.team.map((m) => ({ ...m })), ...round.guests.map((g) => ({ ...g, guest: true }))],
            };
        } catch {
            return null;
        }
    }
    return null;
}
