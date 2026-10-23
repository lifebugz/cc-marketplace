import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  ModelCompleteResult,
  ProcessRunResult,
  Register,
  Timer,
} from 'claude-code'

import type { Rephrase } from '../types'
import {
  addToWordList,
  applyChoice,
  buildRewriteRequest,
  decorationsFor,
  diffSplice,
  fixLetter,
  focusShortcut,
  hunspellDictionary,
  isDictionaryLanguage,
  isWord,
  listedWords,
  listSignature,
  maskCode,
  mergeSpans,
  offeredSpan,
  parseIspell,
  parseMacResult,
  parseRewriteReply,
  parseWordList,
  PROJECT_WORDS_HEADER,
  removeFromWordList,
  shiftSpans,
  toIspellInput,
  toIssue,
  tokenAt,
  typeaheadRows,
  USER_WORDS_HEADER,
  withoutIgnored,
  wordKey,
  writtenWord,
  type Checked,
  type Span,
  type Splice,
} from './text'

type RephraseFrom = 'band' | 'command'
interface RephraseLimits {
  readonly maxTokens: number
  readonly timeoutMs: number
}
type RephraseOutcome =
  { readonly rewrites: readonly string[] } | { readonly reason: string }
type WordLevel = 'user' | 'project'

interface Backend {
  readonly name: string
  readonly argv: (root: string, language: string) => string[]
  readonly input: (text: string) => string
  readonly parse: (stdout: string, text: string) => Checked | undefined
}

interface Live {
  language: string
  shortcut: string
  hunspell: string | undefined
  draftText: string
  edits: number
  edited: string
  checkedText: string | undefined
  spans: readonly Span[]
  isOffering: boolean
  hiddenFor: string | undefined
  checkTimer: Timer | undefined
  backend: Backend | null | undefined
  knownPrograms: Set<string>
  hunspellMisses: number
  hasWarned: boolean
  rephrase: Rephrase['status']
  rephraseFrom: RephraseFrom
  rephraseSource: string
  rephraseStop: AbortController | undefined
  isPanelHost: boolean
  isPanelAttached: boolean
  hasEdits: boolean
  isReading: boolean
  pollTimer: Timer | undefined
  shippedKeys: ReadonlySet<string> | undefined
}

const CHECK_DELAY_MS = 400
// The VS Code panel raises no prompt.edit, so its draft is read on a timer.
const PANEL_ENTRYPOINT = 'claude-vscode'
const PANEL_POLL_MS = 300
// The extension answers an empty box after 4.5 s when the panel is silent.
const PANEL_SILENT_MS = 4000
const SPELL_TIMEOUT_MS = 5000
const MAX_HUNSPELL_MISSES = 3
const ENGINE_OP = /^\$\.[\w.]+(?:\([^)]*\))?:? /
const TIMER_SLACK_MS = 500
const TYPEAHEAD_WAIT_MS = 2000
const TYPEAHEAD_POLL_MS = 100
// Haiku's thinking counts toward the cap too, and it cannot be turned off.
const REPHRASE_MAX_TOKENS = 16000
const REPHRASE_MIN_TIMEOUT_MS = 20000
const REPHRASE_MAX_TIMEOUT_MS = 120000
// Measured on Haiku 5.5: 2.9 ms per reply token and up to 1.9 reply tokens
// per draft character (Japanese); twice that leaves room for a slow reply.
const REPHRASE_MS_PER_CHAR = 2 * 2.9 * 1.9
const MAX_LISTED = 8
// Where ignored words were kept before the word lists; read until moved.
const IGNORED_KEY = 'ignored'
const WORDS_FILE = 'typofix-words.txt'
const ARGUMENT_GAP = /\s+/u
const SHIPPED_WORDS_FILE = 'words.txt'
const MISSING_FILE = /\bENOENT\b/
const WORDS_USAGE = [
  'usage: /typo-words                  list the words typofix never lists as typos',
  '       /typo-words add <word…>      for you, in all your projects',
  '       /typo-words share <word…>    for everyone in this project',
  '       /typo-words remove <word…>   from both lists',
].join('\n')
const REWRITE_LABELS = ['fixed', 'natural', 'short']
const IDLE: Rephrase = { status: 'idle' }
const NO_BACKEND =
  'no spell checker or dictionary found (Linux: install enchant-2 or hunspell and a dictionary such as en_US). /rephrase still works.'
const SCRIPT_WARNING = 'typofix:'
// Only the check requests: a guesses timeout still leaves a right issue list.
const SPELL_SERVER_TIMEOUT = /NSSpellServer dataFromChecking\w* timed out/

const issues = atom({ plugin: 'typofix', key: 'issues' } as const, [])
const isHidden = atom({ plugin: 'typofix', key: 'isHidden' } as const, false)
const isOffering = atom(
  { plugin: 'typofix', key: 'isOffering' } as const,
  false,
)
const rephrase = atom({ plugin: 'typofix', key: 'rephrase' } as const, IDLE)

const withLanguage = (language: string): string[] =>
  language === '' ? [] : ['-d', language]

const hunspellArgv = (language: string): string[] => [
  'hunspell',
  '-a',
  '-i',
  'utf-8',
  ...withLanguage(language),
]

const parseIspellChecked = (stdout: string, text: string): Checked => ({
  spans: parseIspell(stdout, text),
})

const extraBackend = (dictionary: string): Backend => ({
  name: 'hunspell',
  argv: () => hunspellArgv(dictionary),
  input: toIspellInput,
  parse: parseIspellChecked,
})

function candidateBackends(): readonly Backend[] {
  if (live.backend === undefined) {
    return BACKENDS
  }
  return live.backend === null ? [] : [live.backend]
}

