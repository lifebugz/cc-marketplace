# title: name a session with Haiku, at no context cost

`/title` asks Haiku for a short name for the current session, based on the
conversation so far, for example `fix-login-timeout`. The session gets that
name on your next prompt, so you can find it later with `claude --resume` or
`/resume`.

Only you run `/title`, so it adds nothing to Claude's context:

- Claude never sees the command in its list of skills or tools.
- Running it writes no row to the conversation.
- The name reaches Claude Code the same way a `UserPromptSubmit` hook's
  `sessionTitle` does, so Claude gets no note about it either.

Tested with Claude Code 2.1.331 in the terminal.

## Install

```
/plugin install title --marketplace lifebugz/cc-marketplace
```

There is nothing to set up: the mod has no settings.

## Use it

```
/title
/title login work
```

Anything after `/title` is a hint for Haiku. Haiku reads your first request
and the newest words of the conversation (tool calls and Claude Code's own
reminders are left out). Typed while Claude is working, `/title` waits for the
turn to end. A toast in the top right corner shows the result:

| What happened                           | The toast                                     |
| :-------------------------------------- | :-------------------------------------------- |
| Haiku picked a name                     | `Your next prompt names this session: <name>` |
| Nothing has been said yet               | `Nothing to name yet: send a prompt first.`   |
| Haiku failed or took over 15 s          | `Haiku could not name it (<reason>)`          |
| Haiku's reply was not a kebab-case name | `Haiku's reply was not a usable name.`        |

The name lands on your **next prompt**. Claude Code has no other way for a mod
to rename a session without a row for Claude: the built-in `/rename` writes
its command and output to the conversation, plus a note for Claude
("The user named this session …"). So:

- If you quit, or run `/clear`, before your next prompt, the session does not
  get the name.
- A second `/title` replaces the waiting name, and a failed one drops it.
- If you pick a name with `/rename` after `/title`, your name wins.

## What it costs

- One small Haiku request per `/title`. It counts toward `/cost` like any
  other request of the session.
- After a rename, by `/title` or by the built-in `/rename`, the next request
  sometimes writes the conversation part of the prompt cache again. It
  happened in short test sessions, also with the built-in `/rename` and no
  mods loaded, and not in a longer one. The cause is unknown: the recorded
  request holds the name in none of the system prompt, the tools or the
  messages.

## Where Claude Code itself stores the typed line

In the terminal, `/title` leaves nothing in the conversation. In these places
Claude Code stores the typed `/title` line as a message, whatever the mod
answers:

- the VS Code panel and the Agent SDK, and, by the same code path, the
  Desktop app (not tested there);
- Remote Control (the Claude app and claude.ai), which also shows no toast.
