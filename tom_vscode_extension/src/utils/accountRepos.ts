/**
 * The repositories of the signed-in account among the ones the Issues panel
 * lists ("My Repos (<account>)"): owned by the account — the `owner` part of
 * an `owner/repo` id equals its login, in any case — and not forks. A clone
 * of somebody else's repository is excluded by its owner; a fork the account
 * owns by the fork flag the provider reports. When that flag cannot be read
 * (network, permissions) the repository is kept: it is the account's, and
 * nothing says it is a fork. vscode-free.
 */

/** The ids of `repoIds` that belong to `login` and are no forks, in their order. */
export async function ownAccountRepoIds(
    repoIds: readonly string[],
    login: string,
    isFork: (repoId: string) => Promise<boolean>,
): Promise<string[]> {
    const account = login.trim().toLowerCase();
    if (!account) { return []; }
    const owned = repoIds.filter((id, i) => {
        const slash = id.indexOf('/');
        return slash > 0 && id.slice(0, slash).toLowerCase() === account && repoIds.indexOf(id) === i;
    });
    const forks = await Promise.all(owned.map(async (id) => {
        try { return await isFork(id); } catch { return false; }
    }));
    return owned.filter((_id, i) => !forks[i]);
}