const BACKENDS: readonly Backend[] = [
  {
    name: 'osascript',
    argv: (root, language) => [
      'osascript',
      '-l',
      'JavaScript',
      `${root}/scripts/spell-macos.js`,
      language,
    ],
    input: text => text,
    parse: parseMacResult,
  },
  {
    name: 'enchant-2',
    argv: (_, language) => ['enchant-2', '-a', ...withLanguage(language)],
    input: toIspellInput,
    parse: parseIspellChecked,
  },
  {
    name: 'hunspell',
    argv: (_, language) => hunspellArgv(language),
    input: toIspellInput,
    parse: parseIspellChecked,
  },
]

const live: Live = {
  language: '',
  shortcut: focusShortcut(undefined),
  hunspell: undefined,
  draftText: '',
  edits: 0,
  edited: '',
  checkedText: undefined,
  spans: [],
  isOffering: false,
  hiddenFor: undefined,
  checkTimer: undefined,
  backend: undefined,
  knownPrograms: new Set(),
  hunspellMisses: 0,
  hasWarned: false,
  rephrase: 'idle',
  rephraseFrom: 'band',
  rephraseSource: '',
  rephraseStop: undefined,
  isPanelHost: false,
  isPanelAttached: false,
  hasEdits: false,
  isReading: false,
  pollTimer: undefined,
  shippedKeys: undefined,
}

function isPanel(): boolean {
  return live.isPanelAttached && !live.hasEdits
}

function forgetDraft(): void {
  live.checkTimer?.cancel()
  live.checkTimer = undefined
  live.draftText = ''
  live.checkedText = undefined
  live.spans = []
  live.hiddenFor = undefined
}

// Counts what anyone but typofix's own repaints put in the box. The box change
// of a repaint comes back through prompt.autocomplete, so live.draftText
// cannot tell an edit the repaint undid.
function noteEdit(text: string): void {
  live.edits += 1
  live.edited = text
}

// Claude Code can raise a submit at a turn's end, while the box holds the next draft.
function isLateSubmit(text: string): boolean {
  return live.draftText !== '' && live.draftText !== text
}

async function resetState($: EngineInterface): Promise<void> {
  live.rephrase = 'idle'
  live.isOffering = false
  await update($, issues, () => [])
  await update($, isHidden, () => false)
  await update($, isOffering, () => false)
  await update($, rephrase, () => IDLE)
}

function offeredAt(text: string, cursor: number): Span | undefined {
  return offeredSpan(live.spans, tokenAt(text, cursor))
}

async function setOffering($: EngineInterface, offer: boolean): Promise<void> {
  // The panel shows no typeahead rows, so the band never steps aside there.
  const value = offer && !isPanel()
  if (value === live.isOffering) {
    return
  }
  live.isOffering = value
  await update($, isOffering, () => live.isOffering)
}

async function writeIssues(
  $: EngineInterface,
  spans: readonly Span[],
): Promise<void> {
  live.spans = spans
  await update($, issues, () => live.spans.map(toIssue))
}

async function setRephrase($: EngineInterface, value: Rephrase): Promise<void> {
  live.rephrase = value.status
  await update($, rephrase, () => value)
}

function scheduleCheck($: EngineInterface, snapshot: string | undefined): void {
  live.checkTimer?.cancel()
  live.checkTimer = $.clock.after(CHECK_DELAY_MS, () => {
    runSpellCheck($, snapshot).catch((error: unknown) => {
      $.ui.log(`typofix: the check failed: ${String(error)}`, {
        to: 'debug',
      })
    })
  })
}

async function onDraftChange(
  $: EngineInterface,
  edit: Splice,
  text: string,
): Promise<void> {
  const before = live.spans
  live.draftText = text
  live.spans = text.startsWith('/') ? [] : shiftSpans(before, edit, text)
  scheduleCheck($, text)
  if (live.spans.length !== before.length) {
    await writeIssues($, live.spans)
  }
  await settleRephrase($)
}

async function syncDraft($: EngineInterface, text: string): Promise<void> {
  if (text !== live.draftText) {
    await onDraftChange($, diffSplice(live.draftText, text), text)
  }
}

async function settleRephrase($: EngineInterface): Promise<void> {
  if (live.rephrase === 'idle') {
    return
  }
  if (live.rephrase === 'loading' && live.rephraseFrom === 'command') {
    return
  }
  await cancelRephrase($)
}

async function cancelRephrase($: EngineInterface): Promise<void> {
  live.rephraseStop?.abort()
  live.rephraseStop = undefined
  await setRephrase($, IDLE)
}

async function runSpellCheck(
  $: EngineInterface,
  snapshot: string | undefined,
): Promise<void> {
  const { text } = await $.prompt.read()
  if (snapshot !== undefined && text !== snapshot) {
    return
  }
  await readShortcut($)
  if (text !== live.draftText) {
    live.spans = shiftSpans(live.spans, diffSplice(live.draftText, text), text)
    live.draftText = text
  }
  if (text.trim() === '' || text.startsWith('/')) {
    if (live.spans.length > 0) {
      await writeIssues($, [])
    }
    live.checkedText = text
    return
  }

  const found = await checkText($, text)
  if (found === undefined) {
    live.checkedText = text
    return
  }
  const fresh = found.sort((a, b) => a.start - b.start)

  const again = await $.prompt.read()
  if (again.text !== text) {
    return
  }
  const hadSpans = live.spans.length > 0
  await showIssues($, fresh)
  live.checkedText = text
  await setOffering($, offeredAt(text, again.cursor) !== undefined)
  await paintNow($, text, hadSpans)
}

