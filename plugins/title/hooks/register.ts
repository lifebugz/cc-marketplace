import type {
  EngineInterface,
  ModelCompleteResult,
  Register,
} from 'claude-code'

import { buildNameRequest, excerptOf, kebabCase, parseName } from './naming'

const TOAST_MS = 8000
const NAME_TIMEOUT_MS = 15000
const RENAME_TRIES = 3
const ASK_TEXT = '/title '

type Naming =
  | { readonly kind: 'named'; readonly name: string }
  | { readonly kind: 'ask' }
  | { readonly kind: 'failed'; readonly toast: string }

function reasonOf(error: unknown, plugin: string): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.startsWith(`${plugin}: `) ? text.slice(plugin.length + 2) : text
}

function failureOf(reply: ModelCompleteResult): string {
  if (reply.isAnswered) {
    return 'it answered'
  }
  if (reply.reason === 'api-error') {
    return reply.status === null
      ? 'API error'
      : `API error ${String(reply.status)}`
  }
  return reply.reason === 'empty-reply'
    ? 'empty reply'
    : `no answer within ${String(NAME_TIMEOUT_MS / 1000)} s`
}

async function nameFromConversation($: EngineInterface): Promise<Naming> {
  const excerpt = excerptOf(await $.session.messages())
  if (excerpt === '') {
    return { kind: 'ask' }
  }
  let reply: ModelCompleteResult
  try {
    reply = await $.model.complete({
      model: 'haiku',
      effort: 'low',
      maxTokens: 64,
      timeoutMs: NAME_TIMEOUT_MS,
      ...buildNameRequest(excerpt),
    })
  } catch (error) {
    return {
      kind: 'failed',
      toast: `Haiku could not name it (${reasonOf(error, $.plugin.name)})`,
    }
  }
  if (!reply.isAnswered) {
    return {
      kind: 'failed',
      toast: `Haiku could not name it (${failureOf(reply)})`,
    }
  }
  const name = parseName(reply.text)
  return name === undefined
    ? { kind: 'failed', toast: "Haiku's reply was not a usable name." }
    : { kind: 'named', name }
}

function nameFromTyped(typed: string): Naming {
  const name = kebabCase(typed)
  return name === ''
    ? { kind: 'failed', toast: 'A name needs at least one letter or digit.' }
    : { kind: 'named', name }
}

async function askForName($: EngineInterface): Promise<void> {
  const { isFilled } = await $.prompt.fill({ text: ASK_TEXT })
  $.ui.toast(
    isFilled
      ? 'Nothing to name yet: type a name after /title, then press Enter.'
      : 'Nothing to name yet: run /title <name>.',
    { timeoutMs: TOAST_MS },
  )
}

function renameSoon($: EngineInterface, name: string, tries: number): void {
  // Claude Code refuses $.command.run while /title's hook is still running
  // ("it would wait on the turn this hook is holding"). Even at 0 ms the timer
  // is a round trip through Claude Code, so it fires after /title has answered;
  // the retries cover a time it would not.
  $.clock.after(0, () => {
    void rename($, name, tries)
  })
}

async function rename(
  $: EngineInterface,
  name: string,
  tries: number,
): Promise<void> {
  try {
    await $.command.run({ command: 'rename', args: name })
  } catch (error) {
    if (tries > 1) {
      renameSoon($, name, tries - 1)
      return
    }
    $.ui.toast(
      `Could not rename the session (${reasonOf(error, $.plugin.name)})`,
      { timeoutMs: TOAST_MS },
    )
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'title',
      description:
        'Name this session: Haiku picks a name from the conversation, or give your own',
      argumentHint: '[name]',
      // Runs mid-turn as the built-in /rename does; the /rename it starts
      // still waits for the turn to end.
      immediate: true,
    })
    return next(e)
  })

  // No text and no context: Claude Code then keeps no row for the /title line.
  on('command.run', { command: 'title' }, async ($, e) => {
    const typed = e.args.trim()
    const naming =
      typed === '' ? await nameFromConversation($) : nameFromTyped(typed)
    if (naming.kind === 'named') {
      renameSoon($, naming.name, RENAME_TRIES)
    } else if (naming.kind === 'ask') {
      await askForName($)
    } else {
      $.ui.toast(naming.toast, { timeoutMs: TOAST_MS })
    }
    return {}
  })
}
