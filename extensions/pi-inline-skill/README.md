# pi-inline-skill

Use `$skill-name` references in Pi prompts while keeping Pi's native skill loading.

Inspired by [pi-inline-skill-identifier](https://github.com/kaushikgopal/pi-kaush/tree/main/extensions/pi-inline-skill-identifier).

## Usage

Mention one loaded skill anywhere in a normal prompt:

```
Use $review-my to review these changes.
```

The extension highlights known `$skill-name` aliases in the TUI editor and transforms that prompt into Pi's native skill command:

```
/skill:review-my Use $review-my to review these changes.
```

Pi still owns skill discovery, expansion, and slash-command handling.

While typing, Pi's native autocomplete suggests loaded skills after `$`. For example, `$rev` offers `$review-my`; use the normal autocomplete keys to select it. Typing a space after `$` or a partial alias closes the suggestions.

## Behavior

- Only aliases matching loaded Pi skills are highlighted or transformed.
- A prompt referencing exactly one known skill is transformed. Repeating that same skill still counts as one skill.
- Prompts referencing multiple different skills are left unchanged because Pi does not expose a native skill-composition command.
- Slash commands, unknown `$tokens`, and extension-generated input are left unchanged.
- Skill names must match the complete `$token`; a loaded skill is not matched as a prefix of a longer token.
- Autocomplete uses Pi's existing provider and only filters loaded skill names in memory.
- Autocomplete and highlighting only run in TUI mode. Input transformation remains available in print, JSON, and RPC modes.
- The extension does not replace the editor. It installs one guarded, lifecycle-scoped render wrapper so loaded skill aliases can be colored.
