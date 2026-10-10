# session-tabs

A Claude Code mod that adds `/tabs`: a live pane listing every Claude Code
session on your machine, with its status and folder. Press a row and that
session's terminal tab comes to the front. The pane stays open and refreshes
itself every 3 seconds.

```text
Sessions · 1 waiting · 2 busy · 6 idle · 1 background
1: ● waiting  shop-api-3f                                     Ghostty tab 3
              ~/projects/api · permission prompt
2: ◐ busy     fix-login-timeout                               Ghostty tab 2
              ~/projects/shop
3: ◐ busy     api-refactor                                      tmux main:2
              ~/projects/api
4: ○ idle     update-docs-site                                Ghostty tab 4
              ~/projects/docs
5: ○ idle     website-3e                                            Ghostty
              ~/projects/website
6: ○ idle     website-7c                                            Ghostty
              ~/projects/website
7: ○ idle     infra-scripts                                          iTerm2
              ~/projects/infra
8: ○ idle     mobile-app-1b                                         VS Code
              ~/projects/mobile
   ○ this     cc-marketplace-34                               Ghostty tab 1
              ~/projects/cc-marketplace
   · bg       nightly-dependency-audit                           background
              ~/projects/infra · blocked
```

## Install

Type this at the Claude Code prompt in a terminal:

```text
/plugin install session-tabs --marketplace lifebugz/cc-marketplace
```

Answer `y` to add the marketplace, then pick a scope (the user scope is the
first choice). The mod is active at once in that session.

## Use

Run `/tabs`. The pane opens with the keyboard on it. In fullscreen mode it sits
beside the transcript; otherwise it sits above the prompt.

| To                    | Do                                                                                                                                                  |
| :-------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------- |
| Switch to a session   | Press its key (`1`–`9`, then `a`–`z`), or move with Tab and press Enter, or click the row (clicks need fullscreen mode). The arrows scroll the pane |
| Go back to the prompt | Esc. The pane stays open and keeps refreshing                                                                                                       |
| Close the pane        | Its close mark, or ctrl+x x                                                                                                                         |

Rows are sorted **waiting → busy → idle**, then by tab position. The first
line is the status, the session's name and where it runs. The second line is
its folder, with your home folder written as `~` and long paths cut in the
middle so the last folder stays readable. A waiting session also says what it
waits for, such as `permission prompt`.

A key stays with its session while the pane is open, even when the rows
re-sort. A key is given to a new session only after its old session ends.

