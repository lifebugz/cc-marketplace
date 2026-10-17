import type {
  ModelCompleteResult,
  On,
  ProcessRunResult,
  PromptDecoration,
  PromptSubmitInput,
} from 'claude-code'
import {
  describe,
  expect,
  mock,
  test,
  type Engine,
  type MockClock,
} from 'claude-code/testing'

const PLUGIN = 'typofix'
const SURFACES = ['terminal', 'desktop'] as const
const BAND = {
  plugin: PLUGIN,
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 11 },
    view: {},
  },
} as const

const TYPED = {
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const

const typed = (text: string): PromptSubmitInput => ({
  origin: TYPED.origin,
  wait: false,
  text,
})
const DROPPED = 'a hook below dropped it'

const USAGE = {
  input_tokens: 120,
  output_tokens: 60,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}
const REWRITES = [
  'He goes to the store.',
  'He is going to the store.',
  'He goes shopping.',
]
const ANSWER: ModelCompleteResult = {
  isAnswered: true,
  text: JSON.stringify({ rewrites: REWRITES }),
  usage: USAGE,
}

type Process = (
  argv: readonly string[],
  stdin: string,
) => ProcessRunResult | 'missing' | 'slow-missing' | 'timeout' | 'aborted'

interface MacIssue {
  readonly word: string
  readonly choices: readonly string[]
  readonly kind?: 'spelling' | 'grammar'
}

interface Guess {
  readonly language: string
  readonly confidence: number
}

interface SubmitHold {
  readonly reached: Promise<void>
  readonly release: () => void
  readonly wait: () => Promise<void>
}

interface World {
  clock: MockClock
  draft: string
  cursor: number | undefined
  settingsReads: number
  keybindings: string | undefined
  argvs: (readonly string[])[]
  repaints: PromptDecoration[][]
  filled: string[]
  isFillRefused: boolean
  toasts: string[]
  stdins: string[]
  programs: string[]
  reads: number
  replies: (ModelCompleteResult | 'refused')[]
  saved: Map<string, unknown>
  isSubmitDropped: boolean
  submitHold: SubmitHold | undefined
}

function holdSubmit(): SubmitHold {
  const gate: { reach?: () => void; open?: () => void } = {}
  const reached = new Promise<void>(resolve => {
    gate.reach = resolve
  })
  const released = new Promise<void>(resolve => {
    gate.open = resolve
  })
  return {
    reached,
    release: () => gate.open?.(),
    wait: async (): Promise<void> => {
      gate.reach?.()
      await released
    },
  }
}

const ran = (stdout: string, exitCode = 0): ProcessRunResult => ({
  exitCode,
  stdout,
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

const macReads =
  (guess: Guess | undefined, ...issues: readonly MacIssue[]): Process =>
  (argv, stdin) =>
    argv[0] !== 'osascript'
      ? 'missing'
      : ran(
          JSON.stringify({
            ...guess,
            issues: issues.map(({ word, choices, kind = 'spelling' }) => {
              const start = stdin.indexOf(word)
              return { start, end: start + word.length, kind, choices }
            }),
          }),
        )

const macFinds = (...issues: readonly MacIssue[]): Process =>
  macReads(undefined, ...issues)

function setup(
  on: On,
  process: Process,
  draft: string,
  retype?: { readonly atRead: number; readonly draft: string },
): World {
  const world: World = {
    clock: mock.clock(on),
    draft,
    cursor: undefined,
    settingsReads: 0,
    keybindings: undefined,
    argvs: [],
    repaints: [],
    filled: [],
    isFillRefused: false,
    toasts: [],
    stdins: [],
    programs: [],
    reads: 0,
    replies: [ANSWER],
    saved: new Map(),
    isSubmitDropped: false,
    submitHold: undefined,
  }

  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('settings.read', () => {
    world.settingsReads += 1
    return { value: {} }
  })
  mock.env(on, { HOME: '/home/someone' })
  on('fs.read', (_$, e) =>
    world.keybindings !== undefined &&
    e.path === '/home/someone/.claude/keybindings.json'
      ? { value: world.keybindings }
      : { deny: `ENOENT: ${e.path}` },
  )
  on('prompt.read', () => {
    world.reads += 1
    if (world.reads === retype?.atRead) {
      world.draft = retype.draft
    }
    return {
      value: { text: world.draft, cursor: world.cursor ?? world.draft.length },
    }
  })
  on('prompt.fill', (_$, e) => {
    if (world.isFillRefused) {
      return { isFilled: false }
    }
    if (e.text === world.draft) {
      world.repaints.push([...(e.decorations ?? [])])
    } else {
      world.filled.push(e.text)
    }
    world.draft = e.text
    return { isFilled: true }
  })
  on('prompt.submit', async (_$, e) => {
    await world.submitHold?.wait()
    return world.isSubmitDropped ? { drop: DROPPED } : { text: e.text }
  })
  on('process.run', async (_$, e) => {
    const program = e.argv[0] ?? ''
    world.programs.push(program)
    world.argvs.push(e.argv)
    world.stdins.push(e.init?.stdin ?? '')
    const result = process(e.argv, e.init?.stdin ?? '')
    if (result === 'timeout') {
      await world.clock.sleep(e.init?.timeoutMs ?? 30000)
      return { deny: `${program}: still running at the timeout` }
    }
    if (result === 'slow-missing') {
      await world.clock.sleep(100)
      return { deny: `${program}: not found` }
    }
    if (result === 'aborted') {
      return { deny: `${program}: aborted` }
    }
    return result === 'missing'
      ? { deny: `${program}: not found` }
      : { value: result }
  })
  on('model.complete', () => {
    const reply = world.replies.shift() ?? ANSWER
    return reply === 'refused'
      ? { deny: 'the haiku model is blocked' }
      : { value: reply }
  })
  on('store.get', (_$, e) => ({ value: world.saved.get(e.key) }))
  on('store.set', (_$, e) => {
    world.saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', () => ({
    type: 'Text',
    props: {},
    children: ['drawn by Claude Code'],
  }))
  return world
}

async function startAndCheck(
  $: Engine,
  world: { readonly clock: MockClock },
): Promise<void> {
  await $.session.start({
    cwd: '/work',
    surface: 'terminal',
    isInteractive: true,
  })
  await world.clock.advance(400)
}

describe('live spelling', () => {
  test('teh gets 3 fixes on every surface, and pressing the second fills the draft with tech', async ($, on) => {
    const world = setup(
      on,
      macFinds({ word: 'teh', choices: ['the', 'tech', 'tea'] }),
      'Create a mod that check teh typos',
    )
    await startAndCheck($, world)

    for (const surface of SURFACES) {
      const band = await $.ui.mount({ ...BAND, surface })
      expect(await band.find({ type: 'Text', text: /^teh$/ })).toBeDefined()
      expect(await band.find({ key: 'fix-1-1' })).toMatchObject({
        text: 'the',
      })
      expect(await band.find({ key: 'fix-1-2' })).toMatchObject({
        text: 'tech',
      })
      expect(await band.find({ key: 'fix-1-3' })).toMatchObject({
        text: 'tea',
      })
      await band.unmount()
    }

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'fix-1-2' })
    expect(world.filled).toEqual(['Create a mod that check tech typos'])
    expect(await band.find({ key: 'fix-1-1' })).toBeUndefined()
  })

  test('the band lists every typo, and the second one is fixed without touching the first', async ($, on) => {
    const world = setup(
      on,
      macFinds(
        { word: 'teh', choices: ['the', 'tech'] },
        { word: 'wiht', choices: ['with', 'whit'] },
        { word: 'has', choices: ['have'], kind: 'grammar' },
      ),
      'I has a fix for teh bug wiht tests',
    )
    await startAndCheck($, world)

    for (const surface of SURFACES) {
      const band = await $.ui.mount({ ...BAND, surface })
      expect(await band.find({ type: 'Text', text: /3 typos/ })).toBeDefined()
      expect(await band.find({ key: 'fix-1-1' })).toMatchObject({
        text: 'have',
      })
      expect(await band.find({ key: 'ignore-1' })).toBeUndefined()
      expect(await band.find({ key: 'fix-2-2' })).toMatchObject({
        text: 'tech',
      })
      expect(await band.find({ key: 'fix-3-1' })).toMatchObject({
        text: 'with',
      })
      expect(await band.find({ key: 'ignore-3' })).toBeDefined()
      await band.unmount()
    }

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'fix-3-1' })
    expect(world.filled).toEqual(['I has a fix for teh bug with tests'])
    expect(await band.find({ type: 'Text', text: /2 typos/ })).toBeDefined()
    expect(await band.find({ key: 'fix-2-1' })).toMatchObject({ text: 'the' })
  })

  test('code, paths, links and backtick text are blanked in what the checker reads', async ($, on) => {
    const draft = 'Fix teh `bun tset` in ./src/a.ts and https://x.io/teh now'
    const world = setup(on, macFinds(), draft)
    await startAndCheck($, world)

    const [sent] = world.stdins
    expect(sent).toHaveLength(draft.length)
    expect(sent).toStartWith('Fix teh ')
    expect(sent).toEndWith(' now')
    for (const hidden of ['tset', './src', 'https']) {
      expect(sent?.includes(hidden), hidden).toBe(false)
    }
  })

  test('falls back to enchant-2 when osascript cannot start, at the right string index', async ($, on) => {
    const enchant: Process = argv =>
      argv[0] === 'enchant-2'
        ? ran('@(#) International Ispell Version 3.2.06\n& teh 1 13: the\n\n')
        : 'missing'
    const world = setup(on, enchant, 'café über teh')
    world.cursor = 0
    await startAndCheck($, world)

    expect(world.programs).toEqual(['osascript', 'osascript', 'enchant-2'])
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'fix-1-1' })
    expect(world.filled).toEqual(['café über the'])
  })

  test('with no spell checker it toasts once and the band still offers Rephrase', async ($, on) => {
    const world = setup(on, () => 'missing', 'He go to store')
    await startAndCheck($, world)
    await startAndCheck($, world)

    expect(world.programs).toEqual([
      'osascript',
      'osascript',
      'enchant-2',
      'enchant-2',
      'hunspell',
      'hunspell',
    ])
    expect(world.toasts).toEqual([
      'no spell checker found (Linux: install enchant-2 or hunspell). /rephrase still works.',
    ])
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ key: 'rephrase' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /no typos/ })).toBeUndefined()
  })

  test('two first checks that overlap with no spell checker give up together', async ($, on) => {
    const world = setup(on, () => 'slow-missing', 'He go to store')
    const start = {
      cwd: '/work',
      surface: 'terminal',
      isInteractive: true,
    } as const
    await $.session.start(start)
    await world.clock.advance(450)
    await $.session.start(start)
    await world.clock.advance(2000)

    expect(world.toasts).toEqual([
      'no spell checker found (Linux: install enchant-2 or hunspell). /rephrase still works.',
    ])
    const before = world.programs.length
    await startAndCheck($, world)
    await world.clock.advance(1000)
    expect(world.programs.slice(before)).toEqual([])
  })

  test('a warning from the macOS script toasts once, without its typofix: mark', async ($, on) => {
    const warning =
      'macOS has no spelling dictionary for "xx", so it detects the language instead'
    const warns: Process = argv =>
      argv[0] === 'osascript'
        ? { ...ran('{"issues":[]}'), stderr: `typofix: ${warning}\n` }
        : 'missing'
    const world = setup(on, warns, 'fix the bug with tests')
    await startAndCheck($, world)
    await startAndCheck($, world)

    expect(world.toasts).toEqual([warning])
  })

  test('the band says no typos once a check finished and found none', async ($, on) => {
    const world = setup(on, macFinds(), 'fix the bug with tests')
    await startAndCheck($, world)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /no typos/ })).toBeDefined()
  })

  test('the band claims nothing while no check has finished for the draft', async ($, on) => {
    const world = setup(on, macFinds(), 'fix teh bug now', {
      atRead: 2,
      draft: 'fix teh bug now ok',
    })
    await startAndCheck($, world)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /no typos/ })).toBeUndefined()
    expect(
      await band.find({ type: 'Text', text: 'drawn by Claude Code' }),
    ).toBeDefined()
  })

  test('a result for a draft that changed meanwhile is thrown away', async ($, on) => {
    const world = setup(
      on,
      macFinds({ word: 'teh', choices: ['the'] }),
      'fix teh typo',
      { atRead: 2, draft: 'fix teh typo now' },
    )
    await startAndCheck($, world)

    expect(world.programs).toEqual(['osascript', 'hunspell', 'hunspell'])
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ key: 'fix-1-1' })).toBeUndefined()
  })

  test('a band fix after the draft changed behind the mod fills nothing, and the next check lists the new draft', async ($, on) => {
    const world = setup(
      on,
      macFinds(
        { word: 'teh', choices: ['the'] },
        { word: 'wiht', choices: ['with'] },
      ),
      'fix teh bug now',
    )
    await startAndCheck($, world)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /1 typo\b/ })).toBeDefined()

    world.draft = 'see teh docs wiht care'
    await band.press({ key: 'fix-1-1' })
    expect(world.filled).toEqual([])
    expect(world.toasts).toEqual([
      'that word changed; the next check looks again',
    ])

    await world.clock.advance(400)
    expect(await band.find({ type: 'Text', text: /2 typos/ })).toBeDefined()
    expect(await band.find({ key: 'fix-2-1' })).toMatchObject({ text: 'with' })
  })

  test('a fix the prompt box refuses gives a toast', async ($, on) => {
    const world = setup(
      on,
      macFinds({ word: 'teh', choices: ['the'] }),
      'fix teh bug now',
    )
    await startAndCheck($, world)
    world.isFillRefused = true

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'fix-1-1' })
    expect(world.toasts).toEqual(['the prompt box did not take the fix'])
  })

  test(
    'a first macOS check that times out keeps osascript, with no notice',
    { options: { hunspell: '' } },
    async ($, on) => {
      let runs = 0
      const slowFirst: Process = (argv, stdin) => {
        runs += 1
        return runs === 1
          ? 'timeout'
          : macFinds({ word: 'teh', choices: ['the'] })(argv, stdin)
      }
      const world = setup(on, slowFirst, 'fix teh bug now')
      await startAndCheck($, world)
      await world.clock.advance(5000)

      expect(world.programs).toEqual(['osascript'])
      expect(world.toasts).toEqual([])

      await startAndCheck($, world)
      expect(world.programs).toEqual(['osascript', 'osascript'])
      const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
      expect(await band.find({ key: 'fix-1-1' })).toMatchObject({ text: 'the' })
    },
  )

  test(
    'a first macOS check that Claude Code aborts is tried again and keeps osascript',
    { options: { hunspell: '' } },
    async ($, on) => {
      let runs = 0
      const abortedFirst: Process = (argv, stdin) => {
        runs += 1
        return runs === 1
          ? 'aborted'
          : macFinds({ word: 'teh', choices: ['the'] })(argv, stdin)
      }
      const world = setup(on, abortedFirst, 'fix teh bug now')
      await startAndCheck($, world)

      expect(world.programs).toEqual(['osascript', 'osascript'])
      expect(world.toasts).toEqual([])
      const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
      expect(await band.find({ key: 'fix-1-1' })).toMatchObject({ text: 'the' })

      await startAndCheck($, world)
      expect(world.programs).toEqual(['osascript', 'osascript', 'osascript'])
    },
  )

  test(
    'a later check that Claude Code aborts is tried again and lists the new typo',
    { options: { hunspell: '' } },
    async ($, on) => {
      let runs = 0
      const abortedSecond: Process = (argv, stdin) => {
        runs += 1
        return runs === 2
          ? 'aborted'
          : macFinds(
              { word: 'teh', choices: ['the'] },
              { word: 'wiht', choices: ['with'] },
            )(argv, stdin)
      }
      const world = setup(on, abortedSecond, 'fix teh bug')
      await startAndCheck($, world)
      world.draft = 'fix teh bug wiht now'
      await startAndCheck($, world)

      expect(world.programs).toEqual(['osascript', 'osascript', 'osascript'])
      const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
      expect(await band.find({ type: 'Text', text: /2 typos/ })).toBeDefined()
    },
  )

  test('ignore keeps a word out of later checks', async ($, on) => {
    const world = setup(
      on,
      macFinds({ word: 'Tovan', choices: ['Total'] }),
      'ask Tovan about it',
    )
    await startAndCheck($, world)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'ignore-1' })
    expect(world.saved.get('ignored')).toEqual(['tovan'])
    expect(await band.find({ key: 'fix-1-1' })).toBeUndefined()

    await startAndCheck($, world)
    expect(await band.find({ key: 'fix-1-1' })).toBeUndefined()
  })
})