async function paintNow(
  $: EngineInterface,
  text: string,
  hadSpans: boolean,
): Promise<void> {
  // The panel drops decorations, and a fill would move its caret.
  if ((live.spans.length === 0 && !hadSpans) || isPanel()) {
    return
  }
  const box = await $.prompt.read()
  if (box.text !== text || box.cursor !== text.length) {
    return
  }
  const edits = live.edits
  const filled = await $.prompt.fill({
    text,
    mode: 'replace',
    decorations: decorationsFor(live.spans, offeredAt(text, text.length)),
  })
  if (filled.isFilled) {
    await restoreOvertaken($, text, edits)
  }
}

// A fill lands after the edits made while it was on its way, so it can undo
// a key or a paste. Put the last one back once; a second miss stays lost. An
// empty edit is a sent prompt: filling it would wipe the text a dropped prompt
// puts back.
async function restoreOvertaken(
  $: EngineInterface,
  filledText: string,
  editsBefore: number,
): Promise<boolean> {
  const draft = live.edited
  const edits = live.edits
  if (edits === editsBefore || draft === '' || draft === filledText) {
    return false
  }
  const box = await $.prompt.read()
  if (
    live.edits !== edits ||
    box.text !== filledText ||
    box.cursor !== filledText.length
  ) {
    return false
  }
  const spans = shiftSpans(live.spans, diffSplice(live.draftText, draft), draft)
  const offered = offeredSpan(spans, tokenAt(draft, draft.length))
  const filled = await $.prompt.fill({
    text: draft,
    mode: 'replace',
    decorations: decorationsFor(spans, offered),
  })
  if (filled.isFilled) {
    await setOffering($, offered !== undefined)
  }
  return filled.isFilled
}

async function showIssues(
  $: EngineInterface,
  spans: readonly Span[],
): Promise<void> {
  const isNew =
    live.hiddenFor !== undefined &&
    listSignature(spans.map(toIssue)) !== live.hiddenFor
  await writeIssues($, spans)
  if (isNew) {
    live.hiddenFor = undefined
    await update($, isHidden, () => false)
  }
}

async function checkedSpans(
  $: EngineInterface,
  text: string,
  signal: AbortSignal,
): Promise<readonly Span[] | undefined> {
  for (
    let waited = 0;
    waited <= TYPEAHEAD_WAIT_MS;
    waited += TYPEAHEAD_POLL_MS
  ) {
    if (live.draftText !== text) {
      return undefined
    }
    if (live.checkedText === text) {
      return live.spans
    }
    try {
      await $.clock.sleep(TYPEAHEAD_POLL_MS, { signal })
    } catch {
      return undefined
    }
  }
  return undefined
}

// Every engine's result leaves through here, so no backend can skip the word
// lists; they filter the merged spans, so an ignored macOS word never lets an
// overlapping hunspell word in.
async function checkText(
  $: EngineInterface,
  text: string,
): Promise<Span[] | undefined> {
  const ignored = readWordKeys($)
  const spans = await runBackends($, text)
  const keys = await ignored
  return spans === undefined ? undefined : withoutIgnored(spans, keys)
}

async function runBackends(
  $: EngineInterface,
  text: string,
): Promise<Span[] | undefined> {
  const candidates = candidateBackends()
  for (const candidate of candidates) {
    const found = await runBackend($, candidate, text)
    if (found === 'unavailable') {
      continue
    }
    live.backend = candidate
    const spans =
      candidate.name === 'osascript'
        ? await withExtra($, found, text)
        : found?.spans
    return spans?.filter(
      span => text.slice(span.start, span.end) === span.original,
    )
  }
  if (live.backend === undefined) {
    live.backend = null
    $.ui.toast(NO_BACKEND, { timeoutMs: 8000 })
  }
  return undefined
}

async function withExtra(
  $: EngineInterface,
  found: Checked | undefined,
  text: string,
): Promise<readonly Span[] | undefined> {
  if (found === undefined || live.hunspell === undefined) {
    return found?.spans
  }
  if (!isDictionaryLanguage(live.hunspell, live.language, found.guess)) {
    const guess =
      found.guess === undefined
        ? ''
        : ` (macOS reads ${found.guess.language}, ${String(found.guess.confidence)})`
    $.ui.log(
      `typofix: hunspell -d ${live.hunspell} skips a draft in another language${guess}`,
      { to: 'debug' },
    )
    return found.spans
  }
  const extra = await runBackend($, extraBackend(live.hunspell), text)
  if (extra === undefined) {
    live.hunspellMisses += 1
  }
  if (extra === 'unavailable' || live.hunspellMisses >= MAX_HUNSPELL_MISSES) {
    $.ui.log(
      `typofix: hunspell -d ${live.hunspell} is missing or too slow; macOS alone checks now`,
      { to: 'debug' },
    )
    live.hunspell = undefined
    return found.spans
  }
  if (extra === undefined) {
    $.ui.log(
      `typofix: hunspell -d ${live.hunspell} did not answer; macOS alone checks this draft`,
      { to: 'debug' },
    )
    return found.spans
  }
  live.hunspellMisses = 0
  return mergeSpans(found.spans, extra.spans)
}

