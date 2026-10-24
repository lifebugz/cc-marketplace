import type {
  ModelCompleteInput,
  ModelCompleteResult,
  ModelUsage,
  On,
  ProcessRunResult,
  PromptDecoration,
  PromptSubmitInput,
  RenderSurface,
} from 'claude-code'
import {
  describe,
  expect,
  mock,
  test,
  type Engine,
  type MockClock,
  type TestOptions,
} from 'claude-code/testing'

import { PROJECT_WORDS_HEADER, USER_WORDS_HEADER } from '../hooks/text'

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

interface CallHold {
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
  cwds: (string | undefined)[]
  reads: number
  replies: (
    | ModelCompleteResult
    | 'refused'
    | ((maxTokens: number | undefined) => ModelCompleteResult)
  )[]
  requests: ModelCompleteInput[]
  saved: Map<string, unknown>
  files: Map<string, string>
  shipped: string | undefined
  shippedReads: string[]
  unreadable: Set<string>
  isWriteRefused: boolean
  prompts: string[]
  isSubmitDropped: boolean
  submitHold: CallHold | undefined
  fillHold: CallHold | undefined
  processHold: CallHold | undefined
  root: string
  afterFill: ((text: string) => Promise<void>) | undefined
  isReadSilent: boolean
  surfaces: RenderSurface[]
  modelDelayMs: number
}

