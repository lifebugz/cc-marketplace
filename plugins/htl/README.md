# htl: human in the loop

Sometimes Claude hits a job it truly cannot do: a login with 2FA, a secret that
does not exist yet, a cable to plug in, a payment, or a machine it cannot reach.
Without this mod it can only stop and explain in prose. With it, Claude hands
you the job as a **task**, you answer in a pane, and Claude carries on.

![Claude cannot log in to Fly for you, so it assigns the login as a task and stops. You log in, press a, add a message and press Enter. Claude checks the login and deploys.](assets/demo.gif)

In this recording Claude can't do the Fly login (it needs a browser and a 2FA
code), so it hands it over and waits. You log in, press `a` (Accept), add a
message, and press Enter. Claude checks that the login worked, then deploys.
(The demo uses a stand-in `fly` command, so nothing was really deployed.)

Tested with Claude Code 2.1.308 in the terminal and the 2.1.306 VS Code
extension.

## Install

```
/plugin install htl --marketplace lifebugz/cc-marketplace
```

Answer `y` to add the marketplace, then pick a scope.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/flow-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/flow-light.svg">
  <img alt="How htl works, in three lanes: Claude, the htl mod, and you. Turn 1: Claude hits a job it can't do, tries its own tools, then calls assign_task. The mod checks the request and either refuses it with what to fix, or shows the task and tells Claude at once that it is assigned, so Claude ends its turn. While no turn runs, you do the job and pick Accept, Reject or You can do this, with an optional message. The mod sends that as your message, which starts turn 2: Claude runs its check and continues, finds another way, or does the job itself." src="assets/flow-light.svg">
</picture>

Nothing waits inside a tool call: the tool answers at once, Claude's turn ends,
and your answer starts the next turn.

Claude gets one tool, `mcp__htl__assign_task`. (Claude Code names every tool a
mod registers `mcp__<plugin>__<name>`; there is no MCP server behind it.) A
task has a title, exact steps, the kind of blocker, why Claude cannot do it,
what Claude already tried, and optionally how Claude will check that it is
done.

The task opens in a pane called **HTL tasks**. One card shows at a time:

![A task card: number and mode, the title, the blocker and why, what Claude tried, numbered steps, how Claude will check, and the keys a: Accept, r: Reject, y: You can do this.](assets/task-card.png)

| Key | Button          | What Claude receives                                                            |
| :-- | :-------------- | :------------------------------------------------------------------------------ |
| `a` | Accept          | "accepted, I did it", then it checks the result and continues                   |
| `r` | Reject          | "rejected, I won't do it", then it finds another way or says what stays blocked |
| `y` | You can do this | "you can do this yourself", then it does the job with its own tools             |
| `n` | Next            | shows the next card, when there is more than one                                |

After a button, you can type an optional message to Claude. Enter sends it,
even when the field is empty.

![After Accept, the card asks for an optional message to Claude, with a text field that Enter sends.](assets/message.png)

Your answer arrives as your own message and starts Claude's next turn. Here
Claude runs its check, then goes on with the deploy:

![The answer arrives as the user's message: task #1 accepted, the message, and a request to check it worked. Claude runs fly auth whoami and fly deploy and reports the app's address.](assets/answer.png)

The pane opens by itself and takes the keyboard only when your prompt is empty,
so it never steals keys while you type. In the terminal, if it does not have
the keys, press **ctrl+x tab** to move into it. Run `/htl` at any time to open
it.

In the VS Code extension the pane sits beside the conversation, or above the
prompt box in a narrow panel. Its buttons have no keys there: click them, then
click **send** to send your answer, with or without a message.

### Two modes

Claude picks a mode for each task:

- **now**: Claude's next step needs the result. Claude ends its turn and waits.
  Until you answer, the mod refuses Claude's other tool calls. What lifts this
  is your answer in the pane, or a prompt you type in Claude Code or send
  through Remote Control. Other messages do not: a background task's
  notification, a schedule, another session, or a chat channel an MCP server
  relays. If tool calls stay refused, answer in `/htl`. Only Claude's own tool
  calls wait; other mods' tool calls still run.