async function runBackend(
  $: EngineInterface,
  backend: Backend,
  text: string,
  isRetry = false,
): Promise<Checked | 'unavailable' | undefined> {
  const startedAt = await $.clock.now()
  let ran: ProcessRunResult
  try {
    ran = await $.process.run(backend.argv($.plugin.root, live.language), {
      // hunspell loads a dictionary and a word list from its working folder
      // first, so a checker must never run in the opened project.
      cwd: $.plugin.root,
      stdin: backend.input(maskCode(text)),
      timeoutMs: SPELL_TIMEOUT_MS,
    })
  } catch (error) {
    // $.process.run also rejects at the timeout, which proves the program exists.
    const hasStarted =
      (await $.clock.now()) - startedAt >= SPELL_TIMEOUT_MS - TIMER_SLACK_MS
    const willRetry = !hasStarted && !isRetry
    $.ui.log(
      `typofix: ${backend.name} did not ${hasStarted ? 'finish in time' : 'run'}${willRetry ? ' (trying once more)' : ''}: ${String(error)}`,
      { to: 'debug' },
    )
    if (hasStarted) {
      live.knownPrograms.add(backend.name)
      return undefined
    }
    // Claude Code also aborts a run when it cancels the hook call that set the
    // check's timer (Enter cancels a waiting prompt.autocomplete), so a run
    // refused before its timeout is tried once more: a program that cannot
    // start is refused twice.
    if (willRetry) {
      return runBackend($, backend, text, true)
    }
    return live.knownPrograms.has(backend.name) ? undefined : 'unavailable'
  }

  if (ran.exitCode !== 0 && ran.stdout.trim() === '') {
    $.ui.log(
      `typofix: ${backend.name} exited ${String(ran.exitCode)}: ${ran.stderr.split('\n')[0] ?? ''}`,
      {
        to: 'debug',
      },
    )
    return 'unavailable'
  }
  live.knownPrograms.add(backend.name)

  const warning = ran.stderr
    .split('\n')
    .find(line => line.startsWith(SCRIPT_WARNING))
  if (warning !== undefined && !live.hasWarned) {
    live.hasWarned = true
    $.ui.toast(warning.slice(SCRIPT_WARNING.length).trim(), { timeoutMs: 8000 })
  }

  // Parse against the draft itself: masking blanks code next to quotes, and
  // a quote's role must match the text a fix is later applied to.
  const checked = backend.parse(ran.stdout, text)
  if (checked === undefined) {
    $.ui.log(`typofix: could not read what ${backend.name} printed`, {
      to: 'debug',
    })
  }
  if (backend.name !== 'osascript' || !SPELL_SERVER_TIMEOUT.test(ran.stderr)) {
    return checked
  }
  // A spell server that is still starting answers "no typos" with exit 0.
  if (live.draftText !== text) {
    return undefined
  }
  $.ui.log(
    `typofix: the macOS spell server did not answer in time${isRetry ? ' again' : ' (trying once more)'}`,
    { to: 'debug' },
  )
  if (!isRetry) {
    return runBackend($, backend, text, true)
  }
  return checked !== undefined && checked.spans.length > 0 ? checked : undefined
}

async function configDir($: EngineInterface): Promise<string> {
  return (
    (await $.env.get('CLAUDE_CONFIG_DIR')) ??
    `${(await $.env.get('HOME')) ?? ''}/.claude`
  )
}

async function wordsPath(
  $: EngineInterface,
  level: WordLevel,
): Promise<string> {
  return level === 'user'
    ? `${await configDir($)}/${WORDS_FILE}`
    : `${await $.session.root()}/.claude/${WORDS_FILE}`
}

function shippedPath($: EngineInterface): string {
  return `${$.plugin.root}/${SHIPPED_WORDS_FILE}`
}

// Never rejects: a list that cannot be read counts as empty.
async function readWordKeys($: EngineInterface): Promise<ReadonlySet<string>> {
  const [shipped, user, project, legacy] = await Promise.all([
    readShippedKeys($),
    readWordList($, 'user'),
    readWordList($, 'project'),
    readLegacyWords($),
  ])
  return new Set([...shipped, ...user, ...project, ...legacy.map(wordKey)])
}

// The shipped list changes only with a new version, which reloads the module.
async function readShippedKeys(
  $: EngineInterface,
): Promise<ReadonlySet<string>> {
  if (live.shippedKeys !== undefined) {
    return live.shippedKeys
  }
  const text = await readWordFile($, shippedPath($))
  if (text === undefined) {
    return new Set()
  }
  live.shippedKeys = parseWordList(text)
  return live.shippedKeys
}

async function readWordList(
  $: EngineInterface,
  level: WordLevel,
): Promise<ReadonlySet<string>> {
  let path: string
  try {
    path = await wordsPath($, level)
  } catch (error) {
    $.ui.log(`typofix: no path for the ${level} word list: ${String(error)}`, {
      to: 'debug',
    })
    return new Set()
  }
  return parseWordList((await readWordFile($, path)) ?? '')
}

async function readWordFile(
  $: EngineInterface,
  path: string,
): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch (error) {
    if (!MISSING_FILE.test(String(error))) {
      $.ui.log(`typofix: could not read ${path}: ${String(error)}`, {
        to: 'debug',
      })
    }
    return undefined
  }
}

async function readLegacyWords($: EngineInterface): Promise<string[]> {
  try {
    const stored = await $.store.get(IGNORED_KEY)
    return Array.isArray(stored)
      ? stored.filter(
          (word: unknown): word is string => typeof word === 'string',
        )
      : []
  } catch (error) {
    $.ui.log(`typofix: could not read the store: ${String(error)}`, {
      to: 'debug',
    })
    return []
  }
}

// A missing file starts empty; any other failed read stops the edit, so a
// refused read can never lead to a write that drops the words already there.
async function readForEdit($: EngineInterface, path: string): Promise<string> {
  return (await $.fs.exists(path)) ? $.fs.read(path) : ''
}