describe('hunspell and the shortcut', () => {
  const macAndHunspell =
    (guess?: Guess): Process =>
    (argv, stdin) =>
      argv[0] === 'hunspell'
        ? ran(
            '@(#) Hunspell\n& whaat 2 1: what, wheat\n*\n& youu 3 10: you, your\n*\n\n',
          )
        : macReads(guess, { word: 'youu', choices: ['you', 'your', 'yous'] })(
            argv,
            stdin,
          )

  test('by default hunspell en_US adds whaat, macOS keeps youu, and Claude Code settings are never read', async ($, on) => {
    const world = setup(on, macAndHunspell(), 'whaat do youu think')
    await startAndCheck($, world)

    expect(world.settingsReads).toBe(0)
    expect(world.argvs).toContainEqual([
      'hunspell',
      '-a',
      '-i',
      'utf-8',
      '-d',
      'en_US',
    ])
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /2 typos/ })).toBeDefined()
    expect(await band.find({ key: 'fix-1-1' })).toMatchObject({ text: 'what' })
    expect(await band.find({ key: 'fix-1-2' })).toMatchObject({
      text: 'wheat',
    })
    expect(await band.find({ key: 'fix-2-3' })).toMatchObject({ text: 'yous' })
  })

  test(
    'the hunspell option picks the dictionary',
    { options: { hunspell: 'en_GB' } },
    async ($, on) => {
      const world = setup(on, macAndHunspell(), 'whaat do youu think')
      await startAndCheck($, world)

      expect(world.argvs).toContainEqual([
        'hunspell',
        '-a',
        '-i',
        'utf-8',
        '-d',
        'en_GB',
      ])
    },
  )

  test(
    'an empty hunspell option means macOS alone',
    { options: { hunspell: '' } },
    async ($, on) => {
      const world = setup(on, macAndHunspell(), 'whaat do youu think')
      await startAndCheck($, world)

      expect(world.programs).toEqual(['osascript'])
    },
  )

  test(
    'a language option other than the dictionary language leaves hunspell out',
    { options: { language: 'de' } },
    async ($, on) => {
      const world = setup(on, macAndHunspell(), 'whaat do youu think')
      await startAndCheck($, world)

      expect(world.programs).toEqual(['osascript'])
      expect(world.argvs[0]?.at(-1)).toBe('de')
    },
  )

  test('a draft macOS surely reads as German leaves hunspell en_US out', async ($, on) => {
    const world = setup(
      on,
      macAndHunspell({ language: 'de', confidence: 0.99 }),
      'whaat do youu think',
    )
    await startAndCheck($, world)

    expect(world.programs).toEqual(['osascript'])
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /1 typo\b/ })).toBeDefined()
  })

  test('an unsure guess keeps hunspell, so short English drafts stay covered', async ($, on) => {
    const world = setup(
      on,
      macAndHunspell({ language: 'id', confidence: 0.51 }),
      'whaat do youu think',
    )
    await startAndCheck($, world)

    expect(world.programs).toEqual(['osascript', 'hunspell'])
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /2 typos/ })).toBeDefined()
  })

  test('an aborted hunspell run is tried again, so hunspell stays on', async ($, on) => {
    let hunspellRuns = 0
    const abortedHunspell: Process = (argv, stdin) => {
      if (argv[0] === 'hunspell') {
        hunspellRuns += 1
        if (hunspellRuns === 1) {
          return 'aborted'
        }
      }
      return macAndHunspell()(argv, stdin)
    }
    const world = setup(on, abortedHunspell, 'whaat do youu think')
    await startAndCheck($, world)
    await startAndCheck($, world)

    expect(world.programs).toEqual([
      'osascript',
      'hunspell',
      'hunspell',
      'osascript',
      'hunspell',
    ])
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /2 typos/ })).toBeDefined()
  })

  test('a missing dictionary turns hunspell off quietly; macOS still checks', async ($, on) => {
    const noDictionary: Process = (argv, stdin) =>
      argv[0] === 'hunspell'
        ? ran('', 1)
        : macFinds({ word: 'youu', choices: ['you'] })(argv, stdin)
    const world = setup(on, noDictionary, 'whaat do youu think')
    world.cursor = 0
    await startAndCheck($, world)
    await startAndCheck($, world)

    expect(world.programs).toEqual(['osascript', 'hunspell', 'osascript'])
    expect(world.toasts).toEqual([])
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ key: 'fix-1-1' })).toMatchObject({ text: 'you' })
  })

  test('each fix gets its own letter, and the header names your shortcut', async ($, on) => {
    const world = setup(
      on,
      macFinds(
        { word: 'teh', choices: ['the', 'tech'] },
        { word: 'wiht', choices: ['with'] },
      ),
      'fix teh bug wiht tests',
    )
    world.keybindings = JSON.stringify({
      bindings: [
        { context: 'Chat', bindings: { 'ctrl+space': 'abovePrompt:focus' } },
      ],
    })
    await startAndCheck($, world)

    for (const surface of SURFACES) {
      const band = await $.ui.mount({ ...BAND, surface })
      expect(
        await band.find({ type: 'Text', text: /ctrl\+space, then a letter/ }),
      ).toBeDefined()
      expect((await band.find({ key: 'fix-1-1' }))?.props['hotkey']).toBe('a')
      expect((await band.find({ key: 'fix-1-2' }))?.props['hotkey']).toBe('b')
      expect((await band.find({ key: 'fix-2-1' }))?.props['hotkey']).toBe('c')
      await band.unmount()
    }
  })

  test('with no keybindings file, the header names ctrl+x tab', async ($, on) => {
    const world = setup(
      on,
      macFinds({ word: 'teh', choices: ['the'] }),
      'fix teh bug now',
    )
    await startAndCheck($, world)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(
      await band.find({ type: 'Text', text: /ctrl\+x tab, then a letter/ }),
    ).toBeDefined()
  })

  test('the band steps aside while the cursor is right after a typo', async ($, on) => {
    const world = setup(
      on,
      macFinds({ word: 'wiht', choices: ['with'] }),
      'fix the bug wiht',
    )
    await startAndCheck($, world)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ key: 'fix-1-1' })).toBeUndefined()
    expect(
      await band.find({ type: 'Text', text: 'drawn by Claude Code' }),
    ).toBeDefined()
  })

  test('the band lists the typo when the cursor is somewhere else', async ($, on) => {
    const world = setup(
      on,
      macFinds({ word: 'wiht', choices: ['with'] }),
      'fix the bug wiht',
    )
    world.cursor = 3
    await startAndCheck($, world)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ key: 'fix-1-1' })).toMatchObject({ text: 'with' })
  })
})

