---
name: ship
description: Commit, push, and open a pull request for the current changes in one flow. Flags skip steps - --no-pr (commit and push only), --no-push (commit only), --draft (draft PR), --base <branch> (PR base). Remaining arguments hint the commit message.
argument-hint: "[--no-pr] [--no-push] [--draft] [--base <branch>] [message hint]"
disable-model-invocation: true
model: sonnet
allowed-tools: Bash(git status *) Bash(git diff *) Bash(git log *) Bash(git add *) Bash(git commit *) Bash(git push *) Bash(git branch *) Bash(git switch *) Bash(git rev-parse *) Bash(git remote *) Bash(gh pr *)
---

# Ship: commit → push → PR

Arguments: $ARGUMENTS

## Repository state (captured at invocation)

```
!`git status --branch --short 2>/dev/null || echo "(not a git repository)"`
```

Recent commits (match their message style):

```
!`git log --oneline -8 --no-decorate 2>/dev/null || echo "(no commits yet)"`
```

## Flags

Parse flags from the arguments above; everything that is not a flag is a hint for the commit message and PR title.

| Flag              | Effect                                              |
| ----------------- | --------------------------------------------------- |
| `--no-pr`         | Stop after pushing - no pull request                |
| `--no-push`       | Stop after committing - implies `--no-pr`           |
| `--draft`         | Open the pull request as a draft                    |
| `--base <branch>` | PR base branch (default: the repo's default branch) |

## Workflow

Run the steps in order, skipping the ones disabled by flags.

### 1. Review the changes

Look at the state above and run `git diff HEAD` (plus `git status` for untracked files) to understand what changed. If the working tree is clean but the branch has unpushed commits, skip straight to step 4. If there is nothing to commit and nothing to push, say so and stop.

### 2. Get off the default branch (PR step only)

A PR cannot come from the branch it targets. If a PR will be created and you are on the default branch (`git remote show origin` or `main`/`master`), create a descriptive branch first: `git switch -c <type>/<short-slug>` derived from the change. With `--no-push` or `--no-pr`, stay on the current branch.

### 3. Stage and commit

Stage the files that belong to this change by path - avoid `git add -A` so unrelated edits and junk files stay out. Never stage likely secrets (`.env`, key files, hardcoded credentials). If a secret is tangled into a file that also has legitimate changes, leave that whole file unstaged, ship the rest only if it stands alone as a working change, and warn the user clearly so they can rotate the key and re-commit the clean part.

Write the commit message from the actual diff, following the style of the recent commits above (e.g. conventional `type(scope): summary`). Use the user's message hint as the subject's basis when given. Add a short body explaining *why* for non-trivial changes.

If a commit hook fails, fix the reported problems and retry once. If the hook modified files, stage those and amend the not-yet-pushed commit. Never use `--no-verify`.

### 4. Push (skip with `--no-push`)

`git push -u origin HEAD`. If the push is rejected (non-fast-forward), do not force-push - report the situation and stop.

### 5. Pull request (skip with `--no-pr` or `--no-push`)

First check `gh pr view --json url` - if a PR already exists for this branch, the push updated it; report its URL and finish. Otherwise:

```bash
gh pr create --title "<title>" --body "<body>" [--draft] [--base <branch>]
```

Title: the commit subject (or a summary of all commits being merged). Body: a `## Summary` with 1-3 bullets and a `## Test plan` describing how to verify.

If `gh` is missing, unauthenticated, or there is no GitHub remote, the commit and push still succeeded - report that, explain why the PR step was skipped, and give the compare URL (`<remote-url>/compare/<branch>`) so the user can open the PR manually.

### 6. Report

End with a short summary: commit SHA and subject, branch pushed, and the PR URL (or which steps were skipped and why).

## Safety rules

- Never force-push, never `--no-verify`, never amend commits that have already been pushed.
- Only ship work from this session or changes the user asked to ship - if the working tree contains unrelated changes, leave them unstaged and mention them.
