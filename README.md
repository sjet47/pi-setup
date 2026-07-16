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

| Directory | Description |
|-----------|-------------|
| *(extensions to be added)* | |

## Selective Loading

Only want specific extensions? Filter in `settings.json`:

```json
{
  "packages": [{
    "source": "git:github.com/sjet47/pi-setup",
    "extensions": ["extensions/some-plugin/index.ts"]
  }]
}
```

## Development

```bash
npm install
npm run typecheck
pi -e . -p "ping"
```
