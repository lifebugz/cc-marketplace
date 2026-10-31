import type {
  On,
  PaneOpenArgs,
  PromptOrigin,
  RegisteredToolSpec,
  UiPane,
} from 'claude-code'
import {
  describe,
  expect,
  mock,
  test,
  type Engine,
  type MockClock,
} from 'claude-code/testing'

const TOOL = 'mcp__htl__assign_task'
const SURFACES = ['terminal', 'desktop', 'vscode'] as const
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
  probes: (readonly string[])[]
  opExitCode: number | undefined
  isPlaced: boolean
  isOpenRefused: boolean
  clock: MockClock
  dropSubmit: { readonly task: number; readonly reason: string } | undefined
  holdSubmit: Promise<void> | undefined
  arrivals: (() => void)[]
  toasted: (() => void)[]
  isArmed: boolean
  armedAtSubmit: boolean[]
}

function setup(on: On): World {
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
    probes: [],
    opExitCode: 0,
    isPlaced: true,
    isOpenRefused: false,
    clock: mock.clock(on),
    dropSubmit: undefined,
    holdSubmit: undefined,
    arrivals: [],
    toasted: [],
    isArmed: false,
    armedAtSubmit: [],
  }
  on('session.start', () => ({ cwd: '/work' }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  on('process.run', (_$, e) => {
    world.probes.push(e.argv)
    if (world.opExitCode === undefined) {
      return { deny: 'spawn op ENOENT' }
    }
    return {
      value: {
        exitCode: world.opExitCode,
        stdout: '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
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
    if (world.isOpenRefused) {
      return { deny: 'no surface draws panes' }
    }
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
    for (const toasted of world.toasted.splice(0)) {
      toasted()
    }
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
  on('state.set', { plugin: 'htl', key: 'tasks' }, async (_$, e, next) => {
    world.isArmed = e.value.some(task => task.isArmed)
    return next(e)
  })
  on('prompt.submit', async (_$, e) => {
    world.armedAtSubmit.push(world.isArmed)
    world.submitted.push({
      text: e.text,
      context: e.context ?? [],
      origin: e.origin,
    })
    for (const arrived of world.arrivals.splice(0)) {
      arrived()
    }
    if (e.origin.kind !== 'plugin') {
      return { text: e.text }
    }
    await world.holdSubmit
    const drop = world.dropSubmit
    if (
      drop !== undefined &&
      e.text.startsWith(`HTL task #${String(drop.task)} `)
    ) {
      return { drop: drop.reason }
    }
    return { text: e.text }
  })
  on('tool.call', (_$, e) => {
    world.ran.push(e.tool)
    return { result: 'ran' }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  return world
}

interface Latch {
  readonly done: Promise<void>
  readonly open: () => void
}

function latch(): Latch {
  let open = (): void => undefined
  const done = new Promise<void>(resolve => {
    open = resolve
  })
  return { done, open }
}

async function start($: Engine, isInteractive = true): Promise<unknown> {
  return $.session.start({ cwd: '/work', surface: 'terminal', isInteractive })
}

let ids = 0

async function assign(
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

async function bash(
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

async function type($: Engine, text: string): Promise<unknown> {
  return $.prompt.submit({ text, wait: false, origin: COMPOSER })
}

async function runHtl(
  $: Engine,
  args = '',
  origin: PromptOrigin = COMPOSER,
): Promise<{ text?: string | undefined }> {
  return $.command.run({
    command: 'htl',
    args,
    origin,
    presentation: { isFullscreen: true, columns: 120 },
  })
}

async function endTurn($: Engine, agentId?: string): Promise<{ text: string }> {
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
    expect(world.probes).toEqual([['op', '--version']])
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

  test('a -p run gets no tool, but still /htl', async ($, on) => {
    const world = setup(on)
    await start($, false)
    expect(world.tools).toHaveLength(0)
    expect(world.commands).toEqual(['htl'])
  })

  test('an app that attaches to an SDK session, such as VS Code, gets the tool once', async ($, on) => {
    const world = setup(on)
    await start($, false)
    await $.session.attach({ surface: 'vscode', clientId: 'vscode-1' })
    await $.session.attach({ surface: 'mobile', clientId: 'mobile:default' })
    expect(world.tools.map(tool => tool.name)).toEqual(['assign_task'])
    expect(world.probes).toHaveLength(1)
  })

  test('a phone that attaches to a terminal session adds no second tool', async ($, on) => {
    const world = setup(on)
    await start($)
    await $.session.attach({ surface: 'mobile', clientId: 'mobile:default' })
    expect(world.tools).toHaveLength(1)
    expect(world.probes).toHaveLength(1)
  })

  test('with no op on the PATH, the description has no 1Password rules', async ($, on) => {
    const world = setup(on)
    world.opExitCode = undefined
    await start($)
    expect(world.tools[0]?.description).not.toContain('1Password')
    expect(world.tools[0]?.description).toContain('AskUserQuestion')
  })

  test('an op that exits with an error counts as no 1Password, and is logged', async ($, on) => {
    const world = setup(on)
    world.opExitCode = 1
    await start($)
    expect(world.tools[0]?.description).not.toContain('1Password')
    expect(world.logs).toContain(
      'htl: op --version failed, so no 1Password rules: exit code 1',
    )
    expect(
      await assign($, {
        ...LOGIN,
        blocker: 'secret',
        tried: 'Looked in .env.',
      }),
    ).toMatchObject({ result: expect.stringContaining('Assigned as task #1') })
    expect(world.probes).toHaveLength(1)
  })
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

  test('a background task notification does not lift the gate, but still reads the open tasks', async ($, on) => {
    const world = setup(on)
    await start($)
    await assign($, LOGIN)
    await $.prompt.submit({
      text: 'The background command finished.',
      wait: false,
      origin: { kind: 'task-notification' },
    })

    expect(world.submitted.at(-1)?.context).toEqual([
      'Open HTL tasks waiting for the user: #1 "Log in to the GitHub CLI" (now). Don\'t assume they are done.',
    ])
    expect(await bash($)).toEqual({
      deny: 'Waiting for the user to finish HTL task #1 "Log in to the GitHub CLI". End your turn now.',
    })
  })

  test('a prompt sent through Remote Control lifts the gate', async ($, on) => {
    const world = setup(on)
    await start($)
    await assign($, LOGIN)
    await $.prompt.submit({
      text: 'any news?',
      wait: false,
      origin: { kind: 'bridge' },
    })
    expect(await bash($)).toMatchObject({ result: 'ran' })
    expect(world.ran).toEqual(['Bash'])
  })

  test(
    "another mod's tool calls pass the gate",
    {
      plugins: [
        {
          name: 'watcher',
          register: (on): void => {
            on('command.run', { command: 'watch' }, async $ => {
              const out = await $.tool.call({ tool: 'Bash', command: 'date' })
              return {
                text:
                  typeof out.result === 'string'
                    ? out.result
                    : (out.deny ?? 'no result'),
              }
            })
          },
        },
      ],
    },
    async ($, on) => {
      const world = setup(on)
      await start($)
      await assign($, LOGIN)
      expect(
        await $.command.run({
          command: 'watch',
          args: '',
          origin: COMPOSER,
          presentation: { isFullscreen: true, columns: 120 },
        }),
      ).toMatchObject({ text: 'ran' })
      expect(world.ran).toEqual(['Bash'])
    },
  )

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

describe('sending the answer', () => {
  test('the gate is already lifted when the answer is sent', async ($, on) => {
    const world = setup(on)
    await start($)
    await assign($, LOGIN)
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await pane.press({ key: 'accept' })
    await pane.input({ key: 'message', text: '' })
    await pane.unmount()
    expect(world.armedAtSubmit).toEqual([false])
  })

  test('a dropped answer brings the task back with its gate', async ($, on) => {
    const world = setup(on)
    world.dropSubmit = { task: 1, reason: 'a hook refused it' }
    await start($)
    await assign($, LOGIN)
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await pane.press({ key: 'reject' })
    await pane.input({ key: 'message', text: '' })

    expect(world.toasts).toContain(
      'htl: the answer to task #1 was not sent. Answer again in /htl.',
    )
    expect(world.toasts).not.toContain('htl: task #1 rejected')
    expect(world.logs).toContain(
      'htl: the answer to task #1 was not sent: a hook refused it',
    )
    expect(
      await pane.find({ type: 'Text', text: '#1 · NOW · 1 of 1' }),
    ).toBeDefined()
    expect((await runHtl($)).text).toBeUndefined()
    expect(await bash($)).toEqual({
      deny: 'Waiting for the user to finish HTL task #1 "Log in to the GitHub CLI". End your turn now.',
    })

    world.dropSubmit = undefined
    await pane.press({ key: 'accept' })
    await pane.input({ key: 'message', text: '' })
    await pane.unmount()
    expect(world.toasts.at(-1)).toBe('htl: task #1 accepted')
    expect(await assign($, LOGIN)).toMatchObject({
      result: expect.stringContaining('Assigned as task #2 (now).'),
    })
  })

  test('a prompt typed while the answer is on its way keeps the gate lifted', async ($, on) => {
    const world = setup(on)
    world.dropSubmit = { task: 1, reason: 'a hook refused it' }
    const hold = latch()
    world.holdSubmit = hold.done
    await start($)
    await assign($, LOGIN)
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await pane.press({ key: 'accept' })
    const arrived = latch()
    world.arrivals.push(arrived.open)
    const sending = pane.input({ key: 'message', text: '' })
    await arrived.done
    await type($, 'any news?')
    hold.open()
    await sending

    expect(
      await pane.find({ type: 'Text', text: '#1 · NOW · 1 of 1' }),
    ).toBeDefined()
    await pane.unmount()
    expect(await bash($)).toMatchObject({ result: 'ran' })
  })

  test('a dropped answer stays without its gate while a second answer is on its way', async ($, on) => {
    const world = setup(on)
    world.dropSubmit = { task: 1, reason: 'a hook refused it' }
    const hold = latch()
    world.holdSubmit = hold.done
    await start($)
    await assign($, LOGIN)
    await assign($, DNS)
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

    await pane.press({ key: 'reject' })
    const firstArrived = latch()
    world.arrivals.push(firstArrived.open)
    const first = pane.input({ key: 'message', text: '' })
    await firstArrived.done
    await pane.press({ key: 'accept' })
    const secondArrived = latch()
    world.arrivals.push(secondArrived.open)
    const second = pane.input({ key: 'message', text: '' })
    await secondArrived.done
    hold.open()
    await Promise.all([first, second])

    expect(world.toasts).toContain(
      'htl: the answer to task #1 was not sent. Answer again in /htl.',
    )
    expect(world.toasts).toContain('htl: task #2 accepted')
    expect(
      await pane.find({ type: 'Text', text: '#1 · NOW · 1 of 1' }),
    ).toBeDefined()
    await pane.unmount()
    expect(await bash($)).toMatchObject({ result: 'ran' })
  })

  test('an answer on its way stalls neither assign_task nor the pane', async ($, on) => {
    const world = setup(on)
    const hold = latch()
    world.holdSubmit = hold.done
    await start($)
    for (const n of [1, 2, 3]) {
      await assign($, { ...DNS, title: `job ${String(n)}` })
    }
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await pane.press({ key: 'accept' })
    const arrived = latch()
    world.arrivals.push(arrived.open)
    const sending = pane.input({ key: 'message', text: '' })
    await arrived.done

    expect(await assign($, { ...DNS, title: 'job 4' })).toMatchObject({
      result: expect.stringContaining('Assigned as task #4 (parallel).'),
    })
    await pane.press({ key: 'next' })
    expect(
      await pane.find({ type: 'Text', text: '#3 · PARALLEL · 2 of 3' }),
    ).toBeDefined()
    hold.open()
    await sending
    await pane.unmount()
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

describe('/htl from a phone or claude.ai', () => {
  const BRIDGE = { kind: 'bridge' } as const
  const USAGE =
    'Answer a task with /htl accept, /htl reject or /htl handback ("you can do this") and its number, then an optional message: /htl accept 1 done with my work account.'

  test('a remote /htl lists the open tasks as text, and still opens the pane here', async ($, on) => {
    const world = setup(on)
    await start($)
    await assign($, LOGIN)
    await assign($, DNS)
    expect(await runHtl($, '', BRIDGE)).toEqual({
      text: [
        'Open HTL tasks:',
        '#1 · NOW · Log in to the GitHub CLI\nlogin: The login needs a browser and a 2FA code.\nRun `! gh auth login` and finish the browser login.',
        '#2 · PARALLEL · Point the CNAME at x.vercel.app\nno access: I have no access to the registrar.\nAt your registrar, set `www` CNAME to `x.vercel.app`.',
        USAGE,
      ].join('\n\n'),
    })
    expect(world.opened.at(-1)?.closeOnEscape).toBe(true)
  })

  test('a remote /htl still lists the tasks when the pane cannot open', async ($, on) => {
    const world = setup(on)
    world.isOpenRefused = true
    await start($)
    await assign($, LOGIN)
    expect((await runHtl($, '', BRIDGE)).text).toContain(
      '#1 · NOW · Log in to the GitHub CLI',
    )
  })

  test('/htl typed on this machine answers with the pane only', async ($, on) => {
    const world = setup(on)
    await start($)
    await assign($, LOGIN)
    expect((await runHtl($)).text).toBeUndefined()
    expect(world.opened.at(-1)?.closeOnEscape).toBe(true)
  })

  test('/htl accept with a message answers the task like the pane', async ($, on) => {
    const world = setup(on)
    await start($)
    await assign($, LOGIN)
    const arrived = latch()
    world.arrivals.push(arrived.open)
    expect(await runHtl($, 'Accept #1 used my work account', BRIDGE)).toEqual({
      text: 'Sending your answer to task #1 "Log in to the GitHub CLI": accepted. If /htl still lists the task, it was not sent.',
    })
    expect(world.submitted).toEqual([])
    await world.clock.advance(100)
    await arrived.done
    expect(world.submitted.at(-1)).toEqual({
      text: 'HTL task #1 "Log in to the GitHub CLI": accepted, I did it.\nMy message: used my work account\nCheck it worked (run `gh auth status` or re-run what failed), then continue.',
      context: [],
      origin: { kind: 'plugin', name: 'htl', asUser: true },
    })
    expect(await runHtl($, '', BRIDGE)).toEqual({ text: 'No open HTL tasks.' })
    expect(await bash($)).toMatchObject({ result: 'ran' })
  })

  test('a task rejected by command is refused when assigned again', async ($, on) => {
    const world = setup(on)
    await start($)
    await assign($, LOGIN)
    await assign($, DNS)
    const arrived = latch()
    world.arrivals.push(arrived.open)
    await runHtl($, 'reject 2', BRIDGE)
    await world.clock.advance(100)
    await arrived.done
    expect(world.submitted.at(-1)?.text).toBe(
      "HTL task #2 \"Point the CNAME at x.vercel.app\": rejected, I won't do it.\nDon't assume it's done. Find another way, or tell me what stays blocked.",
    )
    expect(await assign($, DNS)).toMatchObject({
      result: expect.stringContaining('The user already rejected task #2'),
    })
  })

  test('a second answer to the same task is not sent', async ($, on) => {
    const world = setup(on)
    await start($)
    await assign($, LOGIN)
    await runHtl($, 'accept 1', BRIDGE)
    expect(await runHtl($, 'reject 1 changed my mind', BRIDGE)).toEqual({
      text: 'No open HTL tasks.',
    })
    const arrived = latch()
    world.arrivals.push(arrived.open)
    await world.clock.advance(100)
    await arrived.done
    expect(world.submitted.map(one => one.text.split('\n')[0])).toEqual([
      'HTL task #1 "Log in to the GitHub CLI": accepted, I did it.',
    ])
  })

  test('an unknown task, a bad command or another mod answers nothing', async ($, on) => {
    const world = setup(on)
    await start($)
    expect(await runHtl($, 'accept 1', BRIDGE)).toEqual({
      text: 'No open HTL tasks.',
    })
    await assign($, LOGIN)
    expect(await runHtl($, 'accept 9', BRIDGE)).toEqual({
      text: 'No open task #9. Open: #1.',
    })
    for (const args of ['done', 'accept', 'accept one', 'maybe 1']) {
      expect(await runHtl($, args, BRIDGE)).toEqual({ text: USAGE })
    }
    expect(
      await runHtl($, 'accept 1', {
        kind: 'plugin',
        name: 'other',
        asUser: true,
      }),
    ).toEqual({
      text: 'Only you can answer an HTL task: type the command yourself, here or through Remote Control.',
    })

    await world.clock.advance(1000)
    expect(world.submitted).toEqual([])
    expect((await runHtl($, '', BRIDGE)).text).toContain(
      '#1 · NOW · Log in to the GitHub CLI',
    )
    expect(await bash($)).toEqual({
      deny: 'Waiting for the user to finish HTL task #1 "Log in to the GitHub CLI". End your turn now.',
    })
  })

  test('an answer by command that is dropped lists the task again', async ($, on) => {
    const world = setup(on)
    world.dropSubmit = { task: 1, reason: 'a hook refused it' }
    await start($)
    await assign($, LOGIN)
    const toasted = latch()
    world.toasted.push(toasted.open)
    await runHtl($, 'reject 1', BRIDGE)
    await world.clock.advance(100)
    await toasted.done
    expect(world.logs).toContain(
      'htl: the answer to task #1 was not sent: a hook refused it',
    )
    expect(world.toasts.at(-1)).toBe(
      'htl: the answer to task #1 was not sent. Answer again in /htl.',
    )
    expect((await runHtl($, '', BRIDGE)).text).toContain(
      '#1 · NOW · Log in to the GitHub CLI',
    )
    expect(await bash($)).toEqual({
      deny: 'Waiting for the user to finish HTL task #1 "Log in to the GitHub CLI". End your turn now.',
    })
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
    const world = setup(on)
    await start($)
    expect(
      await assign($, {
        ...LOGIN,
        blocker: 'secret',
        tried: 'Looked in .env.',
      }),
    ).toMatchObject({
      result: expect.stringContaining(
        'The 1Password CLI is installed, so check 1Password first.',
      ),
    })
    expect(world.probes).toHaveLength(1)
  })

  test('a copy reloaded in an SDK host gets no attach, and still asks for 1Password first', async ($, on) => {
    const world = setup(on)
    await start($, false)
    expect(
      await assign($, {
        ...LOGIN,
        blocker: 'secret',
        tried: 'Looked in .env.',
      }),
    ).toMatchObject({
      result: expect.stringContaining(
        'The 1Password CLI is installed, so check 1Password first.',
      ),
    })
    expect(world.probes).toEqual([['op', '--version']])
  })

  test('an op --version that did not run counts as no 1Password for the whole session, like the rules Claude got', async ($, on) => {
    const world = setup(on)
    world.opExitCode = undefined
    await start($)
    expect(world.tools[0]?.description).not.toContain('1Password')
    expect(world.logs.join('\n')).toContain(
      'htl: op --version failed, so no 1Password rules',
    )
    world.opExitCode = 0
    expect(
      await assign($, {
        ...LOGIN,
        blocker: 'secret',
        tried: 'Looked in .env.',
      }),
    ).toMatchObject({ result: expect.stringContaining('Assigned as task #1') })
    expect(world.probes).toHaveLength(1)
  })

  test('without op, a secret task needs no 1Password evidence', async ($, on) => {
    const world = setup(on)
    world.opExitCode = undefined
    await start($)
    expect(
      await assign($, {
        ...LOGIN,
        blocker: 'secret',
        tried: 'Looked in .env.',
      }),
    ).toMatchObject({ result: expect.stringContaining('Assigned as task #1') })
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

    test(
      surface === 'terminal'
        ? 'the ctrl+x tab hint shows until the pane has the keys'
        : 'no ctrl+x tab hint: the user clicks the pane',
      async ($, on) => {
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
            text:
              surface === 'terminal'
                ? '#1 · NOW · 1 of 1 · ctrl+x tab to use'
                : /^#1 · NOW · 1 of 1$/,
          }),
        ).toBeDefined()
        await pane.unmount()
      },
    )
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
