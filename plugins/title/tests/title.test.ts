import type { CommandSpec, ModelCompleteResult, On } from 'claude-code'
import type { MockClock } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

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
const TYPED = {
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 120 },
} as const
const REFUSAL =
  'called from a command.run hook, it would wait on the turn this hook is holding'

interface Seen {
  readonly toasts: string[]
  readonly prompts: string[]
  readonly models: string[]
  readonly fills: string[]
  readonly renames: string[]
  readonly clock: MockClock
}

interface Stage {
  readonly said?: readonly string[]
  readonly isFillRefused?: boolean
  readonly renameRefusals?: number
}

/** Stands for the engine: the conversation, Haiku, the prompt box and /rename. */
function engine(
  on: On,
  answer: (call: number) => ModelCompleteResult | 'refused',
  stage: Stage = {},
): Seen {
  const seen: Seen = {
    toasts: [],
    prompts: [],
    models: [],
    fills: [],
    renames: [],
    clock: mock.clock(on),
  }
  const said = stage.said ?? CONVERSATION
  let refusals = stage.renameRefusals ?? 0
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
  on('prompt.fill', (_$, e) => {
    seen.fills.push(e.text)
    return stage.isFillRefused === true
      ? { isFilled: false, refusal: 'no_composer', text: '', cursor: 0 }
      : { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('command.run', { command: 'rename' }, (_$, e) => {
    seen.renames.push(e.args)
    if (refusals > 0) {
      refusals -= 1
      throw new Error(REFUSAL)
    }
    return { text: `Session renamed to: ${e.args}` }
  })
  return seen
}

test('registers /title as immediate, as the built-in /rename is', async ($, on) => {
  const specs: CommandSpec[] = []
  on('command.register', (_$, e) => {
    specs.push(e)
    return { value: { command: e.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(specs.map(spec => [spec.name, spec.immediate])).toEqual([
    ['title', true],
  ])
})

describe('/title in a conversation', () => {
  test('Haiku names it, and /rename runs once /title has answered', async ($, on) => {
    const seen = engine(on, () => NAMED)

    const answer = await $.command.run({ command: 'title', args: '', ...TYPED })
    const renamedEarly = [...seen.renames]
    await seen.clock.advance(0)

    expect(answer.text).toBeUndefined()
    expect(answer.context).toBeUndefined()
    expect(seen.models).toEqual(['haiku'])
    expect(renamedEarly).toEqual([])
    expect(seen.renames).toEqual(['fix-login-timeout'])
    expect(seen.toasts).toEqual([])
  })

  test("sends the conversation, never Claude Code's reminders", async ($, on) => {
    const seen = engine(on, () => NAMED)

    await $.command.run({ command: 'title', args: '', ...TYPED })

    const [prompt] = seen.prompts
    expect(prompt).toContain('times out after 5 seconds')
    expect(prompt).toContain('raised the login timeout')
    expect(prompt).not.toContain('some.one@example.com')
  })

  test('a long run of silent tool calls still names the first request', async ($, on) => {
    const seen = engine(on, () => NAMED, {
      said: [CONVERSATION[0] ?? '', ...Array.from({ length: 41 }, () => '')],
    })

    await $.command.run({ command: 'title', args: '', ...TYPED })
    await seen.clock.advance(0)

    expect(seen.prompts[0]).toContain('times out after 5 seconds')
    expect(seen.renames).toEqual(['fix-login-timeout'])
  })

  test('a /rename refused as too early is tried again', async ($, on) => {
    const seen = engine(on, () => NAMED, { renameRefusals: 2 })

    await $.command.run({ command: 'title', args: '', ...TYPED })
    for (let step = 0; step < 3; step += 1) {
      await seen.clock.advance(0)
    }

    expect(seen.renames).toEqual([
      'fix-login-timeout',
      'fix-login-timeout',
      'fix-login-timeout',
    ])
    expect(seen.toasts).toEqual([])
  })

  test('after 3 refusals a toast says why', async ($, on) => {
    const seen = engine(on, () => NAMED, { renameRefusals: 5 })

    await $.command.run({ command: 'title', args: '', ...TYPED })
    for (let step = 0; step < 5; step += 1) {
      await seen.clock.advance(0)
    }

    expect(seen.renames).toHaveLength(3)
    expect(seen.toasts).toHaveLength(1)
    expect(seen.toasts[0]).toMatch(/^Could not rename the session \(.+\)$/)
  })
})

describe('/title <name>', () => {
  test('uses your name in kebab-case, with no Haiku call', async ($, on) => {
    const seen = engine(on, () => NAMED)

    await $.command.run({ command: 'title', args: 'New Name', ...TYPED })
    await seen.clock.advance(0)

    expect(seen.models).toEqual([])
    expect(seen.renames).toEqual(['new-name'])
  })

  test('works with nothing said yet', async ($, on) => {
    const seen = engine(on, () => NAMED, { said: [] })

    await $.command.run({
      command: 'title',
      args: '  Fix: Login bug! ',
      ...TYPED,
    })
    await seen.clock.advance(0)

    expect(seen.fills).toEqual([])
    expect(seen.renames).toEqual(['fix-login-bug'])
  })

  test('a name with no letters or digits is refused', async ($, on) => {
    const seen = engine(on, () => NAMED)

    await $.command.run({ command: 'title', args: '!!! ...', ...TYPED })
    await seen.clock.advance(0)

    expect(seen.renames).toEqual([])
    expect(seen.toasts).toEqual(['A name needs at least one letter or digit.'])
  })
})

describe('/title with nothing said yet', () => {
  test('puts /title in the prompt box and asks for a name', async ($, on) => {
    const seen = engine(on, () => NAMED, {
      said: ['<system-reminder>\nOnly context\n</system-reminder>'],
    })

    const answer = await $.command.run({ command: 'title', args: '', ...TYPED })
    await seen.clock.advance(0)

    expect(answer.text).toBeUndefined()
    expect(seen.models).toEqual([])
    expect(seen.fills).toEqual(['/title '])
    expect(seen.toasts).toEqual([
      'Nothing to name yet: type a name after /title, then press Enter.',
    ])
    expect(seen.renames).toEqual([])
  })

  test('where no prompt box takes the text, the toast says what to run', async ($, on) => {
    const seen = engine(on, () => NAMED, { said: [], isFillRefused: true })

    await $.command.run({ command: 'title', args: '', ...TYPED })

    expect(seen.toasts).toEqual(['Nothing to name yet: run /title <name>.'])
  })
})

describe('when Haiku gives no name, a toast says why and nothing is renamed', () => {
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
        ...TYPED,
      })
      await seen.clock.advance(0)

      expect(answer.text).toBeUndefined()
      expect(seen.toasts).toEqual([toast])
      expect(seen.renames).toEqual([])
    })
  }
})