async function addWords(
  $: EngineInterface,
  level: WordLevel,
  words: readonly string[],
): Promise<{ path: string; added: string[] }> {
  const path = await wordsPath($, level)
  const header = level === 'user' ? USER_WORDS_HEADER : PROJECT_WORDS_HEADER
  const edited = addToWordList(await readForEdit($, path), words, header)
  if (edited.added.length > 0) {
    await $.fs.write(path, edited.text)
  }
  return { path, added: edited.added }
}

async function removeWords(
  $: EngineInterface,
  level: WordLevel,
  keys: ReadonlySet<string>,
): Promise<{ path: string; removed: string[] }> {
  const path = await wordsPath($, level)
  const text = await readForEdit($, path)
  const edited = removeFromWordList(text, keys)
  if (edited.removed.length > 0) {
    await $.fs.write(path, edited.text)
  }
  return { path, removed: edited.removed }
}

async function moveLegacyWords($: EngineInterface): Promise<void> {
  const words = await readLegacyWords($)
  if (words.length === 0) {
    return
  }
  const { path, added } = await addWords($, 'user', words)
  await $.store.delete(IGNORED_KEY)
  $.ui.log(
    `typofix: moved ${String(added.length)} ignored words from the store to ${path}`,
    { to: 'debug' },
  )
}

async function runRephrase(
  $: EngineInterface,
  source: string,
  from: RephraseFrom,
): Promise<RephraseOutcome> {
  live.rephraseStop?.abort()
  const stop = new AbortController()
  live.rephraseStop = stop
  live.rephraseFrom = from
  live.rephraseSource = source
  await setRephrase($, { status: 'loading' })

  const limits = rephraseLimits(source)
  const reply = await askHaiku($, source, limits, stop.signal)
  if (live.rephraseStop !== stop) {
    return { reason: 'cancelled' }
  }
  live.rephraseStop = undefined

  const rewrites =
    typeof reply !== 'string' && reply.isAnswered
      ? parseRewriteReply(reply.text)
      : undefined
  if (rewrites === undefined) {
    const reason = typeof reply === 'string' ? reply : failureOf(reply, limits)
    await setRephrase($, { status: 'failed', reason })
    return { reason }
  }
  await setRephrase($, { status: 'ready', rewrites })
  return { rewrites }
}

function rephraseLimits(source: string): RephraseLimits {
  const seconds = Math.ceil(
    (REPHRASE_MIN_TIMEOUT_MS + source.length * REPHRASE_MS_PER_CHAR) / 1000,
  )
  return {
    maxTokens: REPHRASE_MAX_TOKENS,
    timeoutMs: Math.min(REPHRASE_MAX_TIMEOUT_MS, seconds * 1000),
  }
}

async function askHaiku(
  $: EngineInterface,
  source: string,
  limits: RephraseLimits,
  signal: AbortSignal,
): Promise<ModelCompleteResult | string> {
  const { system, prompt } = buildRewriteRequest(source)
  const startedAt = await $.clock.now()
  let reply: ModelCompleteResult
  try {
    reply = await $.model.complete(
      {
        model: 'haiku',
        system,
        prompt,
        effort: 'low',
        ...limits,
      },
      { signal },
    )
  } catch (error) {
    return `Haiku could not run (${reasonOf(error, $.plugin.name)})`
  }
  const elapsedMs = (await $.clock.now()) - startedAt
  $.ui.log(
    `typofix: haiku took ${String(elapsedMs)} ms, ${String(reply.usage.input_tokens)} tokens in, ${String(reply.usage.output_tokens)} out`,
    { to: 'debug' },
  )
  return reply
}

function failureOf(reply: ModelCompleteResult, limits: RephraseLimits): string {
  const cutOff = `Haiku's reply was cut off at ${String(limits.maxTokens)} tokens (the draft may be too long)`
  const isCutOff = reply.usage.output_tokens >= limits.maxTokens
  if (reply.isAnswered) {
    return isCutOff ? cutOff : 'Haiku did not answer with 3 rewrites'
  }
  if (reply.reason === 'api-error') {
    return `Haiku failed (${reply.error})`
  }
  if (reply.reason === 'empty-reply') {
    return isCutOff ? cutOff : 'Haiku sent an empty reply'
  }
  return `Haiku took longer than ${String(limits.timeoutMs / 1000)} s`
}

async function rephraseDraft($: EngineInterface): Promise<void> {
  const { text } = await $.prompt.read()
  if (text.trim() === '') {
    return
  }
  // In the panel the draft copy can trail the box; a later read of this same
  // text must not count as an edit that cancels the rewrite.
  await syncDraft($, text)
  await runRephrase($, text, 'band')
}

async function retryRephrase($: EngineInterface): Promise<void> {
  await runRephrase($, live.rephraseSource, live.rephraseFrom)
}

function press($: EngineInterface, action: Promise<void>): void {
  action.catch((error: unknown) => {
    $.ui.log(`typofix: a band key failed: ${String(error)}`, { to: 'debug' })
    $.ui.toast(`that did not work: ${reasonOf(error, $.plugin.name)}`)
  })
}

// Claude Code words a refused call as `<plugin>: $.<op>: <reason>`.
function reasonOf(error: unknown, plugin: string): string {
  const message = error instanceof Error ? error.message : String(error)
  const rest = message.startsWith(`${plugin}: `)
    ? message.slice(plugin.length + 2)
    : message
  return rest.replace(ENGINE_OP, '')
}

