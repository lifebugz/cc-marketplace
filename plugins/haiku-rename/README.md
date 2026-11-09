# haiku-rename

A Claude Code mod that gives `/rename` good names. Run `/rename` with no name
and Haiku reads the whole conversation and names the session after the work
in it. `/rename <name>` still sets exactly the name you type.

| Session                                     | Built-in `/rename`            | haiku-rename                                      |
| :------------------------------------------ | :---------------------------- | :------------------------------------------------ |
| A question about this repo's plugins and CI | `explain-marketplace-plugins` | `Explain marketplace plugins and mod checks`      |
| The session that built this mod             | `haiku-rename-mod-testing`    | `Build Haiku-powered /rename mod for Claude Code` |

## Install

```shell
/plugin marketplace add lifebugz/cc-marketplace
/plugin install haiku-rename@lifebugz
```

Tested on Claude Code 2.1.319. Mods (plugins with a hooks module) are an early
access feature of Claude Code.

## Use it

| You type          | What happens                                                     |
| :---------------- | :--------------------------------------------------------------- |
| `/rename`         | Haiku names the session, and `/rename` applies that name         |
| `/rename my name` | The session is named `my name`, exactly as before; Haiku not run |

While Haiku works (usually 1 to 2 seconds) the status line says
`Haiku is naming this session…`. The built-in `/rename` then saves the name
as it always does, so it is the name `/resume` lists.

If Haiku fails or is not allowed, a toast says why and the built-in `/rename`
runs as it would without the mod.

## How it works

The mod hooks the built-in `/rename` command. When you give no name, it:

1. Reads the transcript and builds a short digest: your first prompt, as many
   of the newest messages as fit in about 12,000 characters, the files Claude
   worked on most and the last few shell commands it ran. System reminders,
   slash command output and tool results are left out.
2. Asks Haiku, through your session's own API account, for a 2 to 6 word title
   in sentence case that names the concrete task and its subject.
3. Cleans the reply (quotes, a `Title:` label, markdown, a final period) and
   cuts it at a word to 60 characters at most.
4. Hands the title to the built-in `/rename` as its argument, so the renaming
   itself is still Claude Code's own.

One rename costs about 700 to 1,500 input tokens and 20 output tokens on Haiku.

## Develop

From the repository root:

```shell
bun install
bun run lint plugins/haiku-rename
claude plugin test plugins/haiku-rename
claude plugin validate --strict plugins/haiku-rename
```

The digest and the title clean-up are in `hooks/title.ts`. The hook is in
`hooks/register.ts`.
