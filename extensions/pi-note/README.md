# pi-note

Project-level **file-based memory** + a per-session **scratchpad dir** for pi,
ported from Claude Code's two mechanisms. Full behavioral spec: `../../docs/pi-note.md`.

Three hooks and one **read-only** command — nothing appears in the UI unless you
run `/memory` or memory init fails (one error notify).

| Hook | What it does |
|---|---|
| `session_start` | create dirs, set `PI_NOTE_SCRATCHPAD_DIR`, snapshot `MEMORY.md` into memory |
| `before_agent_start` | append the rules text + the frozen `MEMORY.md` index snapshot to the system prompt |
| `tool_call` | rewrite a leading `$PI_NOTE_SCRATCHPAD_DIR` / `${PI_NOTE_SCRATCHPAD_DIR}` prefix in non-shell tool arguments |

The agent reads and writes memories itself with its built-in `read`/`write`/
`edit`/`bash` tools; the plugin never parses memory files and never maintains
anything itself.

## `/memory` — browse this project's memories

A two-level overlay over the memory dir (`browser.ts`). It reads from disk on
every invocation, so memories written after `session_start` show up immediately
— unlike the frozen snapshot injected into the system prompt.

```
╭──────────────────────────────────────────────────────────────────╮
│ Memory · ~/repo/pi-setup                          2 topics       │
│ ──────────────────────────────────────────────────────────────── │
│ › Computer use 路线决策                                           │
│     因 Hyprland 不支持双 seat，首版明确采用真实桌面单 seat。      │
│   插件管理分工                                                    │
│     settings.json 已负责多机同步；pi-setup 收编小插件源码。       │
│ ── unindexed (1) ──────────────────────────────────────────────  │
│   draft-notes.md                                                  │
│ ──────────────────────────────────────────────────────────────── │
│ Search: draft                                                     │
│ ↑↓ navigate · Enter open · Esc close                              │
╰──────────────────────────────────────────────────────────────────╯
```

- **Level 1** — one row per `MEMORY.md` line (title as link text, hook as the
  dim second line), fuzzy-filtered over title, file name and hook as you type.
  Memory files that no index line points at are listed under `unindexed`, and
  index lines whose file is gone are flagged `(missing)` — an unindexed memory
  is invisible to every future session, so it is worth seeing.
- **Level 2** — `Enter` opens the linked file rendered as markdown,
  scrollable with `↑↓` / `PgUp` / `PgDn` / `Home` / `End` and a line counter in
  the footer.
- **Keys** — `Esc` closes the list, but only steps back a level from the detail
  view (the search query survives); `Ctrl+C` closes from either level.
- The overlay is read-only by design: editing a memory is the agent's job.

## Directory layout

```
~/.pi/agent/pi-note/<slug>/          # project memory — shared by every session
├── MEMORY.md                        # index, one line per memory
├── cli-preferences.md
└── two-clone-workflow.md

/tmp/pi-note-<uid>/<session-id>/     # session scratchpad, mode 0700
```

- `<slug>` mirrors pi's session-dir naming for the project cwd, e.g.
  `--home-sjet-repo-pi-setup--`. The cwd is first normalized to the **git root**
  (`git rev-parse --git-common-dir`), so every `git worktree` of one repository
  shares the main checkout's memory dir instead of getting a private one.
  Outside a repository the cwd is used as-is.
- `<uid>` is the numeric OS user id, so separate users of one machine never
  collide in the world-writable `/tmp`.
- `<session-id>` is pi's globally-unique session UUID. `/fork`/`/clone` start a
  fresh scratchpad dir; two pi windows never overwrite each other's files.
- The scratchpad lives under `/tmp` (tmpfs here, auto-cleaned after 10 days by
  systemd `tmpfiles.d`) — no expiry handling is built in.

The memory dir is only ever created by `session_start`. Memories are plain
markdown files; `/memory` browses them, nothing else manages them.

## Moving the memory dir (symlink)

Memory is meant to stay on the local machine, but if you want it elsewhere —
another disk, or a dotfiles checkout — just replace the dir with a symlink.
The plugin only ever `mkdir -p`'s and reads/writes files under the path, so a
symlink to an existing target is honored as-is:

```bash
# move existing memory somewhere else, then link it back
mv ~/.pi/agent/pi-note ~/dotfiles/pi-note-memory
ln -s ~/dotfiles/pi-note-memory ~/.pi/agent/pi-note
```

This does **not** touch `~/dotfiles/pi-agent/pi-hermes-memory/` (a different
plugin's store) — pi-note neither reads, writes, nor migrates it.

## Disabling

Remove `"./extensions/pi-note/index.ts"` from the top-level `package.json`
`pi.extensions` list (or filter it out in `settings.json`, see the setup
README). There is no per-session toggle.

## Environment

`PI_NOTE_SCRATCHPAD_DIR` is exported into `process.env` at `session_start`;
bash and `!` commands expand it natively. Non-shell tools (read/write/edit/
grep/find/ls/…) get the leading `$PI_NOTE_SCRATCHPAD_DIR` literal expanded by
the `tool_call` hook — only at the start of a top-level string value, never
mid-string and never inside arrays/nested objects.
