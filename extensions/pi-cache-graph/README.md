# pi-cache-graph

Inspect context-cache usage in Pi sessions with three commands:

- `/cache graph` shows cache hit percentage over the session timeline.
- `/cache stats` shows per-assistant-message token and cache statistics.
- `/cache export` writes the same data to a CSV file in the project root.

This extension is included in [sjet47/pi-setup](https://github.com/sjet47/pi-setup).

## Installation

Install the collection from GitHub:

```bash
pi install git:github.com/sjet47/pi-setup
```

The `/cache` commands are then available in Pi sessions.

## Graph Views

`/cache graph` opens an interactive TUI overlay with three views:

| Key | View | Description |
|-----|------|-------------|
| `1` | Per-turn (%) | Cache hit percentage for each assistant turn |
| `2` | Cumulative (%) | Running aggregate cache hit percentage |
| `3` | Cumulative (total) | Running input, cache-write, and cache-read volumes |

Inside the overlay, `v` and `V` cycle views, `r` refreshes session data, the arrow and page keys scroll, and `q` or `Esc` closes the dialog.

Cache hit percentage is calculated as:

```text
cacheRead / (input + cacheRead + cacheWrite)
```

The denominator represents the full prompt sent for the turn. This includes fresh input, cache reads, and newly written cache tokens.

## Export

`/cache export` writes a CSV to the current project root. The filename uses the current session name when available, then the session file name, and finally `session.csv`.

The CSV contains summary rows for the active branch and whole session tree, followed by one row per assistant message with usage data.

## Development

From the `pi-setup` repository root:

```bash
npm install
npm run typecheck
npm run test:cache-graph
```

The implementation is split into data collection, cache math, TUI rendering, and CSV export modules under `src/`.
