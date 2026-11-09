# pi-note

Project-level **file-based memory** + a per-session **scratchpad dir** for pi,
ported from Claude Code's two mechanisms. Full behavioral spec: `../../docs/pi-note.md`.

Four hooks and one command — nothing appears in the UI unless you run
`/memory` or memory init fails (one error notify).

| Hook | What it does |
|---|---|
| `session_start` | create dirs, set `PI_NOTE_SCRATCHPAD_DIR`, snapshot `MEMORY.md` into memory |
| `before_agent_start` | append the rules text + the frozen `MEMORY.md` index snapshot to the system prompt; announce a `MEMORY.md` change made while idle |
| `agent_end` | take the closing `MEMORY.md` baseline and settle a pending announcement |
| `tool_call` | rewrite a leading `$PI_NOTE_SCRATCHPAD_DIR` / `${PI_NOTE_SCRATCHPAD_DIR}` prefix in non-shell tool arguments |

The agent reads and writes memories itself with its built-in `read`/`write`/
`edit`/`bash` tools; the plugin never parses memory files and never maintains
anything itself. The only exception is deleting through the `/memory` overlay
(file + its index line), described below.

## `/memory` — browse this project's memories

A two-level overlay over the memory dir (`browser.ts`). It reads from disk on
every invocation, so memories written after `session_start` show up immediately
— unlike the frozen snapshot injected into the system prompt.

```
╭──────────────────────────────────────────────────────────────────╮
│ Memory · ~/repo/pi-setup                          3 topics       │
│ ──────────────────────────────────────────────────────────────── │
│ › Computer use 路线决策                          623 B · now      │
│     因 Hyprland 不支持双 seat，首版明确采用真实桌面单 seat。      │
│   插件管理分工                                    688 B · 9mo     │
│     settings.json 已负责多机同步；pi-setup 收编小插件源码。       │
│   Deleted                                         missing        │
│ ── unindexed (1) ──────────────────────────────────────────────  │
│   draft-notes.md                                  12 B · 1mo     │
│ ──────────────────────────────────────────────────────────────── │
│ Search: draft                                                     │
│ ↑↓ navigate · Enter open · Ctrl+D delete · Esc close                  │
╰──────────────────────────────────────────────────────────────────╯
```

- **Level 1** — one row per `MEMORY.md` line (title as link text, hook as the
  dim second line), fuzzy-filtered over title, file name and hook as you type.
  Memory files that no index line points at are listed under `unindexed` — such
  a file is invisible to every future session, so it is worth seeing.
- **Right-hand column** — `size · age` (e.g. `623 B · 9mo`), so a memory nobody
  has touched in months stands out. The age is relative on purpose: `9mo` reads
  at a glance where a date does not. A file the index points at but that is not
  on disk shows `missing` in its place (the index is stale); a nested `sub/x.md`
  target shows nothing (no stats), and such a row must be opened to learn why.
  The column is dropped on a narrow overlay so the title keeps its room.
- **Level 2** — `Enter` opens the linked file rendered as markdown,
  scrollable with `↑↓` / `PgUp` / `PgDn` / `Home` / `End` and a line counter in
  the footer. The row under the title is the file's **absolute path** (truncated
  from the left on a narrow overlay, so the file name stays visible).
- **Editing** — `Enter` in the detail view hands the file to the external
  editor (`settings.json` `externalEditor` → `$VISUAL` → `$EDITOR` → `nano`,
  the same chain pi uses for Ctrl+G), then re-reads it so the rendered body is
  never stale. A non-zero exit or a failed spawn is reported in the hint row.
  On a very short terminal the path row is dropped rather than overflowing the
  frame.
- **Keys** — `Esc` closes the list, but only steps back a level from the detail
  view (the search query survives); `Ctrl+C` closes from either level.
- **Deleting** — `Ctrl+D` in the list arms the selected memory (the hint row
  turns into `Ctrl+D again to delete “Title”`, any other key cancels); a second
  `Ctrl+D` removes the file **and** its `MEMORY.md` line. Indexed, unindexed and
  stale (`missing`) rows all work; the index is rewritten atomically. A failed
  delete is reported and changes nothing.

## MEMORY.md refresh — changes made between turns

The frozen snapshot has one consequence: a memory another agent (dsh, another
pi session, your editor) writes mid-session would stay invisible. The plugin
closes that gap without giving up the stable prompt prefix.

The window is **the end of the previous turn to the start of the next one**:

1. `agent_end` takes a baseline of `MEMORY.md` (and `session_start` does, from
the very bytes the model was given);
2. `before_agent_start` of the next turn probes it — `stat` first, so an
unchanged mtime/size means no read at all;
3. once the metadata moved, the content digest decides: a `touch`, or a
byte-identical save by an editor, announces nothing;
4. a real change enters the turn as one hidden message (`customType`
`note-memory-refresh`, `display: false`): it names the file, lists the index
lines that appeared or disappeared, and carries the new index (capped at
`memoryRefreshMaxChars`). `display: false` hides it from the transcript, but it
is a normal user-role message in the payload, so the model reads it.

