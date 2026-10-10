import type {
  ModelCompleteResult,
  On,
  ProcessRunResult,
  Register,
} from 'claude-code'
import {
  describe,
  expect,
  mock,
  test,
  type Engine,
  type MockClock,
} from 'claude-code/testing'

import {
  AGENTS,
  agent,
  CLIENTS,
  GHOSTTY,
  HOME,
  PANES,
  PS,
  ran,
  SELF,
} from './fixtures'

const PLUGIN = 'session-tabs'
const PANE_ID = 'session-tabs'
const SURFACES = ['terminal', 'desktop'] as const
const PANE = {
  plugin: PLUGIN,
  component: 'Pane',
  requestId: PANE_ID,
  props: {
    title: 'Sessions',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const
const TYPED = {
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const
const REQUEST = 'Add a CSV export to the billing page'
const USAGE = {
  input_tokens: 80,
  output_tokens: 6,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

interface World {
  clock: MockClock
  agents: unknown[]
  argvs: string[][]
  toasts: string[]
  opened: unknown[]
  missing: Set<string>
  scriptReply: string
  rowWrites: number
  replyAfterMs: number
  reply: ModelCompleteResult
  asked: string[]
}

const named = (text: string): ModelCompleteResult => ({
  isAnswered: true,
  text,
  usage: USAGE,
})

function answer(world: World, argv: readonly string[]): ProcessRunResult {
  if (argv[1] === 'agents') return ran(JSON.stringify(world.agents))
  if (argv[0] === 'ps') return ran(PS)
  if (argv[0] === 'osascript') {
    return argv[4] === 'list-ghostty'
      ? ran(JSON.stringify({ ok: true, terminals: GHOSTTY }))
      : ran(world.scriptReply)
  }
  if (argv[0] === 'tmux' && argv[1] === 'list-panes') return ran(PANES)
  if (argv[0] === 'tmux' && argv[1] === 'list-clients') return ran(CLIENTS)
  return ran('')
}

function setup(on: On): World {
  const world: World = {
    clock: mock.clock(on),
    agents: [...AGENTS],
    argvs: [],
    toasts: [],
    opened: [],
    missing: new Set(),
    scriptReply: '{"ok":true}',
    rowWrites: 0,
    replyAfterMs: 0,
    reply: named('add-billing-csv-export'),
    asked: [],
  }
  mock.store(on)
  mock.env(on, { HOME })
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: SELF }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', (_$, e) => {
    world.opened.push(e)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.close', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', (_$, e) => ({ deny: `ENOENT: ${e.path}` }))
  on('ui.toast', (_$, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('state.set', { plugin: PLUGIN, key: 'rows' }, (_$, e, next) => {
    world.rowWrites += 1
    return next(e)
  })
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    world.argvs.push(argv)
    const program = argv[0] ?? ''
    return world.missing.has(program)
      ? { deny: `${program}: not found` }
      : { value: answer(world, argv) }
  })
  on('model.complete', async (_$, e) => {
    world.asked.push(e.prompt)
    if (world.replyAfterMs > 0) await world.clock.sleep(world.replyAfterMs)
    return { value: world.reply }
  })
  on('classic.UserPromptSubmit', () => ({}))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  return world
}

/**
 * Closes the pane the way the person's close mark does, through `$.ui.close`.
 * An inline plugin runs in an environment of its own: it sees no constant of
 * this file, so the pane id is written out.
 */
const closer: Register = on => {
  on('command.run', { command: 'close-pane' }, async $ => {
    await $.ui.close({ id: 'session-tabs' })
    return {}
  })
}

async function openTabs($: Engine): Promise<void> {
  await $.session.start({
    cwd: '/work',
    surface: 'terminal',
    isInteractive: true,
  })
  await $.command.run({ command: 'tabs', args: '', ...TYPED })
}

function agentRuns(world: World): number {
  return world.argvs.filter(argv => argv[1] === 'agents').length
}

describe('the /tabs pane', () => {
  test('lists every session with its status, folder and tab on each surface', async ($, on) => {
    const world = setup(on)
    await openTabs($)
    expect(world.opened).toEqual([
      { id: PANE_ID, title: 'Sessions', focus: true },
    ])

    for (const surface of SURFACES) {
      const pane = await $.ui.mount({ ...PANE, surface })
      expect(
        await pane.find({
          type: 'Text',
          text: /^Sessions · 1 waiting · 1 busy/,
        }),
      ).toBeDefined()
      const named = await pane.find({ key: 'go-ghostty-named' })
      expect(named?.text).toMatch(/◐ busy +fix-login-timeout +Ghostty tab 2/)
      expect(named?.props['hotkey']).toBe('2')
      expect(
        await pane.find({
          type: 'Text',
          text: /~\/projects\/api · permission prompt/,
        }),
      ).toBeDefined()
      expect(await pane.find({ key: `go-${SELF}` })).toBeUndefined()
      expect(
        await pane.find({ type: 'Text', text: /○ this +session-tabs-mod/ }),
      ).toBeDefined()
      expect(
        await pane.find({
          type: 'Text',
          text: /· bg +nightly-dependency-audit/,
        }),
      ).toBeDefined()
      await pane.unmount()
    }
  })

  test('pressing a row runs that host’s switch and keeps the pane open', async ($, on) => {
    const world = setup(on)
    await openTabs($)
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    world.argvs.length = 0

    await pane.press({ key: 'go-iterm' })
    expect(world.argvs).toEqual([
      [
        'osascript',
        '-l',
        'JavaScript',
        expect.stringMatching(/\/scripts\/terminals\.js$/),
        'focus-iterm',
        'ttys002',
      ],
    ])
    expect(world.toasts).toEqual([])
    expect(await pane.find({ key: 'go-iterm' })).toBeDefined()
  })

  test('an Automation denial shows the permission toast', async ($, on) => {
    const world = setup(on)
    await openTabs($)
    world.scriptReply = '{"error":"Not authorized","number":-1743}'
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await pane.press({ key: 'go-terminal' })
    expect(world.toasts).toHaveLength(1)
    expect(world.toasts[0]).toContain('Privacy & Security → Automation')
  })

  test('a tab the marker finds is remembered and shows its number', async ($, on) => {
    const world = setup(on)
    await openTabs($)
    world.scriptReply = '{"ok":true,"terminalId":"T-docs-b"}'
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await pane.find({ key: 'go-ghostty-unknown' }))?.text).toMatch(
      /Ghostty$/,
    )
    await pane.press({ key: 'go-ghostty-unknown' })
    expect(world.argvs).toContainEqual([
      'osascript',
      '-l',
      'JavaScript',
      expect.stringMatching(/terminals\.js$/),
      'focus-ghostty-tty',
      'ttys010',
    ])
    expect((await pane.find({ key: 'go-ghostty-unknown' }))?.text).toMatch(
      /Ghostty tab 6$/,
    )
  })
})