async function pickChoice(
  $: EngineInterface,
  id: string,
  choice: string,
): Promise<void> {
  const { text } = await $.prompt.read()
  await syncDraft($, text)
  const target = live.spans.find(span => span.id === id)
  if (target === undefined) {
    $.ui.toast('that word changed; the next check looks again')
    return
  }
  const rest = live.spans.filter(span => span.id !== id)
  const applied = applyChoice(text, target, choice)
  if (applied === undefined) {
    $.ui.toast('that word changed; the next check looks again')
    await writeIssues($, rest)
    return
  }

  const shifted = shiftSpans(rest, applied.splice, applied.text)
  const filled = await $.prompt.fill({
    text: applied.text,
    mode: 'replace',
    decorations: decorationsFor(shifted),
  })
  if (!filled.isFilled) {
    $.ui.toast('the prompt box did not take the fix')
    return
  }
  // The box change of the fill itself may have synced the draft already.
  if (live.draftText !== text && live.draftText !== applied.text) {
    return
  }
  noteEdit(applied.text)
  live.draftText = applied.text
  live.checkedText = applied.text
  await writeIssues($, shifted)
  await setOffering($, false)
  scheduleCheck($, applied.text)
}

async function pickRewrite($: EngineInterface, rewrite: string): Promise<void> {
  const { text } = await $.prompt.read()
  if (text !== live.rephraseSource && text.trim() !== '') {
    $.ui.toast('the draft changed; press r again')
    await setRephrase($, IDLE)
    return
  }

  const before = live.draftText
  const filled = await $.prompt.fill({ text: rewrite, mode: 'replace' })
  if (!filled.isFilled) {
    $.ui.toast('the prompt box did not take the rewrite')
    return
  }
  if (live.draftText !== before && live.draftText !== rewrite) {
    return
  }
  noteEdit(rewrite)
  live.draftText = rewrite
  await setRephrase($, IDLE)
  await writeIssues($, [])
  await setOffering($, false)
  scheduleCheck($, rewrite)
}

async function readShortcut($: EngineInterface): Promise<void> {
  const dir = await configDir($)
  try {
    live.shortcut = focusShortcut(await $.fs.read(`${dir}/keybindings.json`))
  } catch {
    // A failed read keeps the key shown so far, which starts as the default.
  }
}

async function ignoreWord($: EngineInterface, word: string): Promise<void> {
  await addWords($, 'user', [word])
  const { text } = await $.prompt.read()
  await syncDraft($, text)
  const rest = withoutIgnored(live.spans, new Set([wordKey(word)]))
  if (rest.length === live.spans.length) {
    return
  }
  const offered = offeredSpan(rest, tokenAt(text, text.length))
  live.spans = rest
  if (isPanel()) {
    await writeIssues($, live.spans)
    return
  }
  // A key typed since the read would be lost to the fill; its prompt.edit
  // paints the spans instead.
  const box = await $.prompt.read()
  const edits = live.edits
  const isFilled =
    box.text === text &&
    (
      await $.prompt.fill({
        text,
        mode: 'replace',
        decorations: decorationsFor(rest, offered),
      })
    ).isFilled
  if (isFilled && !(await restoreOvertaken($, text, edits))) {
    await setOffering($, offered !== undefined)
  }
  await writeIssues($, live.spans)
}

async function pollPanel($: EngineInterface): Promise<void> {
  if (!isPanel() || live.isReading) {
    return
  }
  live.isReading = true
  try {
    const startedAt = await $.clock.now()
    const { text } = await $.prompt.read()
    const isSilent =
      text === '' && (await $.clock.now()) - startedAt >= PANEL_SILENT_MS
    if (!isSilent) {
      await syncDraft($, text)
    }
  } finally {
    live.isReading = false
  }
}

// Asked, not counted from session.attach: a module loaded after the panel
// attached (a reload or an enable) hears no attach.
async function readPanelAttached($: EngineInterface): Promise<void> {
  live.isPanelAttached = (await $.session.surfaces()).includes('vscode')
}

function stopPanelPoll(): void {
  live.pollTimer?.cancel()
  live.pollTimer = undefined
}

// The timer runs only while a panel shows this session: switching to another
// conversation in the panel detaches it.
function syncPanelPoll($: EngineInterface): void {
  if (!isPanel()) {
    stopPanelPoll()
    return
  }
  live.pollTimer ??= $.clock.every(PANEL_POLL_MS, () => {
    pollPanel($).catch((error: unknown) => {
      $.ui.log(`typofix: reading the panel's draft failed: ${String(error)}`, {
        to: 'debug',
      })
    })
  })
}

async function hideIssues($: EngineInterface): Promise<void> {
  live.hiddenFor = listSignature(live.spans.map(toIssue))
  await update($, isHidden, () => true)
}

async function runWordsCommand(
  $: EngineInterface,
  args: string,
): Promise<string> {
  const [action = '', ...words] = args.trim().split(ARGUMENT_GAP)
  const isEdit = action === 'add' || action === 'share' || action === 'remove'
  if (action !== '' && (!isEdit || words.length === 0)) {
    return WORDS_USAGE
  }
  const notWords = words.filter(word => !isWord(writtenWord(word)))
  if (notWords.length > 0) {
    return `a word needs a letter: ${notWords.join(', ')}`
  }
  try {
    if (action === '') {
      return await listWords($)
    }
    return action === 'remove'
      ? await removeCommand($, words)
      : await addCommand($, action === 'add' ? 'user' : 'project', words)
  } catch (error) {
    return `that did not work: ${reasonOf(error, $.plugin.name)}`
  }
}

async function listWords($: EngineInterface): Promise<string> {
  const shipped = shippedPath($)
  const user = await wordsPath($, 'user')
  const project = await wordsPath($, 'project')
  const legacy = await readLegacyWords($)
  return [
    'typofix never lists these words as typos, in every spell checker:',
    describeList(
      'ships with typofix',
      shipped,
      listedWords((await readWordFile($, shipped)) ?? ''),
    ),
    describeList(
      'yours, in all your projects',
      user,
      listedWords((await readWordFile($, user)) ?? ''),
    ),
    describeList(
      'this project, for everyone who commits the file',
      project,
      listedWords((await readWordFile($, project)) ?? ''),
    ),
    ...(legacy.length > 0
      ? [`still in the store, moved at the next start: ${legacy.join(', ')}`]
      : []),
  ].join('\n')
}

