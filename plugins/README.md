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

## Develop a mod

A mod (a plugin with a hooks module) uses the TypeScript, ESLint and Prettier
setup at the repository root. Never add a `package.json` under `plugins/`:
Claude Code runs `bun install` in a plugin's folder for everyone who installs it.

```shell
bun install
bun run check
```

`bun run check` runs these in order, and must pass with zero warnings:

| Script         | What it runs                                                                      |
| :------------- | :-------------------------------------------------------------------------------- |
| `types:check`  | Fails when `.claude-types/` is older than the installed Claude Code               |
| `typecheck`    | TypeScript 7 on each `plugins/*/tsconfig.json`, `plugins/*/scripts/tsconfig.json` |
| `lint`         | ESLint with type information, one process per plugin, all at once                 |
| `format:check` | Prettier over the whole repository                                                |
| `test`         | `claude plugin test` for each mod                                                 |
| `validate`     | `claude plugin validate --strict` for each plugin and for the marketplace         |

`bun run lint plugins/<mod>` lints one mod. The first full lint of a mod can
take minutes: `no-misused-promises` and `strict-void-return` check each
`on(...)` call against every signature of `on`, and TypeScript works out those
types once per mod.

A mod's `tsconfig.json` is one line:

```json
{ "extends": "../../tsconfig.mod.json" }
```

A JavaScript for Automation script (JXA, run by `osascript -l JavaScript`) goes
in `plugins/<mod>/scripts/` beside a `tsconfig.json` that extends
`../../../tsconfig.jxa.json`, and sets its entry point as
`globalThis.run = function (argv) { … }`.

The mod API types are in `.claude-types/`, copied from the ones Claude Code
writes beside a mod in `.claude-plugin/types/`. After a Claude Code update, load
any mod once with `claude --plugin-dir plugins/<mod>`, run
`bun run types:sync`, and commit `.claude-types/`.
