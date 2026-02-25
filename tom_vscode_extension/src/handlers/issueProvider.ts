/**
 * Issue Provider Abstraction
 *
 * Defines a provider-agnostic interface for issue tracking systems.
 * Implementations exist for GitHub (built-in); Jira, Bugzilla, and
 * other backends can be added by implementing `IssueProvider`.
 */

// ============================================================================
// Normalized Types
// ============================================================================

/** A repository / project as understood by the provider */
export interface IssueProviderRepo {
    /** Provider-specific unique ID (e.g. "owner/repo" for GitHub, project key for Jira) */
    id: string;
    /** Human-readable name shown in the dropdown */
    displayName: string;
}

export interface IssueUser {
    name: string;
    avatarUrl: string;
}

export interface IssueItem {
    id: string;
    number: number;
    title: string;
    body: string | null;
    state: string;
    labels: string[];
    author: IssueUser;
    createdAt: string;          // ISO 8601
    updatedAt: string;          // ISO 8601
    commentCount: number;
    url: string;                // web URL for "open in browser"
}

export interface IssueComment {
    id: string;
    body: string;
    author: IssueUser;
    createdAt: string;
    updatedAt: string;
    url: string;
}

export interface IssueUpdates {
    state?: string;
    labels?: string[];
    title?: string;
    body?: string;
}

export interface AttachmentInfo {
    /** Unique identifier (comment ID for GitHub, filename for local) */
    id: string;
    /** Display name of the attached file */
    name: string;
    /** File size in bytes */
    size: number;
    /** URL to access/download the file */
    url: string;
    /** MIME type, if known */
    mimeType?: string;
}

// ============================================================================
// Provider Interface
// ============================================================================

export interface IssueProvider {
    /** Unique provider identifier (e.g. "github", "jira") */
    readonly providerId: string;
    /** Human-readable name for UI */
    readonly displayName: string;

    /** Discover repos/projects from the current workspace (e.g. git remotes) */
    discoverRepos(): IssueProviderRepo[];

    /** List issues in a repo/project */
    listIssues(repoId: string, state: string): Promise<IssueItem[]>;

    /** Get a single issue */
    getIssue(repoId: string, issueNumber: number): Promise<IssueItem>;

    /** Create a new issue */
    createIssue(repoId: string, title: string, body: string): Promise<IssueItem>;

    /** Add a comment to an issue */
    addComment(repoId: string, issueNumber: number, body: string): Promise<IssueComment>;

    /** List comments on an issue */
    listComments(repoId: string, issueNumber: number): Promise<IssueComment[]>;

    /**
     * Change the effective status of an issue.
     * @param statusList - The full list of configured statuses so the provider
     *   can manage provider-specific mappings (e.g. GitHub labels for custom states).
     */
    changeStatus(repoId: string, issueNumber: number, status: string, statusList: string[]): Promise<IssueItem>;

    /**
     * Toggle a label on an issue.
     * For key=value labels (e.g. "quicklabel=Flaky"), only one value per key
     * is active at a time — toggling replaces any existing label with the same key.
     */
    toggleLabel(repoId: string, issueNumber: number, label: string): Promise<IssueItem>;

    // ---- Optional Attachment Support ----

    /** Whether this provider supports file attachments. */
    readonly supportsAttachments?: boolean;

    /**
     * Upload a file attachment to an issue.
     * @returns The attachment info for the uploaded file.
     */
    uploadAttachment?(repoId: string, issueNumber: number, filePath: string, fileName: string): Promise<AttachmentInfo>;

    /** List all attachments on an issue. */
    listAttachments?(repoId: string, issueNumber: number): Promise<AttachmentInfo[]>;

    /** Delete an attachment from an issue. */
    deleteAttachment?(repoId: string, issueNumber: number, attachmentId: string): Promise<void>;
}

// ============================================================================
// Provider Registry
// ============================================================================

const _providers = new Map<string, IssueProvider>();

export function registerIssueProvider(provider: IssueProvider): void {
    _providers.set(provider.providerId, provider);
}

export function getIssueProvider(providerId: string): IssueProvider | undefined {
    return _providers.get(providerId);
}

export function getDefaultProvider(): IssueProvider | undefined {
    return _providers.values().next().value;
}