describe('marking the word', () => {
  const twoTypos = (): Process =>
    macFinds(
      { word: 'teh', choices: ['the'] },
      { word: 'wiht', choices: ['with'] },
    )

  test('a typo found after you stop typing is marked at once, the one at the cursor in bold', async ($, on) => {
    const world = setup(on, twoTypos(), 'fix teh bug wiht')
    await startAndCheck($, world)

    expect(world.filled).toEqual([])
    expect(world.repaints).toEqual([
      [
        { start: 4, end: 7, underline: true, color: 'error' },
        { start: 12, end: 16, underline: true, color: 'error', bold: true },
      ],
    ])
  })

  test('no repaint while the cursor is inside the draft, so it never moves', async ($, on) => {
    const world = setup(on, twoTypos(), 'fix teh bug wiht')
    world.cursor = 3
    await startAndCheck($, world)

    expect(world.repaints).toEqual([])
  })

  test('no repaint when the check found nothing', async ($, on) => {
    const world = setup(on, macFinds(), 'fix the bug with')
    await startAndCheck($, world)

    expect(world.repaints).toEqual([])
  })

  test('ignore takes the underline off that word at once and keeps the other', async ($, on) => {
    const world = setup(on, twoTypos(), 'teh bug wiht now')
    await startAndCheck($, world)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'ignore-1' })

    expect(world.filled).toEqual([])
    expect(world.repaints).toEqual([
      [
        { start: 0, end: 3, underline: true, color: 'error' },
        { start: 8, end: 12, underline: true, color: 'error' },
      ],
      [{ start: 8, end: 12, underline: true, color: 'error' }],
    ])
  })

  test('no repaint when the draft changed during the check', async ($, on) => {
    const world = setup(on, twoTypos(), 'fix teh bug wiht', {
      atRead: 3,
      draft: 'fix teh bug wiht now',
    })
    await startAndCheck($, world)

    expect(world.repaints).toEqual([])
    expect(world.filled).toEqual([])
  })
})