describe('refreshing', () => {
  test('rows are written only when they change', async ($, on) => {
    const world = setup(on)
    await openTabs($)
    expect(world.rowWrites).toBe(1)
    await world.clock.advance(3000)
    await world.clock.advance(3000)
    expect(agentRuns(world)).toBe(3)
    expect(world.rowWrites).toBe(1)

    world.agents = AGENTS.filter(a => a['sessionId'] !== 'cursor')
    await world.clock.advance(3000)
    expect(world.rowWrites).toBe(2)
  })

  test(
    'closing the pane stops the timer',
    { plugins: [{ name: 'closer', register: closer }] },
    async ($, on) => {
      const world = setup(on)
      await openTabs($)
      await world.clock.advance(3000)
      expect(agentRuns(world)).toBe(2)
      await $.command.run({ command: 'close-pane', args: '', ...TYPED })
      await world.clock.advance(9000)
      expect(agentRuns(world)).toBe(2)
    },
  )

  test('a hotkey stays with its session when the rows re-sort', async ($, on) => {
    const world = setup(on)
    await openTabs($)
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await pane.find({ key: 'go-iterm' }))?.props['hotkey']).toBe('4')

    world.agents = AGENTS.map(a =>
      a['sessionId'] === 'iterm' ? { ...a, status: 'waiting' } : a,
    )
    await world.clock.advance(3000)
    const buttons = await pane.findAll({ type: 'Button' })
    expect(buttons[1]?.key).toBe('go-iterm')
    expect((await pane.find({ key: 'go-iterm' }))?.props['hotkey']).toBe('4')
  })

  test('ps runs only when a session it has not seen appears', async ($, on) => {
    const world = setup(on)
    const psRuns = (): number => world.argvs.filter(a => a[0] === 'ps').length
    await openTabs($)
    await world.clock.advance(3000)
    expect(psRuns()).toBe(1)

    world.agents = [
      ...AGENTS,
      agent({ sessionId: 'late', pid: 7777, cwd: `${HOME}/late` }),
    ]
    await world.clock.advance(3000)
    expect(psRuns()).toBe(2)
    await world.clock.advance(3000)
    expect(psRuns()).toBe(2)
  })

  test('falls back to ~/.local/bin/claude when claude is not on PATH', async ($, on) => {
    const world = setup(on)
    world.missing.add('claude')
    await openTabs($)
    expect(world.argvs.filter(argv => argv[1] === 'agents')).toEqual([
      ['claude', 'agents', '--json'],
      [`${HOME}/.local/bin/claude`, 'agents', '--json'],
    ])
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await pane.find({ key: 'go-iterm' })).toBeDefined()

    await world.clock.advance(3000)
    expect(world.argvs.filter(argv => argv[1] === 'agents').at(-1)?.[0]).toBe(
      `${HOME}/.local/bin/claude`,
    )
  })

  test('when claude cannot run at all the pane says why', async ($, on) => {
    const world = setup(on)
    world.missing.add('claude')
    world.missing.add(`${HOME}/.local/bin/claude`)
    await openTabs($)
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await pane.find({ type: 'Text', text: /did not run/ })).toBeDefined()
  })
})