Dim rows have no key because they cannot switch: this session, background
sessions (they have no terminal), and the cases under [Limits](#limits). The
second line says why.

## Where it can switch

| Session runs in                  | What a press does                                                                                                                                                                   |
| :------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ghostty                          | Focuses that tab (and split) and brings its window to the front                                                                                                                     |
| iTerm2                           | Selects that session, its tab and its window                                                                                                                                        |
| Terminal.app                     | Selects that tab and brings its window to the front                                                                                                                                 |
| tmux                             | Selects the pane and its window, moves an attached client there (one already on that session, else the most recently used one), then focuses the client's own terminal tab as above |
| VS Code, the Claude Code panel   | Brings the VS Code window for that folder to the front, then opens the session's tab with `vscode://anthropic.claude-code/open?session=<id>`                                        |
| VS Code, its integrated terminal | Brings VS Code to the front only. VS Code cannot pick a terminal tab from outside, so a toast says to pick it yourself                                                              |

The mod finds the app by walking up the session's parent processes (`ps`).

## Naming sessions with Haiku

A session with no name shows a default name such as `marketplace-0a`. With
**auto-naming** on (the default), the mod gives an unnamed session a short
name from Haiku after its first real request, such as `add-billing-export`.
The name shows in the tab title, in `claude agents`, and in this pane, so
every tab is easy to find.

- It names a session only once, only from a prompt you typed, and never from
  a slash command, a prompt under 15 characters, a `/loop` or scheduled
  wakeup, a task notification, or the SDK.
- A session you named yourself (`--name` or `/rename`) is never touched.
- It waits for Haiku at most 2 seconds. If Haiku is slower, your prompt goes
  on unnamed, and the name is set by your next prompt with no wait.
- The name replaces Claude Code's own AI title in the tab title. A session
  named this way also does not get the title Claude Code makes when you accept
  a plan.
- Each named session costs one small Haiku call on your account.

Turn it off in `/config` (**Name unnamed sessions with Haiku**), or set
`autoName` to `false`.

## Permissions

The first time the mod controls another app, macOS asks whether the app that
runs Claude Code (for example Ghostty) may control it. This happens for
iTerm2 and Terminal.app, and for Ghostty when Claude Code itself runs in a
different app. A press waits up to 60 seconds for your answer, then switches.

If you answered **Don't Allow**, a press shows a toast instead. Allow it again
in **System Settings → Privacy & Security → Automation**, under the app Claude
Code runs in.

## Limits

- Switching works on macOS only. On other systems the pane lists sessions
  without keys.
- **Ghostty does not tell which tab a program runs in.** The mod finds a
  session's tab by the session's name in the tab title, or by its folder when
  only one Claude Code tab is in that folder. When it cannot tell (two unnamed
  sessions in one folder), the row shows plain `Ghostty`. Pressing it sets a
  short marker title on that session's terminal, finds the tab that shows it,
  puts the old title back, and switches to it. You may see that tab's title
  flash for under a second. After that the mod remembers the tab, and the row
  shows its number.
- tmux: the default server only. A session on another tmux server (started
  with `tmux -L` or `-S`) shows `tmux: not on the default server`, and one with
  no client attached shows `tmux: not attached`.
- VS Code: the stable app only, not Insiders, Cursor or other forks (those rows
  say they cannot switch). The integrated terminal only brings the window
  forward.
- Clicking rows needs fullscreen mode. The keys work everywhere.

## Privacy

Everything runs on your machine. The mod reads the session list with
`claude agents --json`, which is Claude Code's supported way to read session
state from outside; it never reads transcript files. With auto-naming on, the
first 2,000 characters of your first request and the folder's name are sent
to Haiku on your own account, the same way the session itself uses the model.

## Develop

Tested live with Claude Code 2.1.296 on macOS 27.0.1: Ghostty 1.3.1 (known
tabs and the marker), tmux 3.8 attached in a Ghostty tab, iTerm2 3.7.4 (with
the Automation denial toast), Terminal.app 2.15, and the Claude Code panel in
VS Code 1.141.0. A session in VS Code's integrated terminal is covered by tests
only.

```shell
bun install
claude --plugin-dir plugins/session-tabs   # once, to lay .claude-plugin/types/
bun run check
```

`bun run check` runs, and must pass with zero warnings:

| Script         | What it runs                                                                        |
| :------------- | :---------------------------------------------------------------------------------- |
| `typecheck`    | TypeScript (latest, 7.x) on the mod, and on `scripts/` with its own `tsconfig.json` |
| `lint`         | ESLint with typescript-eslint's `strictTypeChecked` and `stylisticTypeChecked`      |
| `format:check` | Prettier, from the repository root so it skips the engine's `.claude-plugin/types/` |
| `test`         | `claude plugin test .`                                                              |
| `validate`     | `claude plugin validate .`                                                          |

Notes:

- The `tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which Claude
  Code writes when it loads the mod from a folder (`--plugin-dir`). Load the mod
  once before the first `typecheck`.
- `typescript` is pinned to `~6.0` in `package.json` because typescript-eslint
  supports TypeScript `>=4.8.4 <6.1.0`. Type-checking itself runs the latest
  TypeScript through `bunx`.
- `scripts/terminals.js` is JavaScript for Automation (JXA), run by `osascript`.
  It has its own `tsconfig.json` and hand-written `jxa.d.ts`, so its globals
  (`Application`, `$`, `delay`) never leak into the hooks.
- `hooks/register.tsx` and `tests/` turn off one sub-check of
  `no-misused-promises` (`checksVoidReturn.arguments`): checking each argument
  of an `on(...)` call against the engine's overload set takes over 5 minutes
  per file. Every other file keeps it.
- A hooks module may pass `$` only to functions in the same file, so
  `hosts.ts` and `refresh.ts` take a small `Io` object that `register.tsx`
  builds from `$`.
