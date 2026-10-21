# pi-mr

Show the current branch's merge request (GitLab) or pull request (GitHub) in pi's
bottom status line — the line pi appends below the footer:

```
⬤ !31681 ✓CI feat(oa-web): 顶部导航、工作台与移动端骨架，DevOps 其他服务迁移…
```

The branch name is not repeated: pi's footer already prints `~/repo/foo (branch)`
on the line directly above.

## What each part means

| # | Token | Meaning |
|---|-------|---------|
| 1 | `⬤` / `◌` / `✔` / `✕` | open · draft · merged · closed (green / dim / accent / red) |
| 2 | `!31681` / `#42` | request ref, an OSC 8 hyperlink to the request |
| 3 | `✓CI` / `✗CI` / `⋯CI` | head pipeline success · failed-or-cancelled · queued/running (omitted when unknown) |
| 4 | `⚠冲突` | open request whose branch conflicts with the target branch (GitLab only) |
| 5 | title | request title, truncated by pi to the terminal width |

Nothing is shown — no placeholder — when the directory is not a git repo, the
branch has no request, the HEAD is detached, no forge remote exists, or the CLI
fails. Stale data is never shown; a failed lookup clears the line and backs off.

## How data is fetched

1. `git rev-parse --abbrev-ref HEAD` every 5s, so `git switch` is picked up promptly (5s `git` timeout).
2. The forge is resolved from the remote URLs once per session: any non-GitHub
   host means `glab` (self-hosted GitLab included); only an all-GitHub remote set
   means `gh`. This is why a repo that mirrors to GitHub with a corporate
   GitLab `glab` remote resolves to GitLab.
3. The request is queried when the branch changes or every 60s (20s CLI timeout):

   | Forge | Command |
   |-------|---------|
   | GitLab | `glab api 'projects/:fullpath/merge_requests?state=all&source_branch=<branch>&order_by=updated_at&sort=desc'` |
   | GitHub | `gh pr list --head <branch> --state all --limit 5 --json number,title,state,isDraft,statusCheckRollup,url` |

   GitLab selection: newest open request, else newest of any state. GitHub
   selection: same rule over `gh`'s output.
4. GitLab CI fallback: `head_pipeline` can be null (self-hosted instances leave it
   empty), so a second call reads the head commit's `last_pipeline`:

   `glab api 'projects/:fullpath/repository/commits/<sha>'`

   `glab`'s own auth is reused, so no tokens are stored here. A missing CLI, a
   logged-out host or a network error hides the line and retries after 5 minutes.

## Install

Included in pi-setup:

```bash
pi install git:github.com/sjet47/pi-setup
```

Requirements: `git`, plus `glab` (GitLab) and/or `gh` (GitHub) logged in.

Run the tests with `npm run test:mr` from the repository root. They cover URL
parsing, forge detection, payload normalization and CI mapping — no I/O. Payload
shapes were verified against a GitLab MR without `head_pipeline`
(`!31681`, 2026-10-21) and `gh pr list` output.