function describeList(
  name: string,
  path: string,
  words: readonly string[],
): string {
  const count = `${String(words.length)} ${words.length === 1 ? 'word' : 'words'}`
  const list = words.length > 0 ? `\n  ${words.join(', ')}` : ''
  return `${name}: ${count} in ${path}${list}`
}

async function addCommand(
  $: EngineInterface,
  level: WordLevel,
  words: readonly string[],
): Promise<string> {
  const shipped = await readShippedKeys($)
  const asked = listedWords(words.join('\n'))
  const isShipped = (word: string): boolean => shipped.has(wordKey(word))
  const { path, added } = await addWords(
    $,
    level,
    asked.filter(word => !isShipped(word)),
  )
  const isAdded = (word: string): boolean =>
    added.some(other => wordKey(other) === wordKey(word))
  const already = asked.filter(word => !isShipped(word) && !isAdded(word))
  return [
    ...(added.length > 0 ? [`added ${added.join(', ')} to ${path}`] : []),
    ...(level === 'project' && added.length > 0
      ? ['Commit the file to share it.']
      : []),
    ...(already.length > 0
      ? [`already in ${path}: ${already.join(', ')}`]
      : []),
    ...asked.filter(isShipped).map(word => `${word} ships with typofix`),
  ].join('\n')
}

async function removeCommand(
  $: EngineInterface,
  words: readonly string[],
): Promise<string> {
  // A word still in the store would stay ignored after its line is gone.
  await moveLegacyWords($)
  const asked = listedWords(words.join('\n'))
  const keys = new Set(asked.map(wordKey))
  const shipped = await readShippedKeys($)
  const edits = [
    await removeWords($, 'user', keys),
    await removeWords($, 'project', keys),
  ]
  const removed = new Set(edits.flatMap(edit => edit.removed).map(wordKey))
  const missing = asked.filter(
    word => !removed.has(wordKey(word)) && !shipped.has(wordKey(word)),
  )
  return [
    ...edits
      .filter(edit => edit.removed.length > 0)
      .map(edit => `removed ${edit.removed.join(', ')} from ${edit.path}`),
    ...asked
      .filter(word => shipped.has(wordKey(word)))
      .map(word => `${word} ships with typofix, so it stays ignored`),
    ...(missing.length > 0 ? [`not in your lists: ${missing.join(', ')}`] : []),
  ].join('\n')
}