describe('rephrase', () => {
  test('r shows 3 rewrites, and 1 fills the first', async ($, on) => {
    const world = setup(on, macFinds(), 'He go to the store')
    await startAndCheck($, world)

    for (const surface of SURFACES) {
      const band = await $.ui.mount({ ...BAND, surface })
      await band.press({ key: 'rephrase' })
      for (const [i, rewrite] of REWRITES.entries()) {
        expect(
          (await band.find({ key: `rewrite-${String(i + 1)}` }))?.text,
        ).toContain(rewrite)
      }
      await band.press({ key: 'cancel' })
      await band.unmount()
    }

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'rephrase' })
    await band.press({ key: 'rewrite-1' })
    expect(world.filled).toEqual([REWRITES[0]])
    expect(await band.find({ key: 'rewrite-1' })).toBeUndefined()
  })

  test('a malformed reply shows the failure', async ($, on) => {
    const world = setup(on, macFinds(), 'He go to the store')
    world.replies = [
      { isAnswered: true, text: 'Sure! Here you go.', usage: USAGE },
    ]
    await startAndCheck($, world)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'rephrase' })
    expect(
      await band.find({
        type: 'Text',
        text: 'Haiku did not answer with 3 rewrites',
      }),
    ).toBeDefined()
  })

  test('a failed model call shows why, and Try again rephrases', async ($, on) => {
    const world = setup(on, macFinds(), 'He go to the store')
    world.replies = [
      {
        isAnswered: false,
        reason: 'api-error',
        status: 529,
        error: 'overloaded',
        usage: { ...USAGE, input_tokens: 0, output_tokens: 0 },
      },
    ]
    await startAndCheck($, world)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'rephrase' })
    expect(
      await band.find({ type: 'Text', text: 'Haiku failed (overloaded)' }),
    ).toBeDefined()

    await band.press({ key: 'rephrase' })
    expect(await band.find({ key: 'rewrite-1' })).toBeDefined()
  })

  test('a model call Claude Code refuses to send shows why, in the band and in /rephrase', async ($, on) => {
    const world = setup(on, macFinds(), 'He go to the store')
    world.replies = ['refused', 'refused']
    await startAndCheck($, world)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'rephrase' })
    expect(
      await band.find({
        type: 'Text',
        text: /^Haiku could not run \(the haiku model is blocked\)$/,
      }),
    ).toBeDefined()
    expect(await band.find({ key: 'cancel' })).toMatchObject({ text: 'Close' })

    const answer = await $.command.run({
      ...TYPED,
      command: 'rephrase',
      args: 'He go to store',
    })
    expect(answer.text).toBe('Haiku could not run (the haiku model is blocked)')
  })

  test('a draft that changed before the pick gives a toast and no fill', async ($, on) => {
    const world = setup(on, macFinds(), 'He go to the store')
    await startAndCheck($, world)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'rephrase' })
    world.draft = 'He go to the store today'
    await band.press({ key: 'rewrite-2' })
    expect(world.filled).toEqual([])
    expect(world.toasts).toEqual(['the draft changed; press r again'])
  })

  test('a rewrite the prompt box refuses gives a toast', async ($, on) => {
    const world = setup(on, macFinds(), 'He go to the store')
    await startAndCheck($, world)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'rephrase' })
    world.isFillRefused = true
    await band.press({ key: 'rewrite-1' })
    expect(world.toasts).toEqual(['the prompt box did not take the rewrite'])
  })

  test('/rephrase answers with the rewrites as text', async ($, on) => {
    setup(on, macFinds(), '')
    const answer = await $.command.run({
      ...TYPED,
      command: 'rephrase',
      args: 'He go to store',
    })

    expect(answer.text).toBe(
      REWRITES.map(
        (r, i) =>
          `${String(i + 1)} ${['fixed', 'natural', 'short'][i] ?? ''}: ${r}`,
      ).join('\n'),
    )
    expect(
      (await $.command.run({ ...TYPED, command: 'rephrase', args: ' ' })).text,
    ).toBe('usage: /rephrase <text>')
  })
})