function holdCall(): CallHold {
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

const MAC_SCRIPT = '/scripts/spell-macos.js'

function pluginRoot(world: {
  readonly argvs: readonly (readonly string[])[]
}): string {
  const script = world.argvs.find(argv => argv[0] === 'osascript')?.[3] ?? ''
  expect(script).toEndWith(MAC_SCRIPT)
  const root = script.slice(0, -MAC_SCRIPT.length)
  expect(['', '/work']).not.toContain(root)
  return root
}

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

const macIssues = (...words: readonly string[]): MacIssue[] =>
  words.map(word => ({ word, choices: ['fixed'] }))

// The band shows Rephrase only next to a typo; one mid-draft keeps it in view.
const STOR_DRAFT = 'He go to the stor today'
const storTypo = (): Process => macFinds({ word: 'stor', choices: ['store'] })

interface FillEcho {
  readonly afterFill: (text: string) => Promise<void>
  readonly count: () => number
}

const isCall = (value: unknown): value is (e: unknown) => Promise<unknown> =>
  typeof value === 'function'

// Claude Code raises prompt.autocomplete for the box change of a fill before
// the fill resolves, so typofix's hook syncs the draft first. The kit's raise
// is untyped; a kit without it fails the test instead of skipping the echo.
function echoFills($: Engine, on: On): FillEcho {
  let reach: (() => void) | undefined
  on('prompt.autocomplete', () => {
    reach?.()
    return { suggestions: [] }
  })
  const raise: unknown = Reflect.get($.prompt, 'autocomplete')
  if (!isCall(raise)) {
    throw new Error('the test kit cannot raise prompt.autocomplete')
  }
  let echoes = 0
  const afterFill = async (text: string): Promise<void> => {
    const token = /\S+$/.exec(text)?.[0] ?? ''
    if (token === '') {
      return
    }
    echoes += 1
    const reached = new Promise<void>(resolve => {
      reach = resolve
    })
    raise({
      text,
      cursor: text.length,
      token,
      start: text.length - token.length,
    }).catch(() => undefined)
    await reached
    // Turns enough for typofix's hook to finish its syncDraft.
    for (let turn = 0; turn < 300; turn++) {
      await Promise.resolve()
    }
  }
  return { afterFill, count: () => echoes }
}

const WITHOUT_HUNSPELL: readonly (readonly [string, TestOptions])[] = [
  ['hunspell off', { options: { hunspell: '' } }],
  ['hunspell not installed', {}],
]

const coldServer = (...lines: readonly string[]): ProcessRunResult => ({
  ...ran('{"issues":[]}'),
  stderr: lines
    .map(
      line => `2000-01-01 00:00:00.000 osascript[1:2] NSSpellServer ${line}\n`,
    )
    .join(''),
})

const SPELL_SERVER_TIMEOUT = coldServer(
  'dataFromCheckingString timed out, index is 1',
  'dataFromCheckingGrammarInString timed out, post editing index is 1',
)

function osascriptRuns(
  answers: readonly (ProcessRunResult | 'aborted')[],
  after: Process,
): Process {
  let runs = 0
  return (argv, stdin) => {
    if (argv[0] !== 'osascript') {
      return after(argv, stdin)
    }
    runs += 1
    return answers[runs - 1] ?? after(argv, stdin)
  }
}

const KEYBINDINGS = '/home/someone/.claude/keybindings.json'
const USER_WORDS = '/home/someone/.claude/typofix-words.txt'
const PROJECT_WORDS = '/work/.claude/typofix-words.txt'
// The shipped list sits in the kit's plugin folder, a temporary one.
const SHIPPED_WORDS = '/words.txt'

const wordFile = (...lines: readonly string[]): string =>
  `${lines.join('\n')}\n`

function fileAt(
  world: {
    readonly keybindings: string | undefined
    readonly files: ReadonlyMap<string, string>
    readonly shipped: string | undefined
  },
  path: string,
): string | undefined {
  if (path === KEYBINDINGS) {
    return world.keybindings
  }
  return path.endsWith(SHIPPED_WORDS) ? world.shipped : world.files.get(path)
}

// hunspell's and enchant-2's `-a` output: each input line's misses, then a
// blank line; an offset counts the `^` that leads the line.
const ispellFinds =
  (...words: readonly string[]) =>
  (stdin: string): ProcessRunResult =>
    ran(
      wordFile(
        '@(#) Hunspell',
        ...stdin
          .split('\n')
          .filter(line => line.startsWith('^'))
          .flatMap(line => [
            ...words
              .filter(word => line.includes(word))
              .map(word => `& ${word} 1 ${String(line.indexOf(word))}: fixed`),
            '',
          ]),
      ),
    )

function setup(
  on: On,
  process: Process,
  draft: string,
  retype?: { readonly atRead: number; readonly draft: string },
  env: Readonly<Record<string, string>> = {},
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
    cwds: [],
    reads: 0,
    replies: [ANSWER],
    requests: [],
    saved: new Map(),
    files: new Map(),
    shipped: undefined,
    shippedReads: [],
    unreadable: new Set(),
    isWriteRefused: false,
    prompts: [],
    isSubmitDropped: false,
    submitHold: undefined,
    fillHold: undefined,
    processHold: undefined,
    root: '/work',
    afterFill: undefined,
    isReadSilent: false,
    surfaces: [],
    modelDelayMs: 0,
  }

  on('session.start', () => ({ cwd: '/work' }))
  on('session.attach', (_$, e) => {
    world.surfaces = [...world.surfaces.filter(s => s !== e.surface), e.surface]
    return { clientId: e.clientId }
  })
  on('session.detach', (_$, e) => {
    world.surfaces = world.surfaces.filter(s => s !== e.surface)
    return { clientId: e.clientId }
  })
  on('session.surfaces', () => ({ value: [...world.surfaces] }))
  on('session.root', () => ({ value: world.root }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('settings.read', () => {
    world.settingsReads += 1
    return { value: {} }
  })
  mock.env(on, { HOME: '/home/someone', ...env })
  on('fs.read', (_$, e) => {
    if (e.path.endsWith(SHIPPED_WORDS)) {
      world.shippedReads.push(e.path)
    }
    if (world.unreadable.has(e.path)) {
      return { deny: `EACCES: permission denied, open '${e.path}'` }
    }
    const text = fileAt(world, e.path)
    return text === undefined
      ? { deny: `ENOENT: no such file or directory, open '${e.path}'` }
      : { value: text }
  })
  on('fs.exists', (_$, e) => ({ value: fileAt(world, e.path) !== undefined }))
  on('fs.write', (_$, e) => {
    if (world.isWriteRefused) {
      return { deny: 'the folder is read-only' }
    }
    world.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('prompt.read', async () => {
    if (world.isReadSilent) {
      // The extension answers an empty box after 4.5 s when the panel is silent.
      await world.clock.sleep(4500)
      return { value: { text: '', cursor: 0 } }
    }
    world.reads += 1
    if (world.reads === retype?.atRead) {
      world.draft = retype.draft
    }
    return {
      value: { text: world.draft, cursor: world.cursor ?? world.draft.length },
    }
  })
  on('prompt.fill', async (_$, e) => {
    const hold = world.fillHold
    world.fillHold = undefined
    await hold?.wait()
    if (world.isFillRefused) {
      return { isFilled: false }
    }
    if (e.text === world.draft) {
      world.repaints.push([...(e.decorations ?? [])])
    } else {
      world.filled.push(e.text)
    }
    world.draft = e.text
    await world.afterFill?.(e.text)
    return { isFilled: true }
  })
  on('prompt.change', (_$, e) => ({ text: e.text }))
  on('prompt.submit', async (_$, e) => {
    await world.submitHold?.wait()
    return world.isSubmitDropped ? { drop: DROPPED } : { text: e.text }
  })
  on('process.run', async (_$, e) => {
    const hold = world.processHold
    world.processHold = undefined
    await hold?.wait()
    const program = e.argv[0] ?? ''
    world.programs.push(program)
    world.argvs.push(e.argv)
    world.stdins.push(e.init?.stdin ?? '')
    world.cwds.push(e.init?.cwd)
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
  on('model.complete', async (_$, e) => {
    if (world.modelDelayMs > 0) {
      await world.clock.sleep(world.modelDelayMs)
    }
    world.prompts.push(e.prompt)
    world.requests.push(e)
    const reply = world.replies.shift() ?? ANSWER
    if (reply === 'refused') {
      return { deny: 'the haiku model is blocked' }
    }
    return { value: typeof reply === 'function' ? reply(e.maxTokens) : reply }
  })
  on('store.get', (_$, e) => ({ value: world.saved.get(e.key) }))
  on('store.delete', (_$, e) => {
    world.saved.delete(e.key)
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

// The kit's raise of prompt.change is untyped, as in echoFills.
async function changeBox(
  $: Engine,
  text: string,
  kind: 'clear' | 'history',
): Promise<void> {
  const change: unknown = Reflect.get($.prompt, 'change')
  if (!isCall(change)) {
    throw new Error('the test kit cannot raise prompt.change')
  }
  await change({ text, cursor: text.length, origin: { kind } })
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
      expect((await band.find({ key: 'ignore-2' }))?.props['hotkey']).toBe('2')
      expect((await band.find({ key: 'ignore-3' }))?.props['hotkey']).toBe('3')
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

  test('a typo in quotes is fixed from the band, and the quotes stay', async ($, on) => {
    const world = setup(
      on,
      macFinds(
        { word: 'Sumbit', choices: ['Submit'] },
        { word: 'Cancle', choices: ['Cancel'] },
      ),
      "the buttons 'Sumbit' and ‘Cancle’ look wrong",
    )
    world.cursor = 0
    await startAndCheck($, world)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'fix-1-1' })
    await band.press({ key: 'fix-1-1' })
    expect(world.toasts).toEqual([])
    expect(world.filled).toEqual([
      "the buttons 'Submit' and ‘Cancle’ look wrong",
      "the buttons 'Submit' and ‘Cancel’ look wrong",
    ])
  })

  test('a typo written right next to Chinese letters is fixed from the band', async ($, on) => {
    const world = setup(
      on,
      macFinds({ word: 'recieve', choices: ['receive'] }),
      '我想recieve这个文件 and more words',
    )
    world.cursor = 0
    await startAndCheck($, world)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'fix-1-1' })
    expect(world.toasts).toEqual([])
    expect(world.filled).toEqual(['我想receive这个文件 and more words'])
  })

  test('a dropped g is fixed together with its apostrophe, and a plural possessive keeps it', async ($, on) => {
    const world = setup(
      on,
      macFinds(
        { word: 'talkin', choices: ['talking'] },
        { word: 'freinds', choices: ['friends', "friend's"] },
      ),
      "stop talkin' about the freinds’ house",
    )
    world.cursor = 0
    await startAndCheck($, world)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'fix-1-1' })
    await band.press({ key: 'fix-1-1' })
    expect(world.toasts).toEqual([])
    expect(world.filled).toEqual([
      'stop talking about the freinds’ house',
      'stop talking about the friends’ house',
    ])
  })

  test('a typo at the end of a quoted error message keeps the closing quote, though the checker never sees the code inside', async ($, on) => {
    const world = setup(
      on,
      macFinds({ word: 'faild', choices: ['failed'] }),
      "the CLI prints 'ERROR: build faild'",
    )
    world.cursor = 0
    await startAndCheck($, world)

    expect(world.stdins[0]).not.toContain('ERROR')
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'fix-1-1' })
    expect(world.toasts).toEqual([])
    expect(world.filled).toEqual(["the CLI prints 'ERROR: build failed'"])
  })

  test('every fallback checker runs in the plugin folder, never in the opened project', async ($, on) => {
    const onlyHunspell: Process = argv =>
      argv[0] === 'hunspell'
        ? ran('@(#) Hunspell\n& teh 1 5: the\n\n')
        : 'missing'
    const world = setup(on, onlyHunspell, 'fix teh bug now')
    await startAndCheck($, world)

    expect(new Set(world.programs)).toEqual(
      new Set(['osascript', 'enchant-2', 'hunspell']),
    )
    const root = pluginRoot(world)
    expect(world.cwds).toEqual(world.programs.map(() => root))
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

  test('with no spell checker it toasts once and the band shows nothing', async ($, on) => {
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
      'no spell checker or dictionary found (Linux: install enchant-2 or hunspell and a dictionary such as en_US). /rephrase still works.',
    ])
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(
      await band.find({ type: 'Text', text: 'drawn by Claude Code' }),
    ).toBeDefined()
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
      'no spell checker or dictionary found (Linux: install enchant-2 or hunspell and a dictionary such as en_US). /rephrase still works.',
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

  test('a draft with no typos shows nothing in the band', async ($, on) => {
    const world = setup(on, macFinds(), 'fix the bug with tests')
    await startAndCheck($, world)

    for (const surface of [...SURFACES, 'vscode'] as const) {
      const band = await $.ui.mount({ ...BAND, surface })
      expect(await band.find({ type: 'Text', text: /typofix/ })).toBeUndefined()
      expect(
        await band.find({ type: 'Text', text: 'drawn by Claude Code' }),
      ).toBeDefined()
      await band.unmount()
    }
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

  for (const [hunspell, options] of WITHOUT_HUNSPELL) {
    test(
      `a macOS check the spell server was too cold to answer runs once more and lists the typo (${hunspell})`,
      options,
      async ($, on) => {
        const world = setup(
          on,
          osascriptRuns(
            [SPELL_SERVER_TIMEOUT],
            macFinds({ word: 'teh', choices: ['the'] }),
          ),
          'fix teh bug now',
        )
        await startAndCheck($, world)

        expect(world.programs.filter(p => p === 'osascript')).toHaveLength(2)
        expect(world.toasts).toEqual([])
        const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
        expect(await band.find({ key: 'fix-1-1' })).toMatchObject({
          text: 'the',
        })
      },
    )

    test(
      `a spell server too cold twice in a row never says no typos and gives no notice (${hunspell})`,
      options,
      async ($, on) => {
        const world = setup(
          on,
          osascriptRuns(
            [SPELL_SERVER_TIMEOUT, SPELL_SERVER_TIMEOUT],
            macFinds({ word: 'teh', choices: ['the'] }),
          ),
          'fix teh bug now',
        )
        await startAndCheck($, world)

        expect(world.programs).toEqual(['osascript', 'osascript'])
        expect(world.toasts).toEqual([])
        const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
        expect(
          await band.find({ type: 'Text', text: /no typos/ }),
        ).toBeUndefined()
      },
    )

    test(
      `a cold spell server and then an aborted run keep osascript, with no notice (${hunspell})`,
      options,
      async ($, on) => {
        const world = setup(
          on,
          osascriptRuns(
            [SPELL_SERVER_TIMEOUT, 'aborted'],
            macFinds({ word: 'teh', choices: ['the'] }),
          ),
          'fix teh bug now',
        )
        await startAndCheck($, world)
        expect(world.programs.filter(p => p === 'osascript')).toHaveLength(2)
        expect(world.toasts).toEqual([])

        const before = world.programs.length
        await startAndCheck($, world)
        expect(world.programs[before]).toBe('osascript')
        expect(world.programs).not.toContain('enchant-2')
        const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
        expect(await band.find({ key: 'fix-1-1' })).toMatchObject({
          text: 'the',
        })
      },
    )

    test(
      `a timeout on the fixes alone keeps the issue list, with no second run (${hunspell})`,
      options,
      async ($, on) => {
        const slowGuesses: Process = (argv, stdin) => {
          const answer = macFinds({ word: 'teh', choices: [] })(argv, stdin)
          return typeof answer !== 'string'
            ? {
                ...answer,
                stderr: coldServer(
                  'suggestGuessesForWordRange timed out, index is 3',
                ).stderr,
              }
            : answer
        }
        const world = setup(on, slowGuesses, 'fix teh bug now')
        await startAndCheck($, world)

        expect(world.programs.filter(p => p === 'osascript')).toHaveLength(1)
        const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
        expect(await band.find({ type: 'Text', text: /^teh$/ })).toBeDefined()
        expect(
          await band.find({ type: 'Text', text: 'no suggestions' }),
        ).toBeDefined()
      },
    )
  }

  test('ignore keeps a word out of later checks', async ($, on) => {
    const world = setup(
      on,
      macFinds({ word: 'Tovan', choices: ['Total'] }),
      'ask Tovan about it',
    )
    await startAndCheck($, world)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await band.find({ key: 'ignore-1' }))?.props['hotkey']).toBe('1')
    await band.press({ key: 'ignore-1' })
    expect(world.files.get(USER_WORDS)).toBe(
      wordFile(...USER_WORDS_HEADER, 'Tovan'),
    )
    expect(await band.find({ key: 'fix-1-1' })).toBeUndefined()

    await startAndCheck($, world)
    expect(await band.find({ key: 'fix-1-1' })).toBeUndefined()
  })

  test('an ignore the file system refuses says so and keeps the word listed', async ($, on) => {
    const world = setup(
      on,
      macFinds({ word: 'Tovan', choices: ['Total'] }),
      'ask Tovan about it',
    )
    world.isWriteRefused = true
    await startAndCheck($, world)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'ignore-1' })
    expect(world.toasts).toEqual(['that did not work: the folder is read-only'])
    expect(world.files.has(USER_WORDS)).toBe(false)
    expect(await band.find({ key: 'fix-1-1' })).toMatchObject({ text: 'Total' })
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
    expect(world.programs).toEqual(['osascript', 'hunspell'])
    const root = pluginRoot(world)
    expect(world.cwds).toEqual([root, root])
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
    'the hunspell option off means macOS alone',
    { options: { hunspell: 'off' } },
    async ($, on) => {
      const world = setup(on, macAndHunspell(), 'whaat do youu think')
      await startAndCheck($, world)

      expect(world.programs).toEqual(['osascript'])
    },
  )

  test('with hunspell not installed, macOS checks alone with no notice', async ($, on) => {
    const world = setup(
      on,
      macFinds({ word: 'youu', choices: ['you'] }),
      'whaat do youu think',
    )
    world.cursor = 0
    await startAndCheck($, world)
    await startAndCheck($, world)

    expect(world.programs).toEqual([
      'osascript',
      'hunspell',
      'hunspell',
      'osascript',
    ])
    expect(world.toasts).toEqual([])
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ key: 'fix-1-1' })).toMatchObject({ text: 'you' })
  })

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

  test('a hunspell run that times out skips hunspell for that check only', async ($, on) => {
    let hunspellRuns = 0
    const slowOnce: Process = (argv, stdin) => {
      if (argv[0] === 'hunspell') {
        hunspellRuns += 1
        if (hunspellRuns === 1) {
          return 'timeout'
        }
      }
      return macAndHunspell()(argv, stdin)
    }
    const world = setup(on, slowOnce, 'whaat do youu think')
    await startAndCheck($, world)
    await world.clock.advance(5000)
    await startAndCheck($, world)

    expect(world.programs).toEqual([
      'osascript',
      'hunspell',
      'osascript',
      'hunspell',
    ])
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /2 typos/ })).toBeDefined()
  })

  test('a hunspell that is too slow 3 checks in a row is turned off', async ($, on) => {
    const alwaysSlow: Process = (argv, stdin) =>
      argv[0] === 'hunspell' ? 'timeout' : macAndHunspell()(argv, stdin)
    const world = setup(on, alwaysSlow, 'whaat do youu think')
    for (let check = 0; check < 4; check++) {
      await startAndCheck($, world)
      await world.clock.advance(5000)
    }

    expect(world.programs.filter(p => p === 'hunspell')).toHaveLength(3)
    expect(world.programs.filter(p => p === 'osascript')).toHaveLength(4)
  })

  test('a hunspell that is slow only now and then stays on', async ($, on) => {
    let hunspellRuns = 0
    const slowEveryOther: Process = (argv, stdin) => {
      if (argv[0] === 'hunspell') {
        hunspellRuns += 1
        if (hunspellRuns % 2 === 1) {
          return 'timeout'
        }
      }
      return macAndHunspell()(argv, stdin)
    }
    const world = setup(on, slowEveryOther, 'whaat do youu think')
    for (let check = 0; check < 6; check++) {
      await startAndCheck($, world)
      await world.clock.advance(5000)
    }

    expect(world.programs.filter(p => p === 'hunspell')).toHaveLength(6)
  })

  test('two aborted hunspell runs after it has answered keep hunspell on', async ($, on) => {
    let hunspellRuns = 0
    const abortedLater: Process = (argv, stdin) => {
      if (argv[0] === 'hunspell') {
        hunspellRuns += 1
        if (hunspellRuns === 2 || hunspellRuns === 3) {
          return 'aborted'
        }
      }
      return macAndHunspell()(argv, stdin)
    }
    const world = setup(on, abortedLater, 'whaat do youu think')
    await startAndCheck($, world)
    await startAndCheck($, world)
    await startAndCheck($, world)

    expect(world.programs.filter(p => p === 'hunspell')).toHaveLength(4)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /2 typos/ })).toBeDefined()
  })

  test('a shortcut added during the session shows in the header after the next check', async ($, on) => {
    const world = setup(
      on,
      macFinds(
        { word: 'teh', choices: ['the'] },
        { word: 'wiht', choices: ['with'] },
      ),
      'fix teh bug wiht tests',
    )
    world.cursor = 0
    await startAndCheck($, world)
    world.keybindings = JSON.stringify({
      bindings: [
        { context: 'Chat', bindings: { 'ctrl+space': 'abovePrompt:focus' } },
      ],
    })

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'fix-1-1' })
    await world.clock.advance(400)
    expect(
      await band.find({ type: 'Text', text: /ctrl\+space, then a key/ }),
    ).toBeDefined()
  })

  test('a keybindings file that cannot be read keeps the key shown so far', async ($, on) => {
    const world = setup(
      on,
      macFinds(
        { word: 'teh', choices: ['the'] },
        { word: 'wiht', choices: ['with'] },
      ),
      'fix teh bug wiht tests',
    )
    world.cursor = 0
    world.keybindings = JSON.stringify({
      bindings: [
        { context: 'Chat', bindings: { 'ctrl+space': 'abovePrompt:focus' } },
      ],
    })
    await startAndCheck($, world)
    world.keybindings = undefined

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'fix-1-1' })
    await world.clock.advance(400)
    expect(
      await band.find({ type: 'Text', text: /ctrl\+space, then a key/ }),
    ).toBeDefined()
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
        await band.find({ type: 'Text', text: /ctrl\+space, then a key/ }),
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
      await band.find({ type: 'Text', text: /ctrl\+x tab, then a key/ }),
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

  const grammarUntilFixed: Process = (argv, stdin) =>
    stdin.includes('teh')
      ? macFinds(
          { word: 'go', choices: ['goes'], kind: 'grammar' },
          { word: 'teh', choices: ['the'] },
        )(argv, stdin)
      : macFinds()(argv, stdin)

  for (const [hunspell, options] of WITHOUT_HUNSPELL) {
    test(
      `a check that finds nothing more takes the last underline off at once (${hunspell})`,
      options,
      async ($, on) => {
        const world = setup(on, grammarUntilFixed, 'He go to teh store now')
        await startAndCheck($, world)
        const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
        await band.press({ key: 'fix-2-1' })
        await world.clock.advance(400)

        expect(world.filled).toEqual(['He go to the store now'])
        expect(world.repaints).toEqual([
          [
            { start: 3, end: 5, underline: true, color: 'warning' },
            { start: 9, end: 12, underline: true, color: 'error' },
          ],
          [],
        ])
      },
    )

    test(
      `a check that finds nothing more leaves the box alone while the cursor is inside the draft (${hunspell})`,
      options,
      async ($, on) => {
        const world = setup(on, grammarUntilFixed, 'He go to teh store now')
        await startAndCheck($, world)
        const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
        await band.press({ key: 'fix-2-1' })
        world.cursor = 3
        await world.clock.advance(400)

        expect(world.repaints).toHaveLength(1)
      },
    )
  }

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

  test('a band fix made while a repaint was on its way stays in the box', async ($, on) => {
    const world = setup(on, twoTypos(), 'fix teh bug wiht now')
    const hold = holdCall()
    world.fillHold = hold
    await $.session.start({
      cwd: '/work',
      surface: 'terminal',
      isInteractive: true,
    })
    const checked = world.clock.advance(400)
    await hold.reached
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'fix-1-1' })
    expect(world.draft).toBe('fix the bug wiht now')

    hold.release()
    await checked
    await world.clock.advance(0)
    expect(world.filled).toEqual([
      'fix the bug wiht now',
      'fix teh bug wiht now',
      'fix the bug wiht now',
    ])
    expect(world.draft).toBe('fix the bug wiht now')
  })

  test('a band fix made while a repaint was on its way stays in the box, though the fix itself already synced the draft', async ($, on) => {
    const world = setup(on, twoTypos(), 'fix teh bug wiht now')
    const echo = echoFills($, on)
    world.afterFill = echo.afterFill
    const hold = holdCall()
    world.fillHold = hold
    await $.session.start({
      cwd: '/work',
      surface: 'terminal',
      isInteractive: true,
    })
    const checked = world.clock.advance(400)
    await hold.reached
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'fix-1-1' })
    hold.release()
    await checked
    await world.clock.advance(0)

    expect(echo.count()).toBeGreaterThan(0)
    expect(world.draft).toBe('fix the bug wiht now')
  })

  test('a rewrite picked while a repaint was on its way stays in the box, though it already synced the draft', async ($, on) => {
    const world = setup(
      on,
      macFinds({ word: 'teh', choices: ['the'] }),
      'He go to teh store now',
    )
    const echo = echoFills($, on)
    world.afterFill = echo.afterFill
    const hold = holdCall()
    world.fillHold = hold
    await $.session.start({
      cwd: '/work',
      surface: 'terminal',
      isInteractive: true,
    })
    const checked = world.clock.advance(400)
    await hold.reached
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'rephrase' })
    await band.press({ key: 'rewrite-1' })
    hold.release()
    await checked
    await world.clock.advance(0)

    expect(echo.count()).toBeGreaterThan(0)
    expect(world.draft).toBe(REWRITES[0])
  })

  test('an ignore fills nothing when a key landed after it read the box', async ($, on) => {
    const world = setup(on, twoTypos(), 'teh bug wiht now', {
      atRead: 6,
      draft: 'teh bug wiht now!',
    })
    await startAndCheck($, world)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(world.reads).toBe(4)
    await band.press({ key: 'ignore-1' })

    expect(world.draft).toBe('teh bug wiht now!')
    expect(world.filled).toEqual([])
    expect(world.repaints).toHaveLength(1)
    expect(await band.find({ type: 'Text', text: /1 typo\b/ })).toBeDefined()
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
    const world = setup(on, storTypo(), STOR_DRAFT)
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
    const world = setup(on, storTypo(), STOR_DRAFT)
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
    const world = setup(on, storTypo(), STOR_DRAFT)
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
    const world = setup(on, storTypo(), STOR_DRAFT)
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

  test('Try again after a failed /rephrase asks Haiku again with the same text', async ($, on) => {
    const world = setup(on, macFinds(), '')
    world.replies = ['refused', ANSWER]
    await startAndCheck($, world)

    await $.command.run({
      ...TYPED,
      command: 'rephrase',
      args: 'He go to the store',
    })
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'rephrase' })
    expect(world.prompts).toHaveLength(2)
    expect(world.prompts[1]).toBe(world.prompts[0])
    expect(world.prompts[1]).toContain('He go to the store')
    expect(await band.find({ key: 'rewrite-1' })).toBeDefined()
  })

  test('a draft that changed before the pick gives a toast and no fill', async ($, on) => {
    const world = setup(on, storTypo(), STOR_DRAFT)
    await startAndCheck($, world)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'rephrase' })
    world.draft = `${STOR_DRAFT} again`
    await band.press({ key: 'rewrite-2' })
    expect(world.filled).toEqual([])
    expect(world.toasts).toEqual(['the draft changed; press r again'])
  })

  test('a rewrite the prompt box refuses gives a toast', async ($, on) => {
    const world = setup(on, storTypo(), STOR_DRAFT)
    await startAndCheck($, world)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'rephrase' })
    world.isFillRefused = true
    await band.press({ key: 'rewrite-1' })
    expect(world.toasts).toEqual(['the prompt box did not take the rewrite'])
  })

  const SHORT_DRAFT = 'He go to the store'
  const LONG_DRAFT = 'He go to the store and buy three apple. '.repeat(150)
  const CUT_OFF =
    "Haiku's reply was cut off at 16000 tokens (the draft may be too long)"
  const atCap = (maxTokens: number | undefined): ModelUsage => ({
    ...USAGE,
    output_tokens: maxTokens ?? 0,
  })

  test('a long draft gets the same token cap as a short one and more time', async ($, on) => {
    const world = setup(on, macFinds(), '')
    for (const args of [SHORT_DRAFT, LONG_DRAFT]) {
      await $.command.run({ ...TYPED, command: 'rephrase', args })
    }

    const [short, long] = world.requests
    expect(short?.maxTokens).toBe(16000)
    expect(long?.maxTokens).toBe(16000)
    expect(short?.timeoutMs).toBeGreaterThanOrEqual(20000)
    expect(long?.timeoutMs).toBeGreaterThan(short?.timeoutMs ?? Infinity)
    expect(long?.timeoutMs).toBeLessThanOrEqual(120000)
  })

  test('a reply cut off at the token cap says so, answered or empty', async ($, on) => {
    const world = setup(on, macFinds(), '')
    world.replies = [
      (maxTokens): ModelCompleteResult => ({
        isAnswered: true,
        text: '{"rewrites": ["He goes',
        usage: atCap(maxTokens),
      }),
      (maxTokens): ModelCompleteResult => ({
        isAnswered: false,
        reason: 'empty-reply',
        usage: atCap(maxTokens),
      }),
    ]

    for (let call = 0; call < 2; call++) {
      const answer = await $.command.run({
        ...TYPED,
        command: 'rephrase',
        args: LONG_DRAFT,
      })
      expect(answer.text).toBe(CUT_OFF)
    }
  })

  test('a long draft that runs out of time names the time it had', async ($, on) => {
    const world = setup(on, macFinds(), '')
    world.replies = [
      {
        isAnswered: false,
        reason: 'aborted',
        usage: { ...USAGE, output_tokens: 0 },
      },
    ]

    const answer = await $.command.run({
      ...TYPED,
      command: 'rephrase',
      args: LONG_DRAFT,
    })
    const timeoutMs = world.requests[0]?.timeoutMs ?? 0
    expect(timeoutMs).toBeGreaterThan(20000)
    expect(answer.text).toBe(
      `Haiku took longer than ${String(timeoutMs / 1000)} s`,
    )
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

describe('the VS Code panel', () => {
  const PANEL_ENV = { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' } as const
  const PANEL_BAND = { ...BAND, surface: 'vscode' } as const

  async function openPanel(
    $: Engine,
    world: { readonly clock: MockClock },
  ): Promise<void> {
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await $.session.attach({ surface: 'vscode', clientId: 'panel-1' })
    await world.clock.advance(1000)
  }

  test('a typo in the panel is listed after the next read, and a click fills the fix', async ($, on) => {
    const world = setup(
      on,
      macFinds({ word: 'recieve', choices: ['receive', 'relieve'] }),
      'please recieve the file now',
      undefined,
      PANEL_ENV,
    )
    await openPanel($, world)

    const band = await $.ui.mount(PANEL_BAND)
    expect(
      await band.find({ type: 'Text', text: /1 typo · click a fix/ }),
    ).toBeDefined()
    expect(await band.find({ type: 'Text', text: /ctrl\+x/ })).toBeUndefined()
    await band.press({ key: 'fix-1-1' })
    expect(world.filled).toEqual(['please receive the file now'])
    expect(world.repaints).toEqual([])
  })

  test('a draft typed after the panel opened is checked on a later read', async ($, on) => {
    const world = setup(
      on,
      macFinds({ word: 'teh', choices: ['the'] }),
      '',
      undefined,
      PANEL_ENV,
    )
    await openPanel($, world)
    world.draft = 'fix teh bug now'
    await world.clock.advance(1000)

    const band = await $.ui.mount(PANEL_BAND)
    expect(await band.find({ key: 'fix-1-1' })).toMatchObject({ text: 'the' })
  })

  test('the band stays while the cursor is right after a typo, since the panel shows no typeahead', async ($, on) => {
    const world = setup(
      on,
      macFinds({ word: 'wiht', choices: ['with'] }),
      'fix the bug wiht',
      undefined,
      PANEL_ENV,
    )
    await openPanel($, world)

    const band = await $.ui.mount(PANEL_BAND)
    expect(await band.find({ key: 'fix-1-1' })).toMatchObject({ text: 'with' })
  })

  test('a prompt sent from the panel clears the band', async ($, on) => {
    const world = setup(
      on,
      macFinds({ word: 'teh', choices: ['the'] }),
      'fix teh bug now',
      undefined,
      PANEL_ENV,
    )
    await openPanel($, world)
    const band = await $.ui.mount(PANEL_BAND)
    expect(await band.find({ key: 'fix-1-1' })).toBeDefined()

    await $.prompt.submit({
      origin: { kind: 'sdk' },
      wait: false,
      text: 'fix teh bug now',
    })
    expect(await band.find({ key: 'fix-1-1' })).toBeUndefined()
    world.draft = ''
    await world.clock.advance(1000)
    expect(await band.find({ key: 'fix-1-1' })).toBeUndefined()
  })

  test('ignore in the panel takes the word off the band with no fill', async ($, on) => {
    const world = setup(
      on,
      macFinds(
        { word: 'teh', choices: ['the'] },
        { word: 'wiht', choices: ['with'] },
      ),
      'teh bug wiht now',
      undefined,
      PANEL_ENV,
    )
    await openPanel($, world)
    const band = await $.ui.mount(PANEL_BAND)
    await band.press({ key: 'ignore-1' })

    expect(world.files.get(USER_WORDS)).toBe(
      wordFile(...USER_WORDS_HEADER, 'teh'),
    )
    expect(await band.find({ type: 'Text', text: /1 typo\b/ })).toBeDefined()
    expect(world.filled).toEqual([])
    expect(world.repaints).toEqual([])
  })

  test('a panel that does not answer a read in time keeps the typos listed', async ($, on) => {
    const world = setup(
      on,
      macFinds({ word: 'teh', choices: ['the'] }),
      'fix teh bug now',
      undefined,
      PANEL_ENV,
    )
    await openPanel($, world)
    world.isReadSilent = true
    await world.clock.advance(10000)

    const band = await $.ui.mount(PANEL_BAND)
    expect(await band.find({ key: 'fix-1-1' })).toMatchObject({ text: 'the' })
  })

  test('a typofix loaded after the panel attached, as after a reload, still reads the panel', async ($, on) => {
    const world = setup(
      on,
      macFinds({ word: 'teh', choices: ['the'] }),
      'fix teh bug now',
      undefined,
      PANEL_ENV,
    )
    world.surfaces = ['vscode']
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await world.clock.advance(1000)

    const band = await $.ui.mount(PANEL_BAND)
    expect(await band.find({ key: 'fix-1-1' })).toMatchObject({ text: 'the' })
  })

  test('once the panel detaches, typofix stops reading the draft', async ($, on) => {
    const world = setup(on, macFinds(), 'fix the bug now', undefined, PANEL_ENV)
    await openPanel($, world)
    await $.session.detach({
      surface: 'vscode',
      clientId: 'panel-1',
      reason: 'detach',
    })
    const reads = world.reads
    await world.clock.advance(2000)

    expect(world.reads).toBe(reads)
  })

  test('a panel send right after the last key, before the next read, still resets a hidden band', async ($, on) => {
    const world = setup(
      on,
      macFinds({ word: 'teh', choices: ['the'] }),
      'fix teh bug',
      undefined,
      PANEL_ENV,
    )
    await openPanel($, world)
    const band = await $.ui.mount(PANEL_BAND)
    await band.press({ key: 'hide' })
    expect(await band.find({ key: 'fix-1-1' })).toBeUndefined()

    world.draft = 'fix teh bug now'
    await $.prompt.submit({
      origin: { kind: 'sdk' },
      wait: false,
      text: 'fix teh bug now',
    })
    world.draft = 'see teh bug'
    await world.clock.advance(1000)
    expect(await band.find({ key: 'fix-1-1' })).toMatchObject({ text: 'the' })
  })

  test('a Rephrase clicked right after typing is not cancelled by the next read', async ($, on) => {
    const world = setup(on, storTypo(), STOR_DRAFT, undefined, PANEL_ENV)
    world.modelDelayMs = 2000
    await openPanel($, world)
    const band = await $.ui.mount(PANEL_BAND)

    world.draft = `${STOR_DRAFT} now`
    await band.press({ key: 'rephrase' })
    await world.clock.advance(3000)
    expect(await band.find({ key: 'rewrite-1' })).toBeDefined()
    expect(world.prompts[0]).toContain(`${STOR_DRAFT} now`)
  })

  test('a panel that attaches again after a detach is read and checked again', async ($, on) => {
    const world = setup(
      on,
      macFinds({ word: 'teh', choices: ['the'] }),
      '',
      undefined,
      PANEL_ENV,
    )
    await openPanel($, world)
    await $.session.detach({
      surface: 'vscode',
      clientId: 'panel-1',
      reason: 'detach',
    })
    const reads = world.reads
    await world.clock.advance(3000)
    expect(world.reads).toBe(reads)

    await $.session.attach({ surface: 'vscode', clientId: 'panel-2' })
    world.draft = 'fix teh bug now'
    await world.clock.advance(1000)
    expect(world.reads).toBeGreaterThan(reads)
    const band = await $.ui.mount(PANEL_BAND)
    expect(await band.find({ key: 'fix-1-1' })).toMatchObject({ text: 'the' })
  })

  test('with no panel attached, a non-interactive session never reads the draft', async ($, on) => {
    const world = setup(on, macFinds(), 'fix the bug now', undefined, PANEL_ENV)
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await world.clock.advance(2000)

    expect(world.reads).toBe(0)
    expect(world.programs).toEqual([])
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
    const world = setup(on, storTypo(), STOR_DRAFT)
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

    const hold = holdCall()
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

describe('words that are not typos', () => {
  const MATRIX_DRAFT = 'ask Tovan and Brevik about frontmatter wiht care'
  const MATRIX_WORDS = ['Tovan', 'Brevik', 'frontmatter', 'wiht'] as const

  const macWithHunspell: Process = (argv, stdin) =>
    argv[0] === 'hunspell'
      ? ispellFinds('Brevik')(stdin)
      : macFinds(...macIssues('Tovan', 'frontmatter', 'wiht'))(argv, stdin)
  const linux =
    (program: string): Process =>
    (argv, stdin) =>
      argv[0] === program ? ispellFinds(...MATRIX_WORDS)(stdin) : 'missing'

  const ENGINES: readonly (readonly [string, TestOptions, Process, string])[] =
    [
      [
        'macOS alone',
        { options: { hunspell: '' } },
        macFinds(...macIssues(...MATRIX_WORDS)),
        'osascript',
      ],
      [
        'macOS, with a word only hunspell finds',
        {},
        macWithHunspell,
        'hunspell',
      ],
      ['enchant-2 on Linux', {}, linux('enchant-2'), 'enchant-2'],
      ['hunspell on Linux', {}, linux('hunspell'), 'hunspell'],
    ]

  for (const [engine, options, process, program] of ENGINES) {
    test(
      `${engine}: a shipped, a user and a project word are never listed, and the rest is`,
      options,
      async ($, on) => {
        const world = setup(on, process, MATRIX_DRAFT)
        world.shipped = wordFile('# ships with typofix', 'frontmatter')
        world.files.set(USER_WORDS, wordFile(...USER_WORDS_HEADER, 'Tovan'))
        world.files.set(PROJECT_WORDS, wordFile('# team words', 'Brevik'))
        await startAndCheck($, world)

        expect(world.programs).toContain(program)
        const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
        expect(
          await band.find({ type: 'Text', text: /1 typo\b/ }),
        ).toBeDefined()
        expect(await band.find({ type: 'Text', text: /^wiht$/ })).toBeDefined()
      },
    )

    test(
      `${engine}: with no word lists every word is listed`,
      options,
      async ($, on) => {
        const world = setup(on, process, MATRIX_DRAFT)
        await startAndCheck($, world)

        const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
        expect(await band.find({ type: 'Text', text: /4 typos/ })).toBeDefined()
      },
    )
  }

  test(
    'the shipped list is read from the plugin folder once a session',
    { options: { hunspell: '' } },
    async ($, on) => {
      const world = setup(on, macFinds(...macIssues('wiht')), 'fix wiht care')
      world.shipped = wordFile('frontmatter')
      await startAndCheck($, world)
      world.draft = 'fix wiht more care'
      await changeBox($, world.draft, 'history')
      await world.clock.advance(400)
      expect(world.programs).toEqual(['osascript', 'osascript'])
      expect(world.shippedReads).toEqual([
        `${pluginRoot(world)}${SHIPPED_WORDS}`,
      ])

      await startAndCheck($, world)
      expect(world.shippedReads).toHaveLength(2)
    },
  )

  test('a hand edit of the user or the project list counts at the next check', async ($, on) => {
    const world = setup(
      on,
      macFinds(...macIssues('Tovan', 'Brevik')),
      'ask Tovan and Brevik now',
    )
    await startAndCheck($, world)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /2 typos/ })).toBeDefined()

    world.files.set(USER_WORDS, wordFile('Tovan'))
    world.files.set(PROJECT_WORDS, wordFile('Brevik'))
    world.draft = 'ask Tovan and Brevik now please'
    await changeBox($, world.draft, 'history')
    await world.clock.advance(400)
    expect(await band.find({ type: 'Text', text: /typofix/ })).toBeUndefined()
  })

  const freinds = (isHunspellsTurn: () => boolean): Process => {
    return (argv, stdin) => {
      if (argv[0] === 'hunspell') {
        return isHunspellsTurn()
          ? ran(`@(#) Hunspell\n*\n& freinds’ 1 4: friend's\n*\n*\n*\n\n`)
          : ispellFinds()(stdin)
      }
      return macFinds(...(isHunspellsTurn() ? [] : macIssues('freinds')))(
        argv,
        stdin,
      )
    }
  }

  test('a word ignored as macOS cuts it stays ignored when only hunspell finds it', async ($, on) => {
    let isHunspellsTurn = false
    const world = setup(
      on,
      freinds(() => isHunspellsTurn),
      'my freinds’ house is near',
    )
    await startAndCheck($, world)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /^freinds’$/ })).toBeDefined()
    await band.press({ key: 'ignore-1' })
    expect(world.files.get(USER_WORDS)).toBe(
      wordFile(...USER_WORDS_HEADER, 'freinds'),
    )

    isHunspellsTurn = true
    const before = world.programs.length
    await startAndCheck($, world)
    expect(world.programs.slice(before)).toEqual(['osascript', 'hunspell'])
    expect(await band.find({ type: 'Text', text: /typofix/ })).toBeUndefined()
  })

  test('the hunspell answer that test relies on lists the word when no list has it', async ($, on) => {
    const world = setup(
      on,
      freinds(() => true),
      'my freinds’ house is near',
    )
    await startAndCheck($, world)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /^freinds’$/ })).toBeDefined()
  })

  // macOS reads `e-mial` as one word and hunspell only `mial`: the merge
  // drops hunspell's overlapping word before the lists filter macOS's.
  const emial: Process = (argv, stdin) =>
    argv[0] === 'hunspell'
      ? ispellFinds('mial')(stdin)
      : macFinds(...macIssues('e-mial'))(argv, stdin)

  test('an ignored word macOS cuts longer keeps hunspell’s shorter cut of it out', async ($, on) => {
    const world = setup(on, emial, 'ask the e-mial now')
    world.files.set(USER_WORDS, wordFile('e-mial'))
    await startAndCheck($, world)

    expect(world.programs).toEqual(['osascript', 'hunspell'])
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /typofix/ })).toBeUndefined()
  })

  test('with no list, e-mial is listed once, as macOS cuts it', async ($, on) => {
    const world = setup(on, emial, 'ask the e-mial now')
    await startAndCheck($, world)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /1 typo\b/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^e-mial$/ })).toBeDefined()
  })

  const NFC = 'café'.normalize('NFC')
  const NFD = 'café'.normalize('NFD')
  const SAME_WORDS: readonly (readonly [string, string, string])[] = [
    ['another case', 'tovan', 'Tovan'],
    ['a curly apostrophe for a straight one', 'tovan’s', "Tovan's"],
    ['a straight apostrophe for a curly one', "Tovan's", 'Tovan’s'],
    ['composed letters for decomposed ones', NFC, NFD],
    ['decomposed letters for composed ones', NFD, NFC],
  ]

  for (const [how, listed, flagged] of SAME_WORDS) {
    test(
      `a word listed with ${how} is still the same word`,
      { options: { hunspell: '' } },
      async ($, on) => {
        const world = setup(
          on,
          macFinds(...macIssues(flagged, 'wiht')),
          `ask ${flagged} about wiht now`,
        )
        world.files.set(USER_WORDS, wordFile(listed))
        await startAndCheck($, world)

        const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
        expect(
          await band.find({ type: 'Text', text: /1 typo\b/ }),
        ).toBeDefined()
        expect(await band.find({ type: 'Text', text: /^wiht$/ })).toBeDefined()
      },
    )
  }

  test('with CLAUDE_CONFIG_DIR set, the user list is read and written there', async ($, on) => {
    const world = setup(
      on,
      macFinds(...macIssues('Tovan', 'wiht')),
      'ask Tovan about wiht now',
      undefined,
      { CLAUDE_CONFIG_DIR: '/settings' },
    )
    world.files.set('/settings/typofix-words.txt', wordFile('Tovan'))
    world.files.set(USER_WORDS, wordFile('wiht'))
    await startAndCheck($, world)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /^wiht$/ })).toBeDefined()
    await band.press({ key: 'ignore-1' })
    expect(world.files.get('/settings/typofix-words.txt')).toBe(
      wordFile('Tovan', 'wiht'),
    )
    expect(world.files.get(USER_WORDS)).toBe(wordFile('wiht'))
  })

  test('an ignore never writes over a list it could not read', async ($, on) => {
    const world = setup(on, macFinds(...macIssues('wiht')), 'fix wiht now')
    world.files.set(USER_WORDS, wordFile('Tovan'))
    world.unreadable.add(USER_WORDS)
    await startAndCheck($, world)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'ignore-1' })
    expect(world.files.get(USER_WORDS)).toBe(wordFile('Tovan'))
    expect(world.toasts).toEqual([
      `that did not work: EACCES: permission denied, open '${USER_WORDS}'`,
    ])
  })

  test('a word ignored while a check runs stays ignored when that check ends', async ($, on) => {
    const world = setup(on, macFinds(...macIssues('teh')), 'fix teh bug now')
    await startAndCheck($, world)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ key: 'ignore-1' })).toBeDefined()

    const hold = holdCall()
    world.processHold = hold
    world.draft = 'fix teh bug now please'
    await changeBox($, world.draft, 'history')
    const checked = world.clock.advance(400)
    await hold.reached
    await band.press({ key: 'ignore-1' })
    expect(await band.find({ key: 'ignore-1' })).toBeUndefined()

    hold.release()
    await checked
    await world.clock.settle()
    expect(world.programs.at(-1)).toBe('osascript')
    expect(await band.find({ key: 'ignore-1' })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: /typofix/ })).toBeUndefined()
  })

  test('two ignores pressed at once keep both words', async ($, on) => {
    const world = setup(
      on,
      macFinds(...macIssues('teh', 'wiht')),
      'fix teh bug wiht care',
    )
    await startAndCheck($, world)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

    await Promise.all([
      band.press({ key: 'ignore-1' }),
      band.press({ key: 'ignore-2' }),
    ])
    await world.clock.settle()
    expect(world.files.get(USER_WORDS)).toBe(
      wordFile(...USER_WORDS_HEADER, 'teh', 'wiht'),
    )
  })

  test('words ignored before the lists move from the store to the user list', async ($, on) => {
    const world = setup(on, macFinds(...macIssues('teh')), 'fix teh bug now')
    world.saved.set('ignored', ['teh', 'tovan'])
    await startAndCheck($, world)

    expect(world.files.get(USER_WORDS)).toBe(
      wordFile(...USER_WORDS_HEADER, 'teh', 'tovan'),
    )
    expect(world.saved.has('ignored')).toBe(false)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /typofix/ })).toBeUndefined()
  })

  test('a move the file system refuses keeps the store, and its words stay ignored', async ($, on) => {
    const world = setup(on, macFinds(...macIssues('teh')), 'fix teh bug now')
    world.saved.set('ignored', ['teh'])
    world.isWriteRefused = true
    await startAndCheck($, world)

    expect(world.files.has(USER_WORDS)).toBe(false)
    expect(world.saved.get('ignored')).toEqual(['teh'])
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /typofix/ })).toBeUndefined()
  })

  test('clearing the draft empties the band at once, before any check', async ($, on) => {
    const world = setup(on, macFinds(...macIssues('teh')), 'fix teh bug now')
    await startAndCheck($, world)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ key: 'ignore-1' })).toBeDefined()

    world.draft = ''
    await changeBox($, world.draft, 'clear')
    expect(await band.find({ key: 'ignore-1' })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: /typofix/ })).toBeUndefined()
  })
})

