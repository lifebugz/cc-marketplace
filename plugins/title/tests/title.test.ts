import type { ModelCompleteResult, On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

const USAGE = {
  input_tokens: 120,
  output_tokens: 4,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}
const NAMED: ModelCompleteResult = {
  isAnswered: true,
  text: 'fix-login-timeout',
  usage: USAGE,
}
const CONVERSATION = [
  '<system-reminder>\nThe user is some.one@example.com\n</system-reminder>\nThe login page times out after 5 seconds. Please fix it.',
  'I raised the login timeout to 30 seconds.',
]
const PRESENTATION = { isFullscreen: true, columns: 120 }

interface Seen {
  readonly toasts: string[]
  readonly prompts: string[]
  readonly models: string[]
}

interface Stage {
  readonly said?: readonly string[]
  readonly blocks?: () => boolean
}

/** Stands for the engine: the conversation, Haiku's reply to each call, the toasts. */
function engine(
  on: On,
  answer: (call: number) => ModelCompleteResult | 'refused',
  stage: Stage = {},
): Seen {
  const seen: Seen = { toasts: [], prompts: [], models: [] }
  const said = stage.said ?? CONVERSATION
  on('session.messages', () => ({
    value: said.map((text, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      text,
      toolUses: [],
    })),
  }))
  on('model.complete', (_$, e) => {
    const reply = answer(seen.models.length)
    seen.prompts.push(e.prompt)
    seen.models.push(e.model)
    return reply === 'refused' ? { deny: 'blocked here' } : { value: reply }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('classic.UserPromptSubmit', () =>
    stage.blocks?.() === true ? { block: 'not now' } : {},
  )
  on('command.run', { command: 'rename' }, (_$, e) => ({
    text: `Session renamed to: ${e.args}`,
  }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  return seen
}

describe('/title', () => {
  test('asks Haiku and answers with no text, so no row is written', async ($, on) => {
    const seen = engine(on, () => NAMED)

    const answer = await $.command.run({
      command: 'title',
      args: '',
      origin: { kind: 'composer' },
      presentation: PRESENTATION,
    })

    expect(answer.text).toBeUndefined()
    expect(answer.context).toBeUndefined()
    expect(seen.models).toEqual(['haiku'])
    expect(seen.toasts).toEqual([
      'Your next prompt names this session: fix-login-timeout',
    ])
  })

  test("sends the conversation and the hint, never Claude Code's reminders", async ($, on) => {
    const seen = engine(on, () => NAMED)

    await $.command.run({
      command: 'title',
      args: 'login work',
      origin: { kind: 'composer' },
      presentation: PRESENTATION,
    })

    const [prompt] = seen.prompts
    expect(prompt).toContain('times out after 5 seconds')
    expect(prompt).toContain('raised the login timeout')
    expect(prompt).toContain("The person's hint for the title: login work")
    expect(prompt).not.toContain('some.one@example.com')
  })

  test('a long run of silent tool calls still names the first request', async ($, on) => {
    const seen = engine(on, () => NAMED, {
      said: [CONVERSATION[0] ?? '', ...Array.from({ length: 41 }, () => '')],
    })

    await $.command.run({
      command: 'title',
      args: '',
      origin: { kind: 'composer' },
      presentation: PRESENTATION,
    })

    expect(seen.prompts[0]).toContain('times out after 5 seconds')
    expect(seen.toasts).toEqual([
      'Your next prompt names this session: fix-login-timeout',
    ])
  })
})

describe('the name lands on the next prompt', () => {
  test('once, with no other change to the prompt', async ($, on) => {
    engine(on, () => NAMED)
    await $.command.run({
      command: 'title',
      args: '',
      origin: { kind: 'composer' },
      presentation: PRESENTATION,
    })

    const next = await $.classic.UserPromptSubmit({ prompt: 'Now add a test' })
    const after = await $.classic.UserPromptSubmit({ prompt: 'And a README' })

    expect(next).toEqual({ sessionTitle: 'fix-login-timeout' })
    expect(after).toEqual({})
  })

  test('a prompt with no name waiting passes through untouched', async ($, on) => {
    engine(on, () => NAMED)

    expect(await $.classic.UserPromptSubmit({ prompt: 'hello' })).toEqual({})
  })

  test('a blocked prompt keeps the name for the one after it', async ($, on) => {
    let blocks = true
    engine(on, () => NAMED, { blocks: () => blocks })
    await $.command.run({
      command: 'title',
      args: '',
      origin: { kind: 'composer' },
      presentation: PRESENTATION,
    })

    const blocked = await $.classic.UserPromptSubmit({ prompt: 'one' })
    blocks = false
    const passed = await $.classic.UserPromptSubmit({ prompt: 'two' })

    expect(blocked).toEqual({ block: 'not now' })
    expect(passed).toEqual({ sessionTitle: 'fix-login-timeout' })
  })

  test('a second /title replaces the first name', async ($, on) => {
    engine(on, call =>
      call === 0
        ? NAMED
        : { isAnswered: true, text: 'raise-login-timeout', usage: USAGE },
    )
    for (let run = 0; run < 2; run += 1) {
      await $.command.run({
        command: 'title',
        args: '',
        origin: { kind: 'composer' },
        presentation: PRESENTATION,
      })
    }

    expect(await $.classic.UserPromptSubmit({ prompt: 'go' })).toEqual({
      sessionTitle: 'raise-login-timeout',
    })
  })

  test('a name picked with /rename wins over the waiting one', async ($, on) => {
    engine(on, () => NAMED)
    await $.command.run({
      command: 'title',
      args: '',
      origin: { kind: 'composer' },
      presentation: PRESENTATION,
    })

    const renamed = await $.command.run({
      command: 'rename',
      args: 'my-own-name',
      origin: { kind: 'composer' },
      presentation: PRESENTATION,
    })

    expect(renamed.text).toBe('Session renamed to: my-own-name')
    expect(await $.classic.UserPromptSubmit({ prompt: 'go' })).toEqual({})
  })

  test('/clear drops the waiting name', async ($, on) => {
    engine(on, () => NAMED)
    await $.command.run({
      command: 'title',
      args: '',
      origin: { kind: 'composer' },
      presentation: PRESENTATION,
    })

    await $.session.end({
      reason: 'clear',
      sessionId: 'old-one',
      resume: { id: 'old-one' },
    })

    expect(await $.classic.UserPromptSubmit({ prompt: 'go' })).toEqual({})
  })
})

describe('when no name comes, the toast says why and nothing waits', () => {
  const cases: readonly (readonly [
    string,
    ModelCompleteResult | 'refused',
    string,
  ])[] = [
    [
      'an API error',
      {
        isAnswered: false,
        reason: 'api-error',
        status: 529,
        error: 'overloaded',
        usage: USAGE,
      },
      'Haiku could not name it (API error 529)',
    ],
    [
      'a timeout',
      { isAnswered: false, reason: 'aborted', usage: USAGE },
      'Haiku could not name it (no answer within 15 s)',
    ],
    [
      'an empty reply',
      { isAnswered: false, reason: 'empty-reply', usage: USAGE },
      'Haiku could not name it (empty reply)',
    ],
    [
      'a refused call',
      'refused',
      'Haiku could not name it ($.model.complete: blocked here)',
    ],
    [
      'a reply that is no name',
      {
        isAnswered: true,
        text: 'Sure! A good title would be: Login Fix',
        usage: USAGE,
      },
      "Haiku's reply was not a usable name.",
    ],
  ]

  for (const [what, reply, toast] of cases) {
    test(what, async ($, on) => {
      const seen = engine(on, () => reply)

      const answer = await $.command.run({
        command: 'title',
        args: '',
        origin: { kind: 'composer' },
        presentation: PRESENTATION,
      })

      expect(answer.text).toBeUndefined()
      expect(seen.toasts).toEqual([toast])
      expect(await $.classic.UserPromptSubmit({ prompt: 'go' })).toEqual({})
    })
  }

  test('a conversation with nothing said yet asks no model', async ($, on) => {
    const seen = engine(on, () => NAMED, {
      said: ['<system-reminder>\nOnly context\n</system-reminder>'],
    })

    await $.command.run({
      command: 'title',
      args: '',
      origin: { kind: 'composer' },
      presentation: PRESENTATION,
    })

    expect(seen.models).toEqual([])
    expect(seen.toasts).toEqual(['Nothing to name yet: send a prompt first.'])
  })

  test('a failed /title drops the name an earlier one left waiting', async ($, on) => {
    engine(on, call =>
      call === 0
        ? NAMED
        : { isAnswered: false, reason: 'empty-reply', usage: USAGE },
    )
    for (let run = 0; run < 2; run += 1) {
      await $.command.run({
        command: 'title',
        args: '',
        origin: { kind: 'composer' },
        presentation: PRESENTATION,
      })
    }

    expect(await $.classic.UserPromptSubmit({ prompt: 'go' })).toEqual({})
  })
})
