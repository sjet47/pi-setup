# Changelog

## 0.1.0

- Highlight loaded `$skill-name` aliases in Pi's existing TUI editor.
- Suggest loaded skills through Pi's native autocomplete while typing `$skill-name` aliases.
- Route prompts with exactly one known inline skill through Pi's native `/skill:name` command.
- Leave slash commands, unknown aliases, and multi-skill prompts unchanged.
- Require complete skill-token matches instead of matching known skill prefixes.
- Scope editor decoration state to active TUI sessions and refresh discovered skills during rendering.