describe('/typo-words', () => {
  const words = async ($: Engine, args: string): Promise<string | undefined> =>
    (await $.command.run({ ...TYPED, command: 'typo-words', args })).text

  test('with no arguments it lists the three lists, each with its path', async ($, on) => {
    const world = setup(on, macFinds(...macIssues('wiht')), 'fix wiht now')
    world.shipped = wordFile('# ships with typofix', 'frontmatter', 'ok')
    world.files.set(USER_WORDS, wordFile(...USER_WORDS_HEADER, 'Tovan'))
    await startAndCheck($, world)

    expect(await words($, '')).toBe(
      [
        'These words are never listed as typos, whichever spell checker flags them:',
        `ships with typofix: 2 words in ${pluginRoot(world)}${SHIPPED_WORDS}`,
        '  frontmatter, ok',
        `yours, in all your projects: 1 word in ${USER_WORDS}`,
        '  Tovan',
        `this project, for everyone who commits the file: 0 words in ${PROJECT_WORDS}`,
      ].join('\n'),
    )
  })

  test('the list names words still waiting in the store', async ($, on) => {
    const world = setup(on, macFinds(), '')
    world.isWriteRefused = true
    world.saved.set('ignored', ['teh'])
    await startAndCheck($, world)

    expect(await words($, '')).toContain(
      'still in the store, moved at the next start: teh',
    )
  })

  test('add puts new words in the user list and names the ones already there', async ($, on) => {
    const world = setup(on, macFinds(), '')
    world.shipped = wordFile('ok')
    await startAndCheck($, world)

    expect(await words($, 'add Tovan teh')).toBe(
      `added Tovan, teh to ${USER_WORDS}`,
    )
    expect(await words($, 'add tovan, ‘Brevik’ ok')).toBe(
      [
        `added Brevik to ${USER_WORDS}`,
        `already in ${USER_WORDS}: tovan`,
        'ok ships with typofix',
      ].join('\n'),
    )
    expect(world.files.get(USER_WORDS)).toBe(
      wordFile(...USER_WORDS_HEADER, 'Tovan', 'teh', 'Brevik'),
    )
  })

  test('a word added by the command is not listed at the next check', async ($, on) => {
    const world = setup(
      on,
      macFinds(...macIssues('Tovan')),
      'ask Tovan about it',
    )
    await startAndCheck($, world)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /^Tovan$/ })).toBeDefined()

    await words($, 'add Tovan')
    world.draft = 'ask Tovan about it again'
    await changeBox($, world.draft, 'history')
    await world.clock.advance(400)
    expect(await band.find({ type: 'Text', text: /typofix/ })).toBeUndefined()
  })

  test('share makes the project list, then adds to it and keeps its comments', async ($, on) => {
    const world = setup(on, macFinds(), '')
    await startAndCheck($, world)

    expect(await words($, 'share Brevik')).toBe(
      [`added Brevik to ${PROJECT_WORDS}`, 'Commit the file to share it.'].join(
        '\n',
      ),
    )
    expect(world.files.get(PROJECT_WORDS)).toBe(
      wordFile(...PROJECT_WORDS_HEADER, 'Brevik'),
    )

    world.files.set(PROJECT_WORDS, wordFile('# our words', 'Brevik  # a name'))
    await words($, 'share Tovan')
    expect(world.files.get(PROJECT_WORDS)).toBe(
      wordFile('# our words', 'Brevik  # a name', 'Tovan'),
    )
  })

  test('remove takes a word out of both lists and says a shipped word stays', async ($, on) => {
    const world = setup(on, macFinds(), '')
    world.shipped = wordFile('ok')
    world.files.set(USER_WORDS, wordFile('# mine', 'Tovan', 'teh'))
    world.files.set(PROJECT_WORDS, wordFile('tovan Brevik # names'))
    await startAndCheck($, world)

    expect(await words($, 'remove TOVAN ok zzz')).toBe(
      [
        `removed Tovan from ${USER_WORDS}`,
        `removed tovan from ${PROJECT_WORDS}`,
        'ok ships with typofix, so it stays ignored',
        'not in your lists: zzz',
      ].join('\n'),
    )
    expect(world.files.get(USER_WORDS)).toBe(wordFile('# mine', 'teh'))
    expect(world.files.get(PROJECT_WORDS)).toBe(wordFile('Brevik # names'))
  })

  test('remove moves words still in the store first, so they can go too', async ($, on) => {
    const world = setup(on, macFinds(), '')
    await startAndCheck($, world)
    world.saved.set('ignored', ['teh', 'tovan'])

    expect(await words($, 'remove teh')).toBe(`removed teh from ${USER_WORDS}`)
    expect(world.saved.has('ignored')).toBe(false)
    expect(world.files.get(USER_WORDS)).toBe(
      wordFile(...USER_WORDS_HEADER, 'tovan'),
    )
  })

  test('a removed word is listed again at the next check', async ($, on) => {
    const world = setup(
      on,
      macFinds(...macIssues('Tovan')),
      'ask Tovan about it',
    )
    world.files.set(USER_WORDS, wordFile('Tovan'))
    await startAndCheck($, world)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /typofix/ })).toBeUndefined()

    await words($, 'remove Tovan')
    world.draft = 'ask Tovan about it again'
    await changeBox($, world.draft, 'history')
    await world.clock.advance(400)
    expect(await band.find({ type: 'Text', text: /^Tovan$/ })).toBeDefined()
  })

  for (const args of ['what', 'add', 'share ', 'remove', 'list Tovan']) {
    test(`"${args}" gets the usage`, async ($, on) => {
      setup(on, macFinds(), '')
      expect(await words($, args)).toMatch(/^usage: \/typo-words/)
    })
  }

  test('a word with no letter, or with a #, is refused and nothing is written', async ($, on) => {
    const world = setup(on, macFinds(), '')
    expect(await words($, 'add Tovan 123 -- #tag a#b')).toBe(
      'not a word: 123, --, #tag, a#b (a word needs a letter, and # starts a comment)',
    )
    expect(await words($, 'remove #tag')).toMatch(/^not a word: #tag /)
    expect(world.files.size).toBe(0)
  })

  test('the list says when it could not read a file, instead of 0 words', async ($, on) => {
    const world = setup(on, macFinds(), '')
    world.files.set(USER_WORDS, wordFile('Tovan'))
    world.unreadable.add(USER_WORDS)

    expect(await words($, '')).toContain(
      `yours, in all your projects: could not read ${USER_WORDS}: EACCES: permission denied, open '${USER_WORDS}'`,
    )
  })

  test('a session in the home folder has no project list, since that file is the user list', async ($, on) => {
    const world = setup(
      on,
      macFinds(...macIssues('Tovan', 'wiht')),
      'ask Tovan about wiht now',
    )
    world.root = '/home/someone'
    world.files.set(USER_WORDS, wordFile('Tovan'))
    await startAndCheck($, world)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /1 typo\b/ })).toBeDefined()
    expect(await words($, '')).toContain(
      'this project: none, since its .claude folder is yours',
    )
    expect(await words($, 'share Brevik')).toBe(
      "no project list here: this project's .claude folder is your own. Use /typo-words add.",
    )
    expect(await words($, 'remove Tovan')).toBe(
      `removed Tovan from ${USER_WORDS}`,
    )
    expect(world.files.get(USER_WORDS)).toBe('')
  })

  test('remove reports each file: a refused one does not hide the change to the other', async ($, on) => {
    const world = setup(on, macFinds(), '')
    world.files.set(USER_WORDS, wordFile('# mine', 'Tovan', 'teh'))
    world.files.set(PROJECT_WORDS, wordFile('Tovan', 'Brevik'))
    world.unreadable.add(PROJECT_WORDS)

    expect(await words($, 'remove Tovan Brevik')).toBe(
      [
        `removed Tovan from ${USER_WORDS}`,
        `could not change ${PROJECT_WORDS}: EACCES: permission denied, open '${PROJECT_WORDS}'`,
      ].join('\n'),
    )
    expect(world.files.get(USER_WORDS)).toBe(wordFile('# mine', 'teh'))
    expect(world.files.get(PROJECT_WORDS)).toBe(wordFile('Tovan', 'Brevik'))
  })

  test('a write the file system refuses gives its reason', async ($, on) => {
    const world = setup(on, macFinds(), '')
    world.isWriteRefused = true
    expect(await words($, 'share Brevik')).toBe(
      'that did not work: the folder is read-only',
    )
  })
})
