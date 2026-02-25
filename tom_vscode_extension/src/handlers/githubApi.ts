/**
 * GitHub REST API Service
 *
 * Uses VS Code's built-in GitHub authentication to acquire tokens.
 * Provides typed wrappers around the Issues API endpoints.
 */

import * as vscode from 'vscode';

// ============================================================================
// Types (GitHub API response shapes — snake_case matches the REST API)
// ============================================================================

/* eslint-disable @typescript-eslint/naming-convention */

export interface GitHubUser {
    login: string;
    avatar_url: string;
}

export interface GitHubLabel {
    id: number;
    name: string;
    color: string;
    description?: string;
}

export interface GitHubIssue {
    id: number;
    number: number;
    title: string;
    body: string | null;
    state: 'open' | 'closed';
    labels: GitHubLabel[];
    user: GitHubUser;
    created_at: string;
    updated_at: string;
    comments: number;
    html_url: string;
}

export interface GitHubComment {
    id: number;
    body: string;
    user: GitHubUser;
    created_at: string;
    updated_at: string;
    html_url: string;
}

/* eslint-enable @typescript-eslint/naming-convention */

export interface RepoInfo {
    owner: string;
    repo: string;
    /** Display name shown in the dropdown, e.g. "owner/repo" */
    displayName: string;
}

// ============================================================================
// Authentication
// ============================================================================

let _cachedToken: string | undefined;

/**
 * Get a GitHub personal access token via VS Code's authentication API.
 * Prompts the user to sign in on first use.
 */
async function getToken(): Promise<string> {
    if (_cachedToken) {
        return _cachedToken;
    }
    const session = await vscode.authentication.getSession('github', ['repo'], {
        createIfNone: true,
    });
    _cachedToken = session.accessToken;
    return _cachedToken;
}

/** Clear cached token (e.g. on auth failure) */
export function clearTokenCache(): void {
    _cachedToken = undefined;
}

// ============================================================================
// HTTP helpers
// ============================================================================

const API_BASE = 'https://api.github.com';

async function apiRequest<T>(
    method: string,
    path: string,
    body?: unknown,
): Promise<T> {
    const token = await getToken();
    const url = `${API_BASE}${path}`;

    /* eslint-disable @typescript-eslint/naming-convention */
    const headers: Record<string, string> = {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    };
    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
    }
    /* eslint-enable @typescript-eslint/naming-convention */

    const resp = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        if (resp.status === 401) {
            clearTokenCache();
        }
        throw new Error(`GitHub API ${method} ${path} failed: ${resp.status} ${resp.statusText} – ${text}`);
    }

    // 204 No Content
    if (resp.status === 204) {
        return undefined as unknown as T;
    }

    return (await resp.json()) as T;
}

// ============================================================================
// Issue Operations
// ============================================================================

/**
 * List issues for a repository.
 * @param state - 'open', 'closed', or 'all'
 */
export async function listIssues(
    owner: string,
    repo: string,
    state: 'open' | 'closed' | 'all' = 'open',
    page = 1,
    perPage = 30,
): Promise<GitHubIssue[]> {
    return apiRequest<GitHubIssue[]>(
        'GET',
        `/repos/${owner}/${repo}/issues?state=${state}&per_page=${perPage}&page=${page}&sort=updated&direction=desc`,
    );
}

/** Get a single issue */
export async function getIssue(
    owner: string,
    repo: string,
    issueNumber: number,
): Promise<GitHubIssue> {
    return apiRequest<GitHubIssue>(
        'GET',
        `/repos/${owner}/${repo}/issues/${issueNumber}`,
    );
}

/** List comments for an issue */
export async function listComments(
    owner: string,
    repo: string,
    issueNumber: number,
    page = 1,
    perPage = 100,
): Promise<GitHubComment[]> {
    return apiRequest<GitHubComment[]>(
        'GET',
        `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=${perPage}&page=${page}`,
    );
}

/** Create a new issue */
export async function createIssue(
    owner: string,
    repo: string,
    title: string,
    body: string,
    labels?: string[],
): Promise<GitHubIssue> {
    return apiRequest<GitHubIssue>(
        'POST',
        `/repos/${owner}/${repo}/issues`,
        { title, body, labels },
    );
}