test('a prompt that Claude Code submits on its own leaves the typos and an open rephrase alone', async ($, on) => {
  const world = setup(
    on,
    macFinds({ word: 'teh', choices: ['the'] }),
    'fix teh typo',
  )
  await startAndCheck($, world)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const notice = {
    origin: { kind: 'task-notification' },
    wait: false,
    text: 'A background task finished',
  } as const

  await $.prompt.submit(notice)
  expect(await band.find({ key: 'fix-1-1' })).toMatchObject({ text: 'the' })

  await band.press({ key: 'rephrase' })
  await $.prompt.submit(notice)
  expect(await band.find({ key: 'rewrite-1' })).toBeDefined()
})

test('a submitted prompt goes out unchanged and the band clears', async ($, on) => {
  const world = setup(
    on,
    macFinds({ word: 'teh', choices: ['the'] }),
    'fix teh typo',
  )
  await startAndCheck($, world)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'fix-1-1' })).toBeDefined()

  const submitted = await $.prompt.submit({
    origin: TYPED.origin,
    wait: false,
    text: 'fix teh typo',
  })

  expect(submitted).toMatchObject({ text: 'fix teh typo' })
  expect(await band.find({ key: 'fix-1-1' })).toBeUndefined()
  expect(
    await band.find({ type: 'Text', text: 'drawn by Claude Code' }),
  ).toBeDefined()
})

