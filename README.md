# cc-marketplace

A personal [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces):
a catalog of plugins that bundle skills, slash commands, subagents, hooks, and
MCP servers. Add the marketplace once, then install any plugin from it by name.

## Use this marketplace

```shell
# Add it (from GitHub once published, or from a local checkout for testing)
/plugin marketplace add lifebugz/cc-marketplace     # published
/plugin marketplace add ./                          # local checkout

# Browse and install
/plugin                                             # interactive browser
/plugin install <plugin-name>@cc-marketplace

# Keep it current
/plugin marketplace update cc-marketplace
```

> No plugins are published yet - this repo starts as a clean marketplace shell.
> See [Add a plugin](#add-a-plugin) below.

## Repository structure

```
cc-marketplace/
├── .claude-plugin/
│   └── marketplace.json        # the catalog (name, owner, plugins[])
├── plugins/                    # one subdirectory per plugin
│   └── <plugin-name>/
│       ├── .claude-plugin/plugin.json
│       ├── skills/  commands/  agents/  hooks/  scripts/
├── CLAUDE.md                   # conventions & gotchas (loaded by Claude Code)
├── CLAUDE.local.md             # personal notes (git-ignored)
└── LICENSE                     # MIT
```

## Add a plugin

1. Create the plugin directory and manifest:
   ```bash
   mkdir -p plugins/my-plugin/.claude-plugin
   cat > plugins/my-plugin/.claude-plugin/plugin.json <<'JSON'
   { "name": "my-plugin", "description": "What it does", "version": "0.1.0" }
   JSON
   ```
2. Add components **at the plugin root** - e.g. a skill at
   `plugins/my-plugin/skills/my-skill/SKILL.md`. Only `plugin.json` may live
   inside `.claude-plugin/`.
3. Register it in `.claude-plugin/marketplace.json`:
   ```json
   {
     "name": "my-plugin",
     "source": "./plugins/my-plugin",
     "description": "What it does"
   }
   ```
4. Validate and test:
   ```bash
   claude plugin validate ./plugins/my-plugin
   claude plugin validate .
   ```
   Then, inside Claude Code: `/plugin marketplace add ./` and
   `/plugin install my-plugin@cc-marketplace`. Run `/reload-plugins` after edits.

See [`plugins/README.md`](plugins/README.md) for the per-plugin layout and
[`CLAUDE.md`](CLAUDE.md) for the full conventions and validation rules.

## Naming rules

- Marketplace and plugin `name` fields must be **kebab-case, no spaces**.
- Relative `source` paths start with `./` and must not contain `..`.
- Reference bundled files with `${CLAUDE_PLUGIN_ROOT}`, never absolute paths.

## License

[MIT](LICENSE) © lifebugz
