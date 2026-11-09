import type {
  EngineInterface,
  ModelCompleteResult,
  Register,
} from 'claude-code'

import { digestOf, titleOf, titleRequest } from './title'

const MODEL = 'haiku'
const MAX_TOKENS = 100
const TIMEOUT_MS = 20_000

type Named = { readonly title: string } | { readonly failure: string }

function failureOf(reply: ModelCompleteResult): string {
  if (reply.isAnswered) {
    return 'Haiku sent no usable title'
  }
  if (reply.reason === 'api-error') {
    return `Haiku failed (${reply.error})`
  }
  if (reply.reason === 'empty-reply') {
    return 'Haiku sent an empty reply'
  }
  return 'Haiku did not answer in time'
}

async function askHaiku(
  $: EngineInterface,
  digest: string,
  signal: AbortSignal,
): Promise<Named> {
  const { system, prompt } = titleRequest(digest)
  $.ui.status('Haiku is naming this session…')
  let reply: ModelCompleteResult
  try {
    reply = await $.model.complete(
      {
        model: MODEL,
        system,
        prompt,
        maxTokens: MAX_TOKENS,
        effort: 'low',
        timeoutMs: TIMEOUT_MS,
      },
      { signal },
    )
  } catch (error) {
    return { failure: `Haiku could not run (${String(error)})` }
  } finally {
    $.ui.status(undefined)
  }
  $.ui.log(
    `haiku-rename: ${String(reply.usage.input_tokens)} tokens in, ${String(reply.usage.output_tokens)} out`,
    { to: 'debug' },
  )
  const title = reply.isAnswered ? titleOf(reply.text) : ''
  return title === '' ? { failure: failureOf(reply) } : { title }
}

export const register: Register = on => {
  // `/rename <name>` keeps the name typed. A bare `/rename` gets Haiku's title
  // as its argument, so the built-in command still does the renaming.
  on('command.run', { command: 'rename' }, async ($, e, next) => {
    if (e.args.trim() !== '') {
      return next(e)
    }
    const digest = digestOf(await $.session.messages())
    if (digest === '') {
      return next(e)
    }
    const named = await askHaiku($, digest, next.signal)
    if ('failure' in named) {
      $.ui.toast(`${named.failure}, so /rename ran without it`)
      return next(e)
    }
    return next({ ...e, args: named.title })
  }).catch(async (_$, e, next) => next(e))
}
