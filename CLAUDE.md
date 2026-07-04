# cc-marketplace

A **Claude Code plugin marketplace**: a git repo whose root holds a
`.claude-plugin/marketplace.json` catalog listing plugins. Each plugin lives
under `plugins/<name>/` and bundles skills, slash commands, subagents, hooks,
and/or MCP servers.

This file is loaded as project context every session. Keep it accurate and short.

## Repository layout

```
cc-marketplace/                     # marketplace root (the dir containing .claude-plugin/)
├── .claude-plugin/
│   └── marketplace.json            # the catalog: name, owner, plugins[]
├── plugins/                        # one subdirectory per plugin (source: "./plugins/<name>")
│   └── <plugin-name>/
│       ├── .claude-plugin/
│       │   └── plugin.json         # plugin manifest (only `name` is required)
│       ├── skills/<skill>/SKILL.md # PREFER skills for new components
│       ├── commands/<cmd>.md       # flat-file slash commands (legacy form of a skill)
│       ├── agents/<agent>.md       # subagents
│       ├── hooks/hooks.json        # event handlers
│       └── scripts/                # helper scripts, referenced via ${CLAUDE_PLUGIN_ROOT}
├── CLAUDE.md                       # this file (project context)
├── CLAUDE.local.md                 # personal notes - git-ignored
├── README.md                       # human-facing usage docs
└── LICENSE                         # MIT
```

## Add a new plugin

1. `mkdir -p plugins/<name>/.claude-plugin` and write `plugins/<name>/.claude-plugin/plugin.json`
   (at minimum `{ "name": "<name>" }`; adding `description` + `version` is recommended).
2. Add components at the **plugin root**: `skills/`, `commands/`, `agents/`, `hooks/hooks.json`.
3. Register it in `.claude-plugin/marketplace.json` by appending to `plugins`:
   ```json
   { "name": "<name>", "source": "./plugins/<name>", "description": "..." }
   ```
4. Validate: `claude plugin validate ./plugins/<name>` and `claude plugin validate .`.
5. Test locally: `/plugin marketplace add ./` then `/plugin install <name>@cc-marketplace`.

Or scaffold a starter with `claude plugin init <name>` (creates it under
`~/.claude/skills/`, not here) and move it into `plugins/`.

## Rules that prevent silent breakage

- **Only `plugin.json` goes in a `.claude-plugin/` directory.** All component
  folders (`skills/`, `commands/`, `agents/`, `hooks/`) and root config files
  (`.mcp.json`, `.lsp.json`, `settings.json`) live at the **plugin root**. If a
  component folder is placed inside `.claude-plugin/`, the plugin still loads but
  its components silently disappear. This is the #1 mistake.
- **Names are kebab-case, no spaces** for the marketplace `name`, every plugin
  `name`, and agent `name` (lowercase letters + hyphens). Non-kebab-case only
  warns in `claude plugin validate`, but the claude.ai marketplace sync rejects it.
- **Relative `source` paths must start with `./` and contain no `..`.** They
  resolve against the marketplace root (this repo root), not `.claude-plugin/`.
  A `..` is a hard validation error.
- **Reference bundled files with `${CLAUDE_PLUGIN_ROOT}`**, never absolute or
  `../` paths - installed plugins are copied to `~/.claude/plugins/cache`, so
  outside paths do not exist at runtime. That path changes on every update;
  never write state there (use `${CLAUDE_PLUGIN_DATA}` for persistence).
- **A `CLAUDE.md` at a plugin root is NOT loaded as context.** Ship plugin
  instructions as a skill, not a nested CLAUDE.md. Only this repo-root CLAUDE.md
  is picked up as project context.

## Frontmatter quick reference

- **Skills** (`skills/<name>/SKILL.md`): YAML frontmatter then a markdown body.
  Only `description` is recommended; the invocation name comes from the
  **directory** name. Field casing is kebab-case (`allowed-tools`).
- **Commands** (`commands/<name>.md`): same frontmatter as skills; the
  invocation name comes from the **filename**. Subdirs namespace the name
  (`commands/ci/status.md` → `/<plugin>:ci:status`).
- **Agents** (`agents/<name>.md`): `name` and `description` are **required**;
  tool fields are camelCase (`tools`, `disallowedTools`). Plugin agents **ignore**
  `hooks`, `mcpServers`, and `permissionMode`; `isolation` may only be `"worktree"`.
- **Hooks** (`hooks/hooks.json`): event names are case-sensitive (`PostToolUse`,
  not `postToolUse`); strict JSON (no comments/trailing commas). For most events
  only exit code 2 blocks the action.

## Versioning

Pick one model per plugin - never set `version` in both `plugin.json` and the
marketplace entry (the `plugin.json` value silently wins):

- **Pinned:** set `"version"` in `plugin.json` and **bump it on every release**,
  or users never receive updates.
- **Commit-SHA (simplest for active development):** omit `version` entirely; every
  new commit to the git source counts as a new version.

## Validate before committing

```bash
claude plugin validate .                 # marketplace.json schema + each plugin entry
claude plugin validate ./plugins/<name>  # one plugin's manifest + frontmatter
```

Add `--strict` to treat warnings as errors (useful in CI). An empty `plugins`
array is valid but warns until the first plugin is added.
