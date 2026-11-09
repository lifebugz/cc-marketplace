import type {
  ModelCompleteInput,
  ModelCompleteResult,
  On,
  SessionMessage,
} from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

const TYPED = {
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const

// What the engine sends for a bare `/rename`.
const BARE = { ...TYPED, command: 'rename', args: '' } as const

const USAGE = {
  input_tokens: 900,
  output_tokens: 8,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

const said = (role: 'user' | 'assistant', text: string): SessionMessage => ({
  role,
  text,
  toolUses: [],
})

const CONVERSATION: SessionMessage[] = [
  said(
    'user',
    'The login page sends people back to / after they sign in. It should go to the page they came from.',
  ),
  {
    role: 'assistant',
    text: 'I will look at the redirect handling.',
    toolUses: [
      {
        tool_use_id: 't1',
        tool: 'Read',
        input: { file_path: '/home/me/app/src/auth/redirect.ts' },
      },
      {
        tool_use_id: 't2',
        tool: 'Bash',
        input: { command: 'npm test -- auth' },
      },
    ],
  },
  said(
    'user',
    '<system-reminder>Secret reminder text.</system-reminder>Also keep the ?next= query.',
  ),
]

interface World {
  messages: SessionMessage[]
  reply: ModelCompleteResult | 'refused'
  requests: ModelCompleteInput[]
  renamed: string[]
  toasts: string[]
  statuses: (string | undefined)[]
}

function setup(on: On): World {
  const world: World = {
    messages: CONVERSATION,
    reply: answered('Fix login redirect'),
    requests: [],
    renamed: [],
    toasts: [],
    statuses: [],
  }
  on('session.messages', () => ({ value: world.messages }))
  on('model.complete', (_$, e) => {
    world.requests.push(e)
    return world.reply === 'refused'
      ? { deny: 'the haiku model is blocked' }
      : { value: world.reply }
  })
  // Stands for the built-in /rename beneath the mod.
  on('command.run', { command: 'rename' }, (_$, e) => {
    world.renamed.push(e.args)
    return { text: `Session renamed to: ${e.args}` }
  })
  on('ui.toast', (_$, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    world.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  return world
}

const answered = (text: string): ModelCompleteResult => ({
  isAnswered: true,
  text,
  usage: USAGE,
})

describe('a bare /rename', () => {
  test("hands Haiku's title to the built-in /rename", async ($, on) => {
    const world = setup(on)
    world.reply = answered('"Fix login redirect to return page."')

    const answer = await $.command.run(BARE)

    expect(world.renamed).toEqual(['Fix login redirect to return page'])
    expect(answer.text).toBe(
      'Session renamed to: Fix login redirect to return page',
    )
    expect(world.toasts).toEqual([])
  })

  test('asks Haiku about the conversation, its files and commands', async ($, on) => {
    const world = setup(on)
    world.reply = answered('Fix login redirect')

    await $.command.run({ ...BARE, args: '  ' })

    const [request] = world.requests
    expect(world.requests).toHaveLength(1)
    expect(request?.model).toBe('haiku')
    expect(request?.prompt).toContain('sends people back to /')
    expect(request?.prompt).toContain('Also keep the ?next= query.')
    expect(request?.prompt).toContain('src/auth/redirect.ts')
    expect(request?.prompt).toContain('npm test -- auth')
    expect(request?.prompt).not.toContain('Secret reminder text')
    expect(request?.prompt).not.toContain('/home/me')
  })

  test('shows a status line while Haiku works, then clears it', async ($, on) => {
    const world = setup(on)
    world.reply = answered('Fix login redirect')

    await $.command.run(BARE)

    expect(world.statuses).toEqual(['Haiku is naming this session…', undefined])
  })
})

describe('/rename falls back to the built-in', () => {
  test('with a name typed, which it keeps as typed', async ($, on) => {
    const world = setup(on)
    world.reply = answered('Not this one')

    await $.command.run({ ...BARE, args: 'my own name' })

    expect(world.renamed).toEqual(['my own name'])
    expect(world.requests).toEqual([])
  })

  test('when the person has written nothing yet', async ($, on) => {
    const world = setup(on)
    world.reply = answered('Not this one')
    world.messages = [
      said('user', '<command-name>/rename</command-name>'),
      said('assistant', ''),
    ]

    await $.command.run(BARE)

    expect(world.renamed).toEqual([''])
    expect(world.requests).toEqual([])
    expect(world.toasts).toEqual([])
  })

  test('when Haiku fails, and says why', async ($, on) => {
    const world = setup(on)
    world.reply = {
      isAnswered: false,
      reason: 'api-error',
      status: 529,
      error: 'overloaded',
      usage: USAGE,
    }

    await $.command.run(BARE)

    expect(world.renamed).toEqual([''])
    expect(world.toasts).toEqual([
      'Haiku failed (overloaded), so /rename ran without it',
    ])
    expect(world.statuses.at(-1)).toBeUndefined()
  })

  test('when Haiku is refused', async ($, on) => {
    const world = setup(on)
    world.reply = 'refused'

    await $.command.run(BARE)

    expect(world.renamed).toEqual([''])
    expect(world.toasts).toEqual([
      'Haiku could not run (the haiku model is blocked), so /rename ran without it',
    ])
    expect(world.statuses.at(-1)).toBeUndefined()
  })

  test('when Haiku answers with nothing usable', async ($, on) => {
    const world = setup(on)
    world.reply = answered('  "" \n')

    await $.command.run(BARE)

    expect(world.renamed).toEqual([''])
    expect(world.toasts).toEqual([
      'Haiku sent no usable title, so /rename ran without it',
    ])
  })
})
