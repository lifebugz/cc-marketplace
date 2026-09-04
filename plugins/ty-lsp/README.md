# ty-lsp

Python code intelligence for Claude, powered by
[ty](https://docs.astral.sh/ty/) - Astral's type checker and language server,
written in Rust.

A **language server** (LSP, Language Server Protocol) is a background program
that understands your code semantically. It answers questions like "where is
this function defined?" and reports type errors. With this plugin, Claude asks
ty those questions instead of guessing from a text search.

## Prerequisite: install ty yourself

This plugin only tells Claude Code **how to connect** to ty. It does not bundle
the binary. Install it first, so that `ty` is on your `PATH` (the list of
folders your shell searches for commands):

```shell
uv tool install ty@latest          # recommended
# or
brew install ty
```

Verify: `ty --version` should print a version. If Claude Code shows
`Executable not found in $PATH` in the `/plugin` Errors tab, this step was
skipped.

> `uvx ty check` runs ty once in a throwaway environment. That is handy for a
> quick look, but it does **not** put `ty` on your `PATH`, so the plugin still
> will not find it. Use one of the two commands above.

> ty is in **beta** and uses `0.0.x` version numbers. Astral says breaking
> changes can land between any two versions, so pin ty to an exact version in
> projects where that matters, and re-check this plugin after a big jump.

## Install the plugin

```shell
/plugin marketplace add lifebugz/cc-marketplace
/plugin install ty-lsp@cc-marketplace
```

Then restart Claude Code, or run `/reload-plugins`. If that warns that the
reload will re-read the conversation, rerun it as `/reload-plugins --force` -
an LSP plugin change always triggers that warning.

## What Claude gets

The plugin registers ty for `.py` and `.pyi` files. ty then powers:

- **Code navigation** - go to definition, find all references, document and
  workspace symbols (a list of every class and function in one file, or across
  the whole project), and call hierarchy (who calls this function, and what it
  calls).
- **Hover** - the type and docstring of any symbol.
- **Diagnostics** - type errors are pushed into Claude's context automatically
  after edits, so Claude sees the mistake without you running a check.

Mapping `.pyi` matters: those are **stub files**, which carry type annotations
for code that has none. Opening them lets ty type-check calls into an
unannotated module that has a stub beside it.

## Configuration

The plugin ships **no** ty settings on purpose, but there are two separate sets
of settings and only one of them lives in your project:

- **Type-checking configuration** - rules, Python version, excluded paths. ty
  finds this itself in `ty.toml` or the `[tool.ty]` table of `pyproject.toml`,
  with no help from the plugin. Put it there and your editor, your CI, and
  Claude all behave the same way.
- **Editor-level settings** - `diagnosticMode` (default `openFilesOnly`),
  `inlayHints`, `disableLanguageServices` and friends. No config file can
  supply these; only the LSP client can. To change one, add a `settings` or
  `initializationOptions` block to [`.lsp.json`](.lsp.json). The same file
  holds the connection options Claude Code understands, documented in the
  [plugin reference](https://code.claude.com/docs/en/plugins-reference#lsp-servers).

For a marketplace install the live copy of `.lsp.json` sits under
`~/.claude/plugins/cache/cc-marketplace/ty-lsp/<version>/`, and an edit there
is replaced on the next plugin update. To make a change stick, fork this repo,
or point Claude Code at a local checkout with
`claude --plugin-dir ./plugins/ty-lsp`.

## Conflicts with other Python LSP plugins

When two enabled LSP servers claim the same file extension, **the first one
registered wins and the other never starts**. Nothing visibly fails in the
session; the `/plugin` interface shows a warning naming the plugin whose server
is active, so check there if ty seems dead. If you also have the official
`pyright-lsp` plugin installed, disable one of them:

```shell
/plugin disable pyright-lsp
```

Then reload, as in the install step above - a disable made mid-session does not
free the `.py` extension until you do.

## Known caveats

All three were reproduced against ty 0.0.77 and Claude Code 2.1.259. They are
observations, not requirements - other versions may behave differently.

- **No file watching.** ty logs
  `Your LSP client doesn't support file watching`. ty sees the files Claude
  opens and edits through its editing tools, but a change made another way -
  `git checkout`, a `sed` command, another terminal - can leave ty's answers
  stale until that file is opened again.
- **"Find implementations" returns nothing.** Claude Code offers a
  `goToImplementation` operation and ty advertises `implementationProvider` in
  its handshake, but `textDocument/implementation` answers with `null`. ty's
  own feature table lists it as not supported
  ([astral-sh/ty#3514](https://github.com/astral-sh/ty/issues/3514)). Claude
  can call it and will get an empty answer.
- **An error line when the session ends.** Claude Code sends the LSP `shutdown`
  request with `params: {}`; ty follows the LSP specification strictly, where
  `shutdown` takes no parameters, and rejects it with
  `invalid type: map, expected unit`. ty then exits with status 2 rather than
  the clean 0 it returns for a spec-correct shutdown. No `ty server` process is
  left behind, and the message only appears in `claude --debug` output.

## Links

- [ty documentation](https://docs.astral.sh/ty/)
- [ty language server features](https://docs.astral.sh/ty/features/language-server/)
- [ty editor settings reference](https://docs.astral.sh/ty/reference/editor-settings/)
- [ty configuration reference](https://docs.astral.sh/ty/reference/configuration/)
- [Claude Code LSP plugins](https://code.claude.com/docs/en/plugins-reference#lsp-servers)