describe('naming sessions with Haiku', () => {
  test('a first real request gets a name when Haiku answers in time', async ($, on) => {
    const world = setup(on)
    const result = await $.classic.UserPromptSubmit({
      prompt: REQUEST,
      source: 'user',
    })
    expect(result.sessionTitle).toBe('add-billing-csv-export')
    expect(world.asked).toHaveLength(1)
    expect(world.asked[0]).toContain(REQUEST)

    const again = await $.classic.UserPromptSubmit({
      prompt: 'Now add a PDF export as well, please',
      source: 'user',
    })
    expect(again.sessionTitle).toBeUndefined()
    expect(world.asked).toHaveLength(1)
  })

  test('a slow answer is kept and set by the next prompt with no wait', async ($, on) => {
    const world = setup(on)
    world.replyAfterMs = 5000
    const first = $.classic.UserPromptSubmit({
      prompt: REQUEST,
      source: 'user',
    })
    await world.clock.advance(2000)
    expect((await first).sessionTitle).toBeUndefined()

    await world.clock.advance(3000)
    const second = await $.classic.UserPromptSubmit({
      prompt: 'Now add a PDF export as well, please',
      source: 'user',
    })
    expect(second.sessionTitle).toBe('add-billing-csv-export')
    expect(world.asked).toHaveLength(1)
  })

  test('a session that has a title, a command, or a non-person prompt is left alone', async ($, on) => {
    const world = setup(on)
    for (const fields of [
      { prompt: REQUEST, source: 'user', session_title: 'billing' },
      { prompt: '/tabs', source: 'user' },
      { prompt: 'short one', source: 'user' },
      { prompt: REQUEST, source: 'sdk' },
      { prompt: REQUEST, source: 'loop_wakeup' },
    ] as const) {
      const result = await $.classic.UserPromptSubmit(fields)
      expect(result.sessionTitle, JSON.stringify(fields)).toBeUndefined()
    }
    expect(world.asked).toHaveLength(0)
  })

  test('with no source in the payload, a prompt typed in the composer is named', async ($, on) => {
    const world = setup(on)
    await $.prompt.submit({
      text: REQUEST,
      origin: { kind: 'composer' },
      wait: false,
    })
    const result = await $.classic.UserPromptSubmit({ prompt: REQUEST })
    expect(result.sessionTitle).toBe('add-billing-csv-export')
    expect(world.asked).toHaveLength(1)
  })

  test('with no source in the payload, a task notification is not named', async ($, on) => {
    const world = setup(on)
    await $.prompt.submit({
      text: REQUEST,
      origin: { kind: 'task-notification' },
      wait: false,
    })
    const result = await $.classic.UserPromptSubmit({ prompt: REQUEST })
    expect(result.sessionTitle).toBeUndefined()
    expect(world.asked).toHaveLength(0)
  })

  test('a reply that is not a title is dropped', async ($, on) => {
    const world = setup(on)
    world.reply = named('Sure! Here is a good title for it.')
    const result = await $.classic.UserPromptSubmit({
      prompt: REQUEST,
      source: 'user',
    })
    expect(result.sessionTitle).toBeUndefined()
    expect(world.asked).toHaveLength(1)
  })

  test(
    'with autoName off nothing is asked',
    { options: { autoName: false } },
    async ($, on) => {
      const world = setup(on)
      const result = await $.classic.UserPromptSubmit({
        prompt: REQUEST,
        source: 'user',
      })
      expect(result.sessionTitle).toBeUndefined()
      expect(world.asked).toHaveLength(0)
    },
  )
})
