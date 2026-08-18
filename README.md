# pi-setup

Personal Pi extension collection. Install everything at once from a single source.

```bash
pi install git:github.com/sjet47/pi-setup
```

`pi-intercom` is maintained as a separate fork. Install it as well when you need session-to-session messaging:

```bash
pi install git:github.com/sjet47/pi-intercom
```

Or pin a tag:

```bash
pi install git:github.com/sjet47/pi-setup@v0.1.0
```

## Included Extensions

| Directory | Description | Source |
|-----------|-------------|--------|
| `pi-shots/` | Capture Hyprland region, annotate with satty, attach to editor | [repo/pi-shots](https://github.com/sjet47/pi-shots) |
| `pi-stats/` | Record skill/tool usage and live provider/model TPS trends | [local] |
| `pi-execution-time/` | Show prompt execution time in the footer | [lukaspanni/pi-execution-time](https://github.com/lukaspanni/pi-execution-time) |
| `pi-fast-mode/` | Auto-detect fast mode (service_tier/speed) by model API format | [rewrite] |
| `pi-search-prompts/` | Search current-project or global prompt history and prefill the editor | [local] |
| `pi-inline-skill/` | Highlight `$skill` aliases and route inline skill references via `/skill:name` | [pi-inline-skill-identifier](https://github.com/kaushikgopal/pi-kaush/tree/main/extensions/pi-inline-skill-identifier) |
| `pi-wakatime/` | Track Pi sessions, file activity and AI line changes with WakaTime | [ttttmr/pi-wakatime](https://github.com/ttttmr/pi-wakatime) |
| `pi-cache-graph/` | Inspect context-cache hit rates, token statistics, and export CSV data | [championswimmer/pi-cache-graph](https://github.com/championswimmer/pi-cache-graph) |

`pi-stats` stores config and data under `~/.pi/agent/pi-stats/`, using one `stats.sqlite` for skill/tool/TPS stats.

## Selective Loading

Only want specific extensions? Filter in `settings.json`:

```json
{
  "packages": [{
    "source": "git:github.com/sjet47/pi-setup",
    "extensions": ["extensions/pi-shots/index.ts", "extensions/pi-stats/src/index.ts"],
    "skills": []
  }]
}
```

## Development

```bash
npm install
npm run typecheck
npm test
pi -e . -p "ping"
```
