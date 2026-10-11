import type {
  ModelCompleteResult,
  On,
  ProcessRunResult,
  PromptDecoration,
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
) => ProcessRunResult | 'missing'

interface World {
  clock: MockClock
  draft: string
  cursor: number | undefined
  settingsReads: number
  keybindings: string | undefined
  argvs: (readonly string[])[]
  repaints: PromptDecoration[][]
  filled: string[]
  toasts: string[]
  stdins: string[]
  programs: string[]
  reads: number
  replies: ModelCompleteResult[]
  saved: Map<string, unknown>
}

const ran = (stdout: string, exitCode = 0): ProcessRunResult => ({
  exitCode,
  stdout,
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

const macFinds =
  (
    ...issues: readonly {
      readonly word: string
      readonly choices: readonly string[]
      readonly kind?: 'spelling' | 'grammar'
    }[]
  ): Process =>
  (argv, stdin) =>
    argv[0] !== 'osascript'
      ? 'missing'
      : ran(
          JSON.stringify(
            issues.map(({ word, choices, kind = 'spelling' }) => {
              const start = stdin.indexOf(word)
              return { start, end: start + word.length, kind, choices }
            }),
          ),
        )

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
    toasts: [],
    stdins: [],
    programs: [],
    reads: 0,
    replies: [ANSWER],
    saved: new Map(),
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
    if (e.text === world.draft) {
      world.repaints.push([...(e.decorations ?? [])])
    } else {
      world.filled.push(e.text)
    }
    world.draft = e.text
    return { isFilled: true }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('process.run', (_$, e) => {
    const program = e.argv[0] ?? ''
    world.programs.push(program)
    world.argvs.push(e.argv)
    world.stdins.push(e.init?.stdin ?? '')
    const result = process(e.argv, e.init?.stdin ?? '')
    return result === 'missing'
      ? { deny: `${program}: not found` }
      : { value: result }
  })
  on('model.complete', () => ({ value: world.replies.shift() ?? ANSWER }))
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

    expect(world.programs).toEqual(['osascript', 'enchant-2'])
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'fix-1-1' })
    expect(world.filled).toEqual(['café über the'])
  })

  test('with no spell checker it toasts once and the band still offers Rephrase', async ($, on) => {
    const world = setup(on, () => 'missing', 'He go to store')
    await startAndCheck($, world)
    await startAndCheck($, world)

    expect(world.programs).toEqual(['osascript', 'enchant-2', 'hunspell'])
    expect(world.toasts).toEqual([
      'typofix: no spell checker found (Linux: install enchant-2 or hunspell). /rephrase still works.',
    ])
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ key: 'rephrase' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /no typos/ })).toBeUndefined()
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

    expect(world.programs).toEqual(['osascript', 'hunspell'])
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ key: 'fix-1-1' })).toBeUndefined()
  })

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
  const macAndHunspell: Process = (argv, stdin) =>
    argv[0] === 'hunspell'
      ? ran(
          '@(#) Hunspell\n& whaat 2 1: what, wheat\n*\n& youu 3 10: you, your\n*\n\n',
        )
      : macFinds({ word: 'youu', choices: ['you', 'your', 'yous'] })(
          argv,
          stdin,
        )

  test('by default hunspell en_US adds whaat, macOS keeps youu, and Claude Code settings are never read', async ($, on) => {
    const world = setup(on, macAndHunspell, 'whaat do youu think')
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
      const world = setup(on, macAndHunspell, 'whaat do youu think')
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
      const world = setup(on, macAndHunspell, 'whaat do youu think')
      await startAndCheck($, world)

      expect(world.programs).toEqual(['osascript'])
    },
  )

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

  test('a draft that changed before the pick gives a toast and no fill', async ($, on) => {
    const world = setup(on, macFinds(), 'He go to the store')
    await startAndCheck($, world)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'rephrase' })
    world.draft = 'He go to the store today'
    await band.press({ key: 'rewrite-2' })
    expect(world.filled).toEqual([])
    expect(world.toasts).toEqual(['typofix: the draft changed; press r again'])
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
