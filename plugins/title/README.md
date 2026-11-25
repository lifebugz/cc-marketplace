# title: name a session with Haiku

`/title` asks Haiku for a short name for the current session, based on the
conversation so far, for example `fix-login-timeout`, and renames the session
at once. You can find it later with `claude --resume` or `/resume`.

While you don't use it, `/title` costs no context: Claude never sees it in its
list of skills or tools.

Tested with Claude Code 2.1.332 in the terminal.

## Install

```
/plugin install title --marketplace lifebugz/cc-marketplace
```

There is nothing to set up: the mod has no settings.

## Use it

| You run                     | What happens                                                      |
| :-------------------------- | :---------------------------------------------------------------- |
| `/title`                    | Haiku picks a name from the conversation, and the session gets it |
| `/title New Name`           | The session gets your name in kebab-case: `new-name`              |
| `/title` (nothing said yet) | Your prompt box gets `/title ` so you can type a name, then Enter |

Haiku reads your first request and the newest words of the conversation; tool
calls and Claude Code's own reminders are left out. Typed while Claude is
working, `/title` waits for the turn to end.

The rename itself is the built-in `/rename`, run for you a moment after
`/title`. So the transcript shows `Session renamed to: <name>`, and Claude
reads that line plus Claude Code's note "The user named this session …", as
after any `/rename`. The `/title` line itself leaves no row.

When there is no name, a toast in the top right corner says why:

| What happened                           | The toast                                    |
| :-------------------------------------- | :------------------------------------------- |
| Haiku failed or took over 15 s          | `Haiku could not name it (<reason>)`         |
| Haiku's reply was not a kebab-case name | `Haiku's reply was not a usable name.`       |
| Your name had no letter or digit        | `A name needs at least one letter or digit.` |
| `/rename` did not run                   | `Could not rename the session (<reason>)`    |

## What it costs

One small Haiku request per `/title` that has no name typed after it. It
counts toward `/cost` like any other request of the session.
