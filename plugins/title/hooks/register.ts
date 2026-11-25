import type {
  EngineInterface,
  ModelCompleteResult,
  Register,
} from 'claude-code'

import { buildNameRequest, excerptOf, parseName } from './naming'

const TOAST_MS = 8000
const NAME_TIMEOUT_MS = 15000
const MESSAGES_READ = 40

// No $ call sets a session's title. A classic UserPromptSubmit hook's
// sessionTitle is the only route that adds no row for the model, so the name
// waits here for the next prompt.
let pendingName: string | undefined

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

async function askForName($: EngineInterface, hint: string): Promise<string> {
  pendingName = undefined
  const messages = await $.session.messages({ last: MESSAGES_READ })
  if ('deny' in messages) {
    return `Could not read the conversation (${messages.deny})`
  }
  const excerpt = excerptOf(messages)
  if (excerpt === '') {
    return 'Nothing to name yet: send a prompt first.'
  }
  let reply: ModelCompleteResult
  try {
    reply = await $.model.complete({
      model: 'haiku',
      effort: 'low',
      maxTokens: 64,
      timeoutMs: NAME_TIMEOUT_MS,
      ...buildNameRequest(excerpt, hint),
    })
  } catch (error) {
    return `Haiku could not name it (${reasonOf(error, $.plugin.name)})`
  }
  if (!reply.isAnswered) {
    return `Haiku could not name it (${failureOf(reply)})`
  }
  const name = parseName(reply.text)
  if (name === undefined) {
    return "Haiku's reply was not a usable name."
  }
  pendingName = name
  return `Your next prompt names this session: ${name}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'title',
      description: 'Name this session with Haiku, from the conversation so far',
      argumentHint: '[hint]',
    })
    return next(e)
  })

  // An answer with no text and no context is the one a command leaves no row
  // for, so the toast carries the outcome.
  on('command.run', { command: 'title' }, async ($, e) => {
    $.ui.toast(await askForName($, e.args), { timeoutMs: TOAST_MS })
    return {}
  })

  // A name the person picks with /rename after /title wins over Haiku's.
  on('command.run', { command: 'rename' }, async (_$, e, next) => {
    pendingName = undefined
    return next(e)
  })

  on('classic.UserPromptSubmit', async (_$, e, next) => {
    const result = await next(e)
    if (pendingName === undefined || result.block !== undefined) {
      return result
    }
    const sessionTitle = pendingName
    pendingName = undefined
    return { ...result, sessionTitle }
  })

  // After /clear the name would land on a new, empty conversation.
  on('session.end', async (_$, e, next) => {
    pendingName = undefined
    return next(e)
  })
}