- **parallel**: Claude keeps doing work that does not depend on the task, then
  ends its turn and says it is waiting for it.

A tool call cannot stay open while a pane waits for you (a mod hook gets 10
seconds of its own time), so both modes are turn-based: the tool returns at
once, and your answer starts the next turn.

### What tells you a task is waiting

- The pane, plus one toast.
- If the pane cannot be placed, a status line under the prompt. A pane that
  opens by itself needs a terminal at least 144 columns wide, or 110 once you
  have opened it with `/htl`.
- One line under Claude's answer while tasks are open (Claude Code labels it
  with the plugin's name).

In a 100-column terminal, the task waits in the status line, and `/htl` shows
it:

![In a narrow terminal: the line under Claude's answer, the /htl command being typed, and the status line "htl: 1 task waiting for you · /htl".](assets/status-line.png)

There, `/htl` opens the pane inline, above the prompt, instead of beside the
conversation:

![The same task card drawn inline in a rounded frame above the prompt.](assets/inline-pane.png)

## Helpful, not annoying

The tool's description tells Claude to use it only as a last resort: never for
work its tools can do (editing files, running commands, installing packages,
committing, making a random secret), never for a question or a choice (that is
AskUserQuestion, or plain text), and never for a job you said you would do.

The mod also enforces some rules in code:

- **At most 3 open tasks.** A fourth is refused.
- **No repeats.** A title you rejected or answered with "You can do this" is
  refused for the rest of the session, as is a title that is already open.
  Titles are compared without case and extra spaces.
- **Only the main conversation** can assign tasks. A subagent is told to put
  the blocker in its final report.
- **1Password first** (see below).

## Secrets and 1Password

The `secrets` setting says where your secrets live. Pick it in `/config`, or
with `/plugin configure htl`. A stored value that is neither option counts as
unset, so the default applies.

- `1password` (the default): Claude uses a secret **without seeing it**. It
  writes an `op://<vault>/<item>/<field>` reference and runs the command with
  `op run --env-file=<file> -- <command>`, or renders a config with
  `op inject -i <template> -o <file>`. 1Password asks you to approve with its
  own Touch ID prompt; that is not an HTL task. Claude is told never to run
  `op read`, `--reveal` or `--no-masking` in its own shell, so a value never
  reaches its output. A `secret` task is only for a secret that is **not in
  1Password yet**: the mod refuses one unless Claude says what it checked in
  1Password and the steps name the exact `op://` reference to save it under.
- `none`: no secret manager. Claude may assign a `secret` task without the
  1Password checks.

Claude never feeds a password into `sudo` or a login prompt, even from
1Password. That stays a task for you.

## Limits

- On the Claude mobile app the pane has no text field, so an answer goes
  without a message.
- In a `claude -p` run, or the Agent SDK with no app attached, nobody is at the
  pane, so the tool is not registered. The VS Code extension also runs Claude
  through the SDK, but it attaches its panel, and the mod registers the tool
  then.
- Tasks live in the session's memory. They survive a reload of the mod, but
  `claude --resume` or `--continue` starts with no open tasks: numbers start
  again at #1, and earlier rejections are forgotten.
- If Claude Code does not take your answer (for example, another mod's hook
  refuses it), the task stays open and a toast says so. Answer it again in
  `/htl`.
- The engine never runs a mod's own hook for an event the mod itself raised. So
  the answer the pane sends gets no "open tasks" line, and the pane's own
  handler (not the `prompt.submit` hook) lifts the `now` gate.

## Development

The mod uses the TypeScript, ESLint and Prettier setup at the repository root
(see [`plugins/README.md`](../README.md#develop-a-mod)). From the root:

```bash
bun install
bun run check                  # types, tsc, ESLint, Prettier, tests, validate
bun run lint plugins/htl       # ESLint on this mod only
claude plugin test plugins/htl # unit tests and hook tests, no model calls
```

The type-check reads the mod API types from `.claude-types/` at the root, which
leaves out the generated `claude-code-mcp` types on purpose: they list the MCP
servers connected on your machine, and with them the matcher
`{ tool: 'mcp__htl__assign_task' }` stops type-checking.