Because the window starts *after* a turn, everything this session writes during
its own turn is already in the closing baseline — no tool hooks, and no echo of
the agent's own writes. The flip side: a write that lands **during** a turn
(this session's, a subagent's, or another agent's) is folded into that closing
baseline and is not announced, because nothing distinguishes it from the
session's own work.

The baseline only advances for an announcement that provably reached the run
(the custom message is in the finished run's messages), so an abort between the
injection and the loop announces the change again next turn instead of losing
it. A read that races a write (`stat` before and after disagree) is skipped and
retried next turn rather than adopted half-read.

Known blind spots:

1. only `MEMORY.md` is watched; editing a topic file without an index line
   announces nothing;
2. the fast path hides a rewrite that preserves both mtime and size (`cp -p`,
   `git checkout` of a file whose stat matches). That is what keeps the check to
   one `stat` per turn;
3. compaction may drop an announcement like any other message; the rules text
   already tells the agent to read `MEMORY.md` directly after compaction.

Configured from `settings.json`, read at `session_start` (so `/reload` picks up
a change). Both fall back to the default on any read failure, and only an
explicit `false` turns the refresh off:

| Key | Default | Meaning |
|---|---|---|
| `memoryRefresh` | `true` | Announce `MEMORY.md` changes made between turns |
| `memoryRefreshMaxChars` | `16000` | Cap on the index content copied into one announcement |

## Directory layout

```
~/.claude/projects/-home-sjet-repo-pi-setup/memory/   # project memory, shared
├── MEMORY.md                        # index, one line per memory
├── cli-preferences.md
└── two-clone-workflow.md

/tmp/pi-note-<uid>/<session-id>/     # session scratchpad, mode 0700
```

- The memory dir **is Claude Code's auto-memory dir**, not a pi-note-owned one:
  `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<claude-slug>/memory`. Claude Code,
  pi and dsh therefore read and write the same files, and the file format is
  Claude Code's (frontmatter `name` / `description` / `metadata.type`, see
  "Memory format" below). Resolution lives in `paths.ts` (pure slug math) and
  `claude-memory.ts` (env + Claude Code's `settings.json`):
  1. `<claude-slug>` = the directory with every character outside
     `[A-Za-z0-9]` replaced by `-` (case kept), e.g.
     `-home-sjet-repo-pi-setup`; past 200 characters a `-<base36>` suffix is
     appended, exactly like Claude Code, so both sides always agree;
  2. the input is first normalized to the **git root**
     (`git rev-parse --git-common-dir`), so every `git worktree` of one
     repository shares the main checkout's memory dir — the same key Claude
     Code uses; outside a repository the cwd is used as-is;
  3. `$CLAUDE_CONFIG_DIR` and Claude Code's `autoMemoryDirectory` user setting
     are mirrored; cowork/remote memory env vars and `autoMemoryEnabled` are
     not (they would mean splitting the two tools silently).
- `<uid>` is the numeric OS user id, so separate users of one machine never
  collide in the world-writable `/tmp`.
- `<session-id>` is pi's globally-unique session UUID. `/fork`/`/clone` start a
  fresh scratchpad dir; two pi windows never overwrite each other's files.
- The scratchpad lives under `/tmp` (tmpfs here, auto-cleaned after 10 days by
  systemd `tmpfiles.d`) — no expiry handling is built in.

The memory dir is only ever created by `session_start`. Memories are plain
markdown files; `/memory` browses them and can delete one (file + index line),
nothing else manages them.

## Memory format

One file per topic, named after its frontmatter `name`
(`ask-behavior-not-tech.md`), plus the `MEMORY.md` index with one
`- [Title](file.md) — hook` line per memory. Claude Code selects memories by
the frontmatter, so pi-note writes it too:

```markdown
---
name: ask-behavior-not-tech
description: Ask frontend decisions as visible behavior, never as implementation choices
metadata:
  type: feedback
---
Ask about behavior ("clicking Save should keep the dialog open"), not about
routing or composables.

**Why:** implementation words make the user pick a design they did not ask for.
**How to apply:** every frontend decision question, before writing code.
```

`metadata.type` is one of `user` / `feedback` / `project` / `reference`;
`feedback` and `project` bodies lead with the rule, then `**Why:**` and
`**How to apply:**`. `/memory` renders the body with the frontmatter block
stripped (`memory-index.ts` `splitFrontmatter`), while the header byte count is
the whole file.

This does **not** touch `~/dotfiles/pi-agent/pi-hermes-memory/` (a different
plugin's store) — pi-note neither reads, writes, nor migrates it.

## Disabling

Remove `"./extensions/pi-note/index.ts"` from the top-level `package.json`
`pi.extensions` list (or filter it out in `settings.json`, see the setup
README). There is no per-session toggle; the closest thing is
`"memoryRefresh": false`, which keeps the memory snapshot but stops the
between-turn announcements.

## Environment

`PI_NOTE_SCRATCHPAD_DIR` is exported into `process.env` at `session_start`;
bash and `!` commands expand it natively. Non-shell tools (read/write/edit/
grep/find/ls/…) get the leading `$PI_NOTE_SCRATCHPAD_DIR` literal expanded by
the `tool_call` hook — only at the start of a top-level string value, never
mid-string and never inside arrays/nested objects.
