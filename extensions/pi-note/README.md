# pi-note

Project-level **file-based memory** + a per-session **scratchpad dir** for pi,
ported from Claude Code's two mechanisms. Full behavioral spec: `../../SPEC.md`.

Three hooks, **no registered tools or commands** — nothing appears in the UI
unless memory init fails (one error notify).

| Hook | What it does |
|---|---|
| `session_start` | create dirs, set `PI_NOTE_SCRATCHPAD_DIR`, snapshot `MEMORY.md` into memory |
| `before_agent_start` | append the rules text + the frozen `MEMORY.md` index snapshot to the system prompt |
| `tool_call` | rewrite a leading `$PI_NOTE_SCRATCHPAD_DIR` / `${PI_NOTE_SCRATCHPAD_DIR}` prefix in non-shell tool arguments |

The agent reads and writes memories itself with its built-in `read`/`write`/
`edit`/`bash` tools; the plugin never parses memory files and never maintains
anything itself.

## Directory layout

```
~/.pi/agent/pi-note/<slug>/          # project memory — shared by every session
├── MEMORY.md                        # index, one line per memory
├── cli-preferences.md
└── two-clone-workflow.md

/tmp/pi-note-<uid>/<session-id>/     # session scratchpad, mode 0700
```

- `<slug>` mirrors pi's session-dir naming for the project cwd, e.g.
  `--home-sjet-repo-pi-setup--`.
- `<uid>` is the numeric OS user id, so separate users of one machine never
  collide in the world-writable `/tmp`.
- `<session-id>` is pi's globally-unique session UUID. `/fork`/`/clone` start a
  fresh scratchpad dir; two pi windows never overwrite each other's files.
- The scratchpad lives under `/tmp` (tmpfs here, auto-cleaned after 10 days by
  systemd `tmpfiles.d`) — no expiry handling is built in.

The memory dir is only ever created by `session_start`; there is no command to
list or manage memories. Memories are plain markdown files.

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
