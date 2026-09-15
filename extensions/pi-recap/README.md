# pi-recap

Vendored from [`@tifan/pi-recap@0.4.7`](https://www.npmjs.com/package/@tifan/pi-recap/v/0.4.7), upstream commit [`4a1f7ce19080f4a3beaf9c502760f14dccabcd88`](https://github.com/tifandotme/pi-extensions/tree/4a1f7ce19080f4a3beaf9c502760f14dccabcd88/packages/pi-recap). Licensed under [MIT](LICENSE); the license text is copied from the upstream repository root because the published package omits its license symlink.

Local fixes: generation allows 2048 output tokens (including hidden reasoning) and a 30-second request timeout. The visible recap remains bounded by the original prompt and 320-character sanitizer. Manual failures show a bounded error reason, and cancelled requests cannot overwrite newer UI state.

Run regression tests with `npm run test:recap` from the repository root.

Re-enter a session without rereading the transcript.

`pi-recap` shows a one-line recap on demand or after you have been away. It starts with why you opened the session, then adds the current state, important decisions, relevant files or commands, and the likely next action.

![Recap widget showing a generated session recap](https://raw.githubusercontent.com/tifandotme/pi-extensions/refs/heads/master/packages/pi-recap/assets/recap-widget.webp)

## Install

Included in pi-setup:

```bash
pi install git:github.com/sjet47/pi-setup
```

When migrating an existing installation, update the installed pi-setup clone first, then remove the standalone package and run `/reload`:

```bash
pi remove npm:@tifan/pi-recap
```

The existing recap model configuration and saved session entries are reused. Do not load both copies at once.

This package requires Pi 0.84.2 or newer.

## How it works

- `/recap` generates a fresh, goal-first recap and shows it above the editor.
- After the agent settles, `pi-recap` waits 5 minutes. If you stay idle, it generates one automatic recap.
- On resume, `pi-recap` shows the saved recap if it is current. If it is stale or missing, it generates a fresh recap.
- The recap clears when you send a non-`/recap` message.

Recaps use pi's current session context, so they follow the active branch and respect compaction. They do not scrape the full session file or terminal history. The latest recap is stored outside LLM context.

A good recap should answer "what was I trying to do here?". For example:

> Deciding whether pi-inline-skills should switch from `$skill` to `/skill`. Recommendation is `/` only with commands winning; next decide whether leading `/skill` should expand.

## Commands

- `/recap`: Generate and show a fresh recap.
- `/recap status`: Show the selected model, active model, recap freshness, and whether the recap is visible. A recap is current when it still matches the latest session state; otherwise it is stale.
- `/recap config`: Choose a recap model.
- `/recap help`: List recap commands.

## Configuration

Out of the box, `pi-recap` uses this default model: `openai-codex/gpt-5.6-luna`.

Run `/recap config` to choose a different model.

![Recap model selector showing available model choices](https://raw.githubusercontent.com/tifandotme/pi-extensions/refs/heads/master/packages/pi-recap/assets/recap-model-selector.webp)

After you choose a model, `pi-recap` uses only that model. Choose `Use default` in `/recap config` to return to the default.

You can also edit `$PI_CODING_AGENT_DIR/extensions/pi-recap.json` manually:

```json
{
  "model": "openai-codex/gpt-5.6-luna"
}
```

## Release notes

See [CHANGELOG.md](https://github.com/tifandotme/pi-extensions/blob/master/packages/pi-recap/CHANGELOG.md)

## License

[MIT](https://github.com/tifandotme/pi-extensions/blob/master/LICENSE)
