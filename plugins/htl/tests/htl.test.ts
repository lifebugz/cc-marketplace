import type {
  On,
  PaneOpenArgs,
  PromptOrigin,
  RegisteredToolSpec,
  UiPane,
} from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

const TOOL = 'mcp__htl__assign_task'
const SURFACES = ['terminal', 'desktop'] as const
const COMPOSER = { kind: 'composer' } as const
const PANE = {
  plugin: 'htl',
  component: 'Pane',
  requestId: 'htl',
  props: {
    title: 'HTL tasks',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const LOGIN = {
  title: 'Log in to the GitHub CLI',
  steps: 'Run `! gh auth login` and finish the browser login.',
  blocker: 'login',
  why: 'The login needs a browser and a 2FA code.',
  tried: 'Ran `gh auth status`: not logged in.',
  mode: 'now',
  check: 'gh auth status',
} as const

const DNS = {
  title: 'Point the CNAME at x.vercel.app',
  steps: 'At your registrar, set `www` CNAME to `x.vercel.app`.',
  blocker: 'no_access',
  why: 'I have no access to the registrar.',
  tried: 'Looked for a registrar CLI or API token: none.',
  mode: 'parallel',
} as const

interface Submitted {
  text: string
  context: readonly string[]
  origin: PromptOrigin
}

interface World {
  tools: RegisteredToolSpec[]
  commands: string[]
  opened: PaneOpenArgs[]
  closedPanes: string[]
  toasts: string[]
  statuses: (string | undefined)[]
  logs: string[]
  submitted: Submitted[]
  ran: string[]
  isPlaced: boolean
  isOpenRefused: boolean
}

function setup(on: On, env: Record<string, string> = {}): World {
  const world: World = {
    tools: [],
    commands: [],
    opened: [],
    closedPanes: [],
    toasts: [],
    statuses: [],
    logs: [],
    submitted: [],
    ran: [],
    isPlaced: true,
    isOpenRefused: false,
  }
  mock.env(on, env)
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.register', (_$, e) => {
    world.tools.push(e)
    return { value: { tool: `mcp__htl__${e.name}` } }
  })
  on('command.register', (_$, e) => {
    world.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.open', (_$, e) => {
    world.opened.push(e)
    if (world.isOpenRefused) return { deny: 'no surface draws panes' }
    return {
      value: world.isPlaced
        ? { isPlaced: true }
        : { isPlaced: false, reason: 'the terminal is 120 columns wide' },
    }
  })
  on('ui.close', (_$, e) => {
    world.closedPanes.push(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => {
    const panes: UiPane[] =
      world.opened.length === 0
        ? []
        : [
            {
              id: 'htl',
              title: 'HTL tasks',
              isShown: world.isPlaced,
              isFocused: false,
              isPlaced: world.isPlaced,
            },
          ]
    return { value: panes }
  })
  on('ui.toast', (_$, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    world.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    world.logs.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => {
    world.submitted.push({
      text: e.text,
      context: e.context ?? [],
      origin: e.origin,
    })
    return { text: e.text }
  })
  on('tool.call', (_$, e) => {
    world.ran.push(e.tool)
    return { result: 'ran' }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  return world
}

function start($: Engine, isInteractive = true): Promise<unknown> {
  return $.session.start({ cwd: '/work', surface: 'terminal', isInteractive })
}

let ids = 0

function assign(
  $: Engine,
  input: Readonly<Record<string, unknown>>,
  agentId?: string,
): Promise<{ result?: unknown; deny?: string | undefined }> {
  ids += 1
  return $.tool.call({
    ...input,
    tool: TOOL,
    tool_use_id: `toolu_${String(ids)}`,
    ...(agentId === undefined ? {} : { agentId }),
  })
}

function bash(
  $: Engine,
  agentId?: string,
): Promise<{ result?: unknown; deny?: string | undefined }> {
  ids += 1
  return $.tool.call({
    tool: 'Bash',
    tool_use_id: `toolu_${String(ids)}`,
    command: 'gh auth status',
    ...(agentId === undefined ? {} : { agentId }),
  })
}

function type($: Engine, text: string): Promise<unknown> {
  return $.prompt.submit({ text, wait: false, origin: COMPOSER })
}

function runHtl($: Engine): Promise<{ text?: string | undefined }> {
  return $.command.run({
    command: 'htl',
    args: '',
    origin: COMPOSER,
    presentation: { isFullscreen: true, columns: 120 },
  })
}

function endTurn($: Engine, agentId?: string): Promise<{ text: string }> {
  return $.turn.complete({
    answer: 'Waiting for you.',
    durationMs: 1000,
    isAborted: false,
    turnId: 'turn_1',
    reason: 'answer',
    ...(agentId === undefined ? {} : { agentId }),
  })
}

describe('the tool', () => {
  test('an interactive session gets the tool, with the 1Password rules, and /htl', async ($, on) => {
    const world = setup(on)
    await start($)
    expect(world.tools).toHaveLength(1)
    const [tool] = world.tools
    expect(tool?.name).toBe('assign_task')
    expect(tool?.isDeferred).toBe(false)
    expect(tool?.description).toContain('op run --env-file=')
    expect(tool?.inputSchema['required']).toEqual([
      'title',
      'steps',
      'blocker',
      'why',
      'tried',
      'mode',
    ])
    expect(world.commands).toEqual(['htl'])
  })

  test('a -p run without EVAL_HTL gets no tool, but still /htl', async ($, on) => {
    const world = setup(on)
    await start($, false)
    expect(world.tools).toHaveLength(0)
    expect(world.commands).toEqual(['htl'])
  })

  test('a -p run with EVAL_HTL=1 gets the tool', async ($, on) => {
    const world = setup(on, { EVAL_HTL: '1' })
    await start($, false)
    expect(world.tools).toHaveLength(1)
  })

  test('EVAL_HTL with another value does not switch it on', async ($, on) => {
    const world = setup(on, { EVAL_HTL: 'yes' })
    await start($, false)
    expect(world.tools).toHaveLength(0)
  })

  test(
    'secrets: none gives a description without the 1Password rules',
    { options: { secrets: 'none' } },
    async ($, on) => {
      const world = setup(on)
      await start($)
      expect(world.tools[0]?.description).not.toContain('1Password')
      expect(world.tools[0]?.description).toContain('AskUserQuestion')
    },
  )
})

describe('now mode', () => {
  test('the next tool call is refused until the user answers', async ($, on) => {
    const world = setup(on)
    await start($)

    expect(await assign($, LOGIN)).toMatchObject({
      result:
        'Assigned as task #1 (now). End your turn now with one short line saying what you are waiting for. Other tool calls are refused until the user answers; the answer arrives as the next user message.',
    })
    expect(await bash($)).toEqual({
      deny: 'Waiting for the user to finish HTL task #1 "Log in to the GitHub CLI". End your turn now.',
    })
    expect(world.ran).toEqual([])

    await type($, 'any news?')
    expect(await bash($)).toMatchObject({ result: 'ran' })
    expect(world.ran).toEqual(['Bash'])
  })

  test('answering another task in the pane also lifts the gate', async ($, on) => {
    const world = setup(on)
    await start($)
    await assign($, LOGIN)
    await assign($, DNS)
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await pane.press({ key: 'next' })
    await pane.press({ key: 'handback' })
    await pane.input({ key: 'message', text: '' })
    await pane.unmount()

    expect(world.submitted.at(-1)?.text).toContain('HTL task #2')
    expect(await bash($)).toMatchObject({ result: 'ran' })
    expect(world.ran).toEqual(['Bash'])
  })

  test("a subagent's tool calls pass the gate", async ($, on) => {
    const world = setup(on)
    await start($)
    await assign($, LOGIN)
    expect(await bash($, 'agent_1')).toMatchObject({ result: 'ran' })
    expect(world.ran).toEqual(['Bash'])
  })

  test('a second task can still be assigned in the same turn', async ($, on) => {
    setup(on)
    await start($)
    await assign($, LOGIN)
    expect(await assign($, DNS)).toMatchObject({
      result: expect.stringContaining('Assigned as task #2 (parallel)'),
    })
  })
})

describe('parallel mode', () => {
  test('tool calls run right away', async ($, on) => {
    const world = setup(on)
    await start($)
    expect(await assign($, DNS)).toMatchObject({
      result:
        "Assigned as task #1 (parallel). Keep working only on what does not depend on it. Don't do it yourself, don't assume it's done. When that work is done, end your turn and say you are waiting for task #1.",
    })
    expect(await bash($)).toMatchObject({ result: 'ran' })
    expect(world.ran).toEqual(['Bash'])
  })
})

describe('refusals', () => {
  test('bad input is refused with what to fix, and no task opens', async ($, on) => {
    const world = setup(on)
    await start($)
    expect(
      await assign($, { ...LOGIN, blocker: 'hard', title: '' }),
    ).toMatchObject({
      result:
        'The task was not assigned: title is empty; blocker must be one of: secret, login, physical, payment_or_legal, no_access. Fix these fields and call mcp__htl__assign_task again.',
    })
    expect(world.opened).toEqual([])
    expect(await runHtl($)).toEqual({ text: 'No open HTL tasks.' })
  })

  test('a fourth open task is refused', async ($, on) => {
    setup(on)
    await start($)
    for (const n of [1, 2, 3]) {
      await assign($, { ...DNS, title: `job ${String(n)}` })
    }
    expect(await assign($, LOGIN)).toMatchObject({
      result: 'Not assigned. The user already has 3 open tasks. Wait for them.',
    })
  })

  test('a subagent cannot assign a task', async ($, on) => {
    const world = setup(on)
    await start($)
    expect(await assign($, LOGIN, 'agent_1')).toMatchObject({
      result:
        'Only the main conversation can assign tasks; put the blocker in your final report.',
    })
    expect(world.opened).toEqual([])
  })

  test('a secret task with no 1Password evidence is refused', async ($, on) => {
    setup(on)
    await start($)
    expect(
      await assign($, {
        ...LOGIN,
        blocker: 'secret',
        tried: 'Looked in .env.',
      }),
    ).toMatchObject({
      result: expect.stringContaining('Your secrets are in 1Password.'),
    })
  })

  test('a rejected task is refused when assigned again', async ($, on) => {
    setup(on)
    await start($)
    await assign($, LOGIN)
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await pane.press({ key: 'reject' })
    await pane.input({ key: 'message', text: '' })
    await pane.unmount()

    expect(
      await assign($, { ...LOGIN, title: 'log in to the github cli ' }),
    ).toMatchObject({
      result: expect.stringContaining(
        'The user already rejected task #1 "Log in to the GitHub CLI".',
      ),
    })
  })
})

describe('notices', () => {
  test('a placed pane gets focus and a toast, and no status line', async ($, on) => {
    const world = setup(on)
    await start($)
    await assign($, LOGIN)
    expect(world.opened).toEqual([
      { id: 'htl', title: 'HTL tasks', focus: true },
    ])
    expect(world.toasts).toEqual([
      'htl: Claude needs you for task #1 "Log in to the GitHub CLI"',
    ])
    expect(world.statuses.filter(text => text !== undefined)).toEqual([])
  })

  test('a pane that is not placed leaves a status line', async ($, on) => {
    const world = setup(on)
    world.isPlaced = false
    await start($)
    await assign($, LOGIN)
    await assign($, DNS)
    expect(world.statuses.at(-1)).toBe('2 tasks waiting for you · /htl')
  })

  test('a pane that fails to open does not break the result', async ($, on) => {
    const world = setup(on)
    world.isOpenRefused = true
    await start($)
    expect(await assign($, LOGIN)).toMatchObject({
      result: expect.stringContaining('Assigned as task #1 (now).'),
    })
    expect(world.statuses.at(-1)).toBe('1 task waiting for you · /htl')
    expect(
      world.logs.some(line => line.includes('the pane did not open')),
    ).toBe(true)
  })

  test('/htl opens the pane as a dialog, and says when there is nothing', async ($, on) => {
    const world = setup(on)
    await start($)
    expect(await runHtl($)).toEqual({ text: 'No open HTL tasks.' })
    await assign($, DNS)
    expect(await runHtl($)).toMatchObject({})
    expect(world.opened.at(-1)).toEqual({
      id: 'htl',
      title: 'HTL tasks',
      focus: true,
      closeOnEscape: true,
    })
  })
})

describe('what Claude reads while tasks are open', () => {
  test('one context line per user prompt, never on the answer htl sends', async ($, on) => {
    const world = setup(on)
    await start($)
    await type($, 'before')
    await assign($, DNS)
    await type($, 'meanwhile')

    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await pane.press({ key: 'accept' })
    await pane.input({ key: 'message', text: '' })
    await pane.unmount()
    await type($, 'after')

    expect(world.submitted.map(one => one.context)).toEqual([
      [],
      [
        'Open HTL tasks waiting for the user: #1 "Point the CNAME at x.vercel.app" (parallel). Don\'t assume they are done.',
      ],
      [],
      [],
    ])
  })

  test('a reminder under the answer while tasks are open, not in subagents', async ($, on) => {
    setup(on)
    await start($)
    expect(await endTurn($)).toMatchObject({ text: 'Waiting for you.' })
    await assign($, LOGIN)
    expect(await endTurn($)).toMatchObject({
      text: '⏳ htl: waiting for you on task #1 · /htl',
    })
    expect(await endTurn($, 'agent_1')).toMatchObject({
      text: 'Waiting for you.',
    })
  })
})

for (const surface of SURFACES) {
  describe(`the pane on ${surface}`, () => {
    test('the card shows the task, and Accept with a message sends the exact answer', async ($, on) => {
      const world = setup(on)
      await start($)
      await assign($, LOGIN)
      const pane = await $.ui.mount({ ...PANE, surface })

      expect(
        await pane.find({ type: 'Text', text: '#1 · NOW · 1 of 1' }),
      ).toBeDefined()
      expect(
        await pane.find({ type: 'Text', text: 'Log in to the GitHub CLI' }),
      ).toBeDefined()
      expect(
        await pane.find({
          type: 'Text',
          text: /Claude tried: Ran `gh auth status`/,
        }),
      ).toBeDefined()
      expect(
        await pane.find({
          type: 'Text',
          text: 'Claude will check: gh auth status',
        }),
      ).toBeDefined()
      expect(await pane.find({ key: 'accept' })).toMatchObject({
        props: { hotkey: 'a' },
      })
      expect(await pane.find({ key: 'next' })).toBeUndefined()

      await pane.press({ key: 'accept' })
      expect(
        await pane.find({
          type: 'Text',
          text: /^Accept #1\. Message to Claude/,
        }),
      ).toBeDefined()
      await pane.input({ key: 'message', text: 'I used my work account' })

      expect(world.submitted).toEqual([
        {
          text: 'HTL task #1 "Log in to the GitHub CLI": accepted, I did it.\nMy message: I used my work account\nCheck it worked (run `gh auth status` or re-run what failed), then continue.',
          context: [],
          origin: { kind: 'plugin', name: 'htl', asUser: true },
        },
      ])
      expect(world.toasts.at(-1)).toBe('htl: task #1 accepted')
      expect(world.closedPanes).toEqual(['htl'])
      expect(world.statuses.at(-1)).toBeUndefined()
      await pane.unmount()
    })

    test('Reject and You can do this, without a message', async ($, on) => {
      const world = setup(on)
      await start($)
      await assign($, LOGIN)
      await assign($, DNS)
      const pane = await $.ui.mount({ ...PANE, surface })

      await pane.press({ key: 'reject' })
      await pane.input({ key: 'message', text: '   ' })
      expect(world.submitted.at(-1)?.text).toBe(
        "HTL task #1 \"Log in to the GitHub CLI\": rejected, I won't do it.\nDon't assume it's done. Find another way, or tell me what stays blocked.",
      )
      expect(world.closedPanes).toEqual([])

      expect(
        await pane.find({
          type: 'Text',
          text: 'Point the CNAME at x.vercel.app',
        }),
      ).toBeDefined()
      await pane.press({ key: 'handback' })
      await pane.input({ key: 'message', text: '' })
      expect(world.submitted.at(-1)?.text).toBe(
        'HTL task #2 "Point the CNAME at x.vercel.app": you can do this yourself.\nDo it with your own tools. Don\'t assign it to me again.',
      )
      expect(world.submitted.map(one => one.origin)).toEqual([
        { kind: 'plugin', name: 'htl', asUser: true },
        { kind: 'plugin', name: 'htl', asUser: true },
      ])
      expect(world.closedPanes).toEqual(['htl'])
      await pane.unmount()
    })

    test('Next switches the card, and Back returns to the buttons', async ($, on) => {
      setup(on)
      await start($)
      await assign($, LOGIN)
      await assign($, DNS)
      const pane = await $.ui.mount({ ...PANE, surface })

      expect(
        await pane.find({ type: 'Text', text: '#1 · NOW · 1 of 2' }),
      ).toBeDefined()
      await pane.press({ key: 'next' })
      expect(
        await pane.find({ type: 'Text', text: '#2 · PARALLEL · 2 of 2' }),
      ).toBeDefined()
      await pane.press({ key: 'next' })
      expect(
        await pane.find({ type: 'Text', text: '#1 · NOW · 1 of 2' }),
      ).toBeDefined()

      await pane.press({ key: 'reject' })
      expect(await pane.find({ key: 'message' })).toBeDefined()
      expect(await pane.find({ key: 'accept' })).toBeUndefined()
      await pane.press({ key: 'back' })
      expect(await pane.find({ key: 'message' })).toBeUndefined()
      expect(await pane.find({ key: 'accept' })).toBeDefined()
      await pane.unmount()
    })

    test('the focus hint shows until the pane has the keys', async ($, on) => {
      setup(on)
      await start($)
      await assign($, LOGIN)
      const pane = await $.ui.mount({
        ...PANE,
        surface,
        props: { ...PANE.props, isFocused: false },
      })
      expect(
        await pane.find({
          type: 'Text',
          text: '#1 · NOW · 1 of 1 · ctrl+x tab to use',
        }),
      ).toBeDefined()
      await pane.unmount()
    })
  })
}

test('mobile has no text field, so the answer goes without a message', async ($, on) => {
  const world = setup(on)
  await start($)
  await assign($, LOGIN)
  const pane = await $.ui.mount({ ...PANE, surface: 'mobile' })
  await pane.press({ key: 'accept' })
  await pane.press({ key: 'send' })
  expect(world.submitted.at(-1)?.text).toBe(
    'HTL task #1 "Log in to the GitHub CLI": accepted, I did it.\nCheck it worked (run `gh auth status` or re-run what failed), then continue.',
  )
  await pane.unmount()
})

test('a pane with no tasks says so', async ($, on) => {
  setup(on)
  await start($)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(
    await pane.find({ type: 'Text', text: 'No open HTL tasks.' }),
  ).toBeDefined()
  await pane.unmount()
})