export const register: Register = (on, options) => {
  const language = options['language']
  live.language = typeof language === 'string' ? language.trim() : ''
  live.hunspell = hunspellDictionary(options['hunspell'])

  on('session.start', async ($, e, next) => {
    forgetDraft()
    live.shippedKeys = undefined
    await resetState($)
    await readShortcut($)
    // The store key goes only once the words are in the file, so a failed
    // move loses nothing: the check reads the store too until then.
    await moveLegacyWords($).catch((error: unknown) => {
      $.ui.log(`typofix: could not move the ignored words: ${String(error)}`, {
        to: 'debug',
      })
    })
    await $.command.register({
      name: 'rephrase',
      description: 'Rewrite a text 3 ways with Haiku: fixed, natural and short',
      argumentHint: '<text>',
    })
    await $.command.register({
      name: 'typo-words',
      description: 'List, add or remove the words typofix never lists as typos',
      argumentHint: '[add|share|remove <word…>]',
    })
    if (e.isInteractive) {
      scheduleCheck($, undefined)
    } else if (
      (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === PANEL_ENTRYPOINT
    ) {
      live.isPanelHost = true
      stopPanelPoll()
      await readPanelAttached($)
      syncPanelPoll($)
    }
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    if (live.isPanelHost) {
      await readPanelAttached($)
      syncPanelPoll($)
    }
    return attached
  })

  on('session.detach', async ($, e, next) => {
    const detached = await next(e)
    if (live.isPanelHost) {
      await readPanelAttached($)
      syncPanelPoll($)
    }
    return detached
  })

  on('prompt.edit', async ($, e, next) => {
    live.hasEdits = true
    stopPanelPoll()
    await syncDraft($, e.text)
    const edited = await next(e)
    noteEdit(edited.text)
    if (edited.text !== e.text) {
      await onDraftChange($, e, edited.text)
    }
    const offered = offeredAt(edited.text, edited.cursor)
    await setOffering($, offered !== undefined)
    return {
      ...edited,
      decorations: [
        ...(edited.decorations ?? []),
        ...decorationsFor(live.spans, offered),
      ],
    }
  })

  on('prompt.autocomplete', async ($, e, next) => {
    const offered = await next(e)
    if (e.text.startsWith('/')) {
      return offered
    }
    await syncDraft($, e.text)
    const spans = await checkedSpans($, e.text, next.signal)
    const fixes = spans === undefined ? [] : typeaheadRows(spans, e)
    if (fixes.length === 0) {
      return offered
    }
    await setOffering($, true)
    return { suggestions: [...offered.suggestions, ...fixes] }
  })

  on('prompt.change', async ($, e, next) => {
    if (e.origin.kind !== 'plugin' || e.origin.name !== $.plugin.name) {
      noteEdit(e.text)
      await syncDraft($, e.text)
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // The panel's draft copy can trail its box by one read, so a panel send
    // is never judged late; the next read checks whatever the box holds.
    const isPanelSend = isPanel() && e.origin.kind === 'sdk'
    if (
      !isPanelSend &&
      (e.origin.kind !== 'composer' || isLateSubmit(e.text))
    ) {
      return next(e)
    }
    const isDraftSent = live.draftText === e.text
    forgetDraft()
    noteEdit('')
    // A late submit while the box is empty must not close /rephrase's rewrites.
    if (isDraftSent) {
      await settleRephrase($)
    }
    await update($, issues, () => live.spans.map(toIssue))
    await update($, isHidden, () => false)
    await setOffering($, false)
    return next(e)
  })

  on('command.run', { command: 'rephrase' }, async ($, e) => {
    const source = e.args.trim()
    if (source === '') {
      return { text: 'usage: /rephrase <text>' }
    }
    const outcome = await runRephrase($, source, 'command')
    if ('reason' in outcome) {
      return { text: outcome.reason }
    }
    return {
      text: outcome.rewrites
        .map(
          (rewrite, i) =>
            `${String(i + 1)} ${REWRITE_LABELS[i] ?? ''}: ${rewrite}`,
        )
        .join('\n'),
    }
  })

  on('command.run', { command: 'typo-words' }, async ($, e) => ({
    text: await runWordsCommand($, e.args),
  }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    const [list, hidden, offering, phrase] = await Promise.all([
      read($, issues),
      read($, isHidden),
      read($, isOffering),
      read($, rephrase),
    ])
    const { Box, Button, Text } = $.ui.resolve(e)
    const isClicked = e.surface === 'vscode'
    const header = (
      <Text dimColor>
        typofix{isClicked ? '' : ` · ${live.shortcut}, then a key`}
      </Text>
    )

    if (phrase.status === 'loading') {
      return (
        <Box flexDirection="column">
          {header}
          <Box columnGap={2}>
            <Text>Haiku is rewriting the draft…</Text>
            <Button
              key="cancel"
              hotkey="x"
              plain
              onPress={() => {
                press($, cancelRephrase($))
              }}
            >
              Cancel
            </Button>
          </Box>
        </Box>
      )
    }

    if (phrase.status === 'failed') {
      return (
        <Box flexDirection="column">
          {header}
          <Box columnGap={2} flexWrap="wrap">
            <Text color="error">{phrase.reason}</Text>
            <Button
              key="rephrase"
              hotkey="r"
              plain
              onPress={() => {
                press($, retryRephrase($))
              }}
            >
              Try again
            </Button>
            <Button
              key="cancel"
              hotkey="x"
              plain
              onPress={() => {
                press($, cancelRephrase($))
              }}
            >
              Close
            </Button>
          </Box>
        </Box>
      )
    }

    if (phrase.status === 'ready') {
      return (
        <Box flexDirection="column">
          {header}
          {phrase.rewrites.map((rewrite, i) => (
            <Button
              key={`rewrite-${String(i + 1)}`}
              hotkey={String(i + 1)}
              plain
              onPress={() => {
                press($, pickRewrite($, rewrite))
              }}
            >
              <Text dimColor>{REWRITE_LABELS[i] ?? ''}:</Text> {rewrite}
            </Button>
          ))}
          <Button
            key="cancel"
            hotkey="x"
            plain
            onPress={() => {
              press($, cancelRephrase($))
            }}
          >
            Cancel
          </Button>
        </Box>
      )
    }

    if (offering || hidden || list.length === 0) {
      return next(e)
    }

    const room = Math.max(1, Math.min(MAX_LISTED, e.props.maxRows - 3))
    const shown = list.slice(0, room)
    const width = Math.max(...shown.map(issue => issue.original.length))
    const count = `${String(list.length)} ${list.length === 1 ? 'typo' : 'typos'}`
    let lettered = 0

    return (
      <Box flexDirection="column">
        <Text dimColor>
          typofix · {count} ·{' '}
          {isClicked ? 'click a fix' : `${live.shortcut}, then a letter`}
        </Text>
        {shown.map((issue, row) => (
          <Box key={`issue-${String(row + 1)}`} columnGap={2}>
            <Text color={issue.kind === 'spelling' ? 'error' : 'warning'}>
              {issue.original.padEnd(width)}
            </Text>
            {issue.choices.length === 0 && <Text dimColor>no suggestions</Text>}
            {issue.choices.map((choice, n) => {
              const hotkey = fixLetter(lettered++)
              return (
                <Button
                  key={`fix-${String(row + 1)}-${String(n + 1)}`}
                  {...(hotkey === undefined ? {} : { hotkey })}
                  plain
                  onPress={() => {
                    press($, pickChoice($, issue.id, choice))
                  }}
                >
                  {choice}
                </Button>
              )
            })}
            {issue.kind === 'spelling' ? (
              <Button
                key={`ignore-${String(row + 1)}`}
                hotkey={String(row + 1)}
                plain
                dimColor
                onPress={() => {
                  press($, ignoreWord($, issue.original))
                }}
              >
                ignore
              </Button>
            ) : (
              <Text dimColor>grammar</Text>
            )}
          </Box>
        ))}
        {list.length > shown.length && (
          <Text dimColor>and {String(list.length - shown.length)} more</Text>
        )}
        <Box columnGap={2}>
          <Button
            key="rephrase"
            hotkey="r"
            plain
            onPress={() => {
              press($, rephraseDraft($))
            }}
          >
            Rephrase
          </Button>
          <Button
            key="hide"
            hotkey="x"
            plain
            onPress={() => {
              press($, hideIssues($))
            }}
          >
            Hide
          </Button>
        </Box>
      </Box>
    )
  })
}