/** Add a comment to an issue */
export async function addComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
): Promise<GitHubComment> {
    return apiRequest<GitHubComment>(
        'POST',
        `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
        { body },
    );
}

/** Update issue state (open/closed) or labels */
export async function updateIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    updates: { state?: 'open' | 'closed'; labels?: string[]; title?: string; body?: string },
): Promise<GitHubIssue> {
    return apiRequest<GitHubIssue>(
        'PATCH',
        `/repos/${owner}/${repo}/issues/${issueNumber}`,
        updates,
    );
}

// ============================================================================
// Repo Discovery
// ============================================================================

/**
 * Discover GitHub repos from workspace git remotes.
 * Parses `origin` remote URLs from `.git/config` files.
 */
export function discoverWorkspaceRepos(): RepoInfo[] {
    const repos: RepoInfo[] = [];
    const seen = new Set<string>();

    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (gitExtension?.isActive) {
        const gitApi = gitExtension.exports.getAPI(1);
        for (const gitRepo of gitApi.repositories) {
            for (const remote of gitRepo.state.remotes) {
                const url = remote.fetchUrl || remote.pushUrl;
                if (!url) { continue; }
                const parsed = parseGitHubUrl(url);
                if (parsed && !seen.has(parsed.displayName)) {
                    seen.add(parsed.displayName);
                    repos.push(parsed);
                }
            }
        }
    }

    return repos;
}

/** Parse a GitHub remote URL into owner/repo */
function parseGitHubUrl(url: string): RepoInfo | undefined {
    // HTTPS: https://github.com/owner/repo.git
    let match = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (match) {
        return {
            owner: match[1],
            repo: match[2],
            displayName: `${match[1]}/${match[2]}`,
        };
    }
    return undefined;
}

/**
 * Upload a file as an attachment on a GitHub issue comment.
 *
 * GitHub doesn't have a direct attachment API — attachments must be uploaded
 * via the "uploads" endpoint (used by the web UI). For now we embed files
 * inline as base64 data in the comment body, or the user can use GitHub's
 * drag-drop web interface.
 *
 * This is a simplified implementation — returns markdown for the attachment.
 */
export function formatAttachmentMarkdown(fileName: string, base64Content: string, mimeType: string): string {
    if (mimeType.startsWith('image/')) {
        return `![${fileName}](data:${mimeType};base64,${base64Content})`;
    }
    return `**Attachment:** ${fileName}\n\`\`\`\n${Buffer.from(base64Content, 'base64').toString('utf-8')}\n\`\`\``;
}

// ============================================================================
// Attachment Support via Contents API
// ============================================================================

/** Marker prefix in comment body to identify attachment comments */
export const ATTACHMENT_COMMENT_MARKER = '<!-- tom-attachment:';

/** Response from GitHub Contents API PUT */
interface GitHubContentResponse {
    content: { sha: string; html_url: string; download_url: string; size: number; path: string };
}

/**
 * Upload a file to the repo via the Contents API.
 * Creates a commit adding the file at the given path.
 */
export async function uploadFileToRepo(
    owner: string,
    repo: string,
    repoPath: string,
    base64Content: string,
    commitMessage: string,
): Promise<GitHubContentResponse> {
    return apiRequest<GitHubContentResponse>(
        'PUT',
        `/repos/${owner}/${repo}/contents/${repoPath}`,
        { message: commitMessage, content: base64Content },
    );
}

/**
 * Delete a file from the repo via the Contents API.
 * Requires the file's SHA.
 */
export async function deleteFileFromRepo(
    owner: string,
    repo: string,
    repoPath: string,
    sha: string,
    commitMessage: string,
): Promise<void> {
    await apiRequest<void>(
        'DELETE',
        `/repos/${owner}/${repo}/contents/${repoPath}`,
        { message: commitMessage, sha },
    );
}

/** Get file info (including SHA) from the Contents API. */
export async function getFileInfo(
    owner: string,
    repo: string,
    repoPath: string,
): Promise<{ sha: string; size: number; download_url: string } | undefined> {
    try {
        const result = await apiRequest<{ sha: string; size: number; download_url: string }>(
            'GET',
            `/repos/${owner}/${repo}/contents/${repoPath}`,
        );
        return result;
    } catch {
        return undefined;
    }
}

/** List files in a directory via the Contents API. */
export async function listRepoDirectory(
    owner: string,
    repo: string,
    dirPath: string,
): Promise<Array<{ name: string; sha: string; size: number; download_url: string; path: string }>> {
    try {
        return await apiRequest<Array<{ name: string; sha: string; size: number; download_url: string; path: string }>>(
            'GET',
            `/repos/${owner}/${repo}/contents/${dirPath}`,
        );
    } catch {
        return [];
    }
}

/** Delete a comment from an issue */
export async function deleteComment(
    owner: string,
    repo: string,
    commentId: number,
): Promise<void> {
    await apiRequest<void>(
        'DELETE',
        `/repos/${owner}/${repo}/issues/comments/${commentId}`,
    );
}
