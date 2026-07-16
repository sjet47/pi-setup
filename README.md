# pi-setup

Personal Pi extension collection. Install everything at once from a single source.

```bash
pi install git:github.com/sjet47/pi-setup
```

Or pin a tag:

```bash
pi install git:github.com/sjet47/pi-setup@v0.1.0
```

## Included Extensions

| Directory | Description | Source |
|-----------|-------------|--------|
| `pi-shots/` | Capture Hyprland region, annotate with satty, attach to editor | [repo/pi-shots](https://github.com/sjet47/pi-shots) |
| `pi-stats/` | Record and report skill/tool usage statistics | [repo/pi-stats](https://github.com/sjet47/pi-stats) |
| `pi-execution-time/` | Show prompt execution time in the footer | [lukaspanni/pi-execution-time](https://github.com/lukaspanni/pi-execution-time) |
| `pi-intercom/` | Session-to-session messaging and coordination | [repo/pi-intercom](https://github.com/sjet47/pi-intercom) |
| `pi-fast-mode/` | Auto-detect fast mode (service_tier/speed) by model API format | [rewrite] |

## Selective Loading

Only want specific extensions? Filter in `settings.json`:

```json
{
  "packages": [{
    "source": "git:github.com/sjet47/pi-setup",
    "extensions": ["extensions/pi-shots/index.ts", "extensions/pi-intercom/index.ts"],
    "skills": []
  }]
}
```

## Development

```bash
npm install
npm run typecheck
pi -e . -p "ping"
```
