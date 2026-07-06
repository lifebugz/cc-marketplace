---
name: merge
description: Merge the pull request for the current branch (or a given PR number) and clean up - checks readiness first, then merges, deletes the branch, and syncs the default branch. Flags - --pr <number> (target a specific PR), --squash / --rebase / --merge (strategy), --no-delete (keep the branch), --auto (enable auto-merge if checks are still running).
argument-hint: "[--pr <number>] [--squash|--rebase|--merge] [--no-delete] [--auto]"
disable-model-invocation: true
model: sonnet
allowed-tools: Bash(git status *) Bash(git log *) Bash(git switch *) Bash(git pull *) Bash(git branch *) Bash(git fetch *) Bash(gh pr *) Bash(gh repo view *)
---

# Merge: verify → merge PR → clean up

Arguments: $ARGUMENTS

## State (captured at invocation)

```
!`git status --branch --short 2>/dev/null || echo "(not a git repository)"`
```

```
!`gh pr view --json number,title,state,isDraft,mergeable,reviewDecision,url 2>/dev/null || echo "(no PR found for the current branch)"`
```

## Flags

| Flag                             | Effect                                                        |
| -------------------------------- | ------------------------------------------------------------- |
| `--pr <number>`                  | Merge that PR instead of the current branch's                 |
| `--squash` / `--rebase` / `--merge` | Merge strategy (default: squash if the repo allows it, else a merge commit) |
| `--no-delete`                    | Keep the head branch after merging                            |
| `--auto`                         | If checks are still running, enable auto-merge instead of waiting |

## Workflow

### 1. Identify the PR

Use `--pr <number>` if given, otherwise the PR shown in the state above. If there is no PR, say so and stop - suggest `/git:ship` to create one.

### 2. Check readiness

Look at the state above and `gh pr checks <number>`. Do not merge when:

- the PR is a draft (offer `gh pr ready` if the user confirms it's done),
- checks are failing - report which ones and stop,
- the review decision is `CHANGES_REQUESTED` - unresolved feedback is a human call, not yours.

If checks are still *pending*: with `--auto`, run the merge with `--auto` so GitHub merges when they pass; otherwise report that checks are running and stop rather than merging blind.

Also warn if the working tree has uncommitted changes - the post-merge branch switch can collide with them.

### 3. Merge

Pick the strategy: an explicit flag wins; otherwise check `gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed` and prefer squash, then merge commit. Then:

```bash
gh pr merge <number> --<strategy> [--auto] [--delete-branch]
```

Include `--delete-branch` unless `--no-delete` - it also switches you back to the default branch when the merged branch was checked out. Never use `--admin` to bypass branch protection.

### 4. Sync and report

After a completed merge, `git pull` on the default branch and prune with `git fetch --prune`. End with: the merged PR URL, the strategy used, and what was cleaned up (or that auto-merge is armed and what it is waiting on).

## Safety rules

- Never merge over failing checks, requested changes, or branch protection (`--admin`).
- Never delete a branch that has unpushed local commits - report them instead.