describe('a prompt sent while the box holds another draft', () => {
  const oneTypo = (): Process => macFinds({ word: 'wiht', choices: ['with'] })
  const twoTypos = (): Process =>
    macFinds(
      { word: 'bugg', choices: ['bug'] },
      { word: 'wiht', choices: ['with'] },
    )

  test('a prompt Claude Code sends late goes out unchanged and leaves the typos of the draft in the box', async ($, on) => {
    const world = setup(on, oneTypo(), 'zz wiht now')
    await startAndCheck($, world)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

    const late = await $.prompt.submit(typed('an earlier prompt'))
    expect(late).toMatchObject({ text: 'an earlier prompt' })
    await band.press({ key: 'fix-1-1' })
    expect(world.filled).toEqual(['zz with now'])
  })

  test('a late prompt keeps the check a band fix asked for', async ($, on) => {
    const world = setup(on, twoTypos(), 'fix the bugg wiht care')
    await startAndCheck($, world)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'fix-1-1' })
    const before = world.programs.length

    await $.prompt.submit(typed('an earlier prompt'))
    await world.clock.advance(400)
    expect(world.programs.slice(before)).toEqual(['osascript'])
    expect(await band.find({ type: 'Text', text: /1 typo\b/ })).toBeDefined()
  })

  test('a late prompt keeps an open rephrase', async ($, on) => {
    const world = setup(on, macFinds(), 'He go to the store')
    await startAndCheck($, world)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'rephrase' })

    await $.prompt.submit(typed('an earlier prompt'))
    expect(await band.find({ key: 'rewrite-1' })).toBeDefined()
  })

  test('a late prompt leaves the band, and sending the draft clears it', async ($, on) => {
    const world = setup(on, oneTypo(), 'zz wiht now')
    await startAndCheck($, world)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

    await $.prompt.submit(typed('an earlier prompt'))
    expect(await band.find({ key: 'fix-1-1' })).toBeDefined()
    await $.prompt.submit(typed('zz wiht now'))
    expect(await band.find({ key: 'fix-1-1' })).toBeUndefined()
  })

  test('a prompt sent right after a band fix clears the band and runs no more checks', async ($, on) => {
    const world = setup(on, twoTypos(), 'fix the bugg wiht care')
    await startAndCheck($, world)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'fix-1-1' })
    expect(await band.find({ key: 'fix-1-1' })).toMatchObject({ text: 'with' })
    const before = world.programs.length

    await $.prompt.submit(typed(world.draft))
    expect(await band.find({ key: 'fix-1-1' })).toBeUndefined()
    await world.clock.advance(400)
    expect(world.programs.slice(before)).toEqual([])
  })

  test('a prompt sent right after a rewrite runs no more checks', async ($, on) => {
    const world = setup(on, twoTypos(), 'fix the bugg wiht care')
    await startAndCheck($, world)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'rephrase' })
    await band.press({ key: 'rewrite-1' })
    const before = world.programs.length

    await $.prompt.submit(typed(world.draft))
    await world.clock.advance(400)
    expect(world.programs.slice(before)).toEqual([])
  })

  test('a prompt sent right after an ignore clears the band', async ($, on) => {
    const world = setup(on, twoTypos(), 'fix the bugg wiht care')
    await startAndCheck($, world)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'ignore-1' })
    expect(await band.find({ key: 'fix-1-1' })).toMatchObject({ text: 'with' })

    await $.prompt.submit(typed(world.draft))
    expect(await band.find({ key: 'fix-1-1' })).toBeUndefined()
  })

  test('a late prompt while the box is empty keeps the rewrites of /rephrase', async ($, on) => {
    const world = setup(on, macFinds(), '')
    await startAndCheck($, world)
    await $.command.run({
      ...TYPED,
      command: 'rephrase',
      args: 'He go to the store',
    })
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ key: 'rewrite-1' })).toBeDefined()

    await $.prompt.submit(typed('an earlier prompt'))
    expect(await band.find({ key: 'rewrite-1' })).toBeDefined()
  })

  test('a prompt sent before the first check stops that check', async ($, on) => {
    const world = setup(on, oneTypo(), 'zz wiht now')
    await $.session.start({
      cwd: '/work',
      surface: 'terminal',
      isInteractive: true,
    })

    await $.prompt.submit(typed('zz wiht now'))
    await world.clock.advance(400)
    expect(world.programs).toEqual([])
  })

  test('a hidden band shows the typos of a draft written while the prompt is still being sent', async ($, on) => {
    const world = setup(
      on,
      macFinds(
        { word: 'wiht', choices: ['with'] },
        { word: 'stor', choices: ['store'] },
      ),
      'zz wiht now',
    )
    world.replies = [
      {
        isAnswered: true,
        text: JSON.stringify({
          rewrites: ['He goes to the stor today.', ...REWRITES.slice(1)],
        }),
        usage: USAGE,
      },
    ]
    await startAndCheck($, world)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'hide' })
    expect(await band.find({ key: 'fix-1-1' })).toBeUndefined()

    const hold = holdSubmit()
    world.submitHold = hold
    const sent = $.prompt.submit(typed('zz wiht now'))
    await hold.reached
    world.draft = ''
    await $.command.run({
      ...TYPED,
      command: 'rephrase',
      args: 'He go to the stor today',
    })
    await band.press({ key: 'rewrite-1' })
    await world.clock.advance(400)
    expect(await band.find({ key: 'fix-1-1' })).toMatchObject({
      text: 'store',
    })

    hold.release()
    await sent
    expect(await band.find({ key: 'fix-1-1' })).toMatchObject({
      text: 'store',
    })
  })

  test('a prompt a hook below drops comes back dropped', async ($, on) => {
    const world = setup(on, oneTypo(), 'zz wiht now')
    world.isSubmitDropped = true
    await startAndCheck($, world)

    expect(await $.prompt.submit(typed('zz wiht now'))).toEqual({
      drop: DROPPED,
    })
  })
})
