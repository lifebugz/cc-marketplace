# plugins/

Each subdirectory here is **one plugin**. Keep this folder as the single home for
plugin sources so marketplace entries can use tidy `"./plugins/<name>"` paths.

## Per-plugin layout

```
plugins/<name>/
├── .claude-plugin/
│   └── plugin.json         # manifest - only `name` is required
├── skills/<skill>/SKILL.md # preferred component type for new work
├── commands/<cmd>.md       # flat-file slash commands (optional)
├── agents/<agent>.md       # subagents (optional)
├── hooks/hooks.json        # event handlers (optional)
└── scripts/                # helpers, referenced via ${CLAUDE_PLUGIN_ROOT}
```

Only `plugin.json` may sit inside `.claude-plugin/`. Every component folder must
be at the plugin root, or its components will silently fail to load.

## Register a plugin

After creating `plugins/<name>/`, add an entry to
[`../.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json):

```json
{ "name": "<name>", "source": "./plugins/<name>", "description": "..." }
```

Then run `claude plugin validate .` from the repo root. See the repo
[`CLAUDE.md`](../CLAUDE.md) for the full conventions.
