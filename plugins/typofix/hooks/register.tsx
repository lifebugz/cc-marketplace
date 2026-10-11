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
  applyChoice,
  buildRewriteRequest,
  decorationsFor,
  diffSplice,
  fixLetter,
  focusShortcut,
  hunspellDictionary,
  isDraft,
  listSignature,
  maskCode,
  mergeSpans,
  offeredSpan,
  parseIspell,
  parseMacResult,
  parseRewriteReply,
  shiftSpans,
  toIspellInput,
  toIssue,
  tokenAt,
  typeaheadRows,
  type Span,
  type Splice,
} from './text'

type RephraseFrom = 'band' | 'command'
type RephraseOutcome =
  { readonly rewrites: readonly string[] } | { readonly reason: string }

interface Backend {
  readonly name: string
  readonly argv: (root: string, language: string) => string[]
  readonly input: (text: string) => string
  readonly parse: (stdout: string, text: string) => Span[] | undefined
}

interface Live {
  language: string
  shortcut: string
  hunspell: string | undefined
  draftText: string
  checkedText: string | undefined
  spans: readonly Span[]
  hasDraft: boolean
  isChecked: boolean
  isOffering: boolean
  hiddenFor: string | undefined
  checkTimer: Timer | undefined
  backend: Backend | null | undefined
  hasWarned: boolean
  rephrase: Rephrase['status']
  rephraseFrom: RephraseFrom
  rephraseSource: string
  rephraseStop: AbortController | undefined
}

const CHECK_DELAY_MS = 400
const SPELL_TIMEOUT_MS = 5000
const TYPEAHEAD_WAIT_MS = 2000
const TYPEAHEAD_POLL_MS = 100
const REPHRASE_TIMEOUT_MS = 20000
const MAX_LISTED = 8
const IGNORED_KEY = 'ignored'
const REWRITE_LABELS = ['fixed', 'natural', 'short']
const IDLE: Rephrase = { status: 'idle' }
const NO_BACKEND =
  'typofix: no spell checker found (Linux: install enchant-2 or hunspell). /rephrase still works.'

const issues = atom({ plugin: 'typofix', key: 'issues' } as const, [])
const isHidden = atom({ plugin: 'typofix', key: 'isHidden' } as const, false)
const hasDraft = atom({ plugin: 'typofix', key: 'hasDraft' } as const, false)
const isChecked = atom({ plugin: 'typofix', key: 'isChecked' } as const, false)
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

const extraBackend = (dictionary: string): Backend => ({
  name: 'hunspell',
  argv: () => hunspellArgv(dictionary),
  input: toIspellInput,
  parse: parseIspell,
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
    parse: parseIspell,
  },
  {
    name: 'hunspell',
    argv: (_, language) => hunspellArgv(language),
    input: toIspellInput,
    parse: parseIspell,
  },
]

const live: Live = {
  language: '',
  shortcut: focusShortcut(undefined),
  hunspell: undefined,
  draftText: '',
  checkedText: undefined,
  spans: [],
  hasDraft: false,
  isChecked: false,
  isOffering: false,
  hiddenFor: undefined,
  checkTimer: undefined,
  backend: undefined,
  hasWarned: false,
  rephrase: 'idle',
  rephraseFrom: 'band',
  rephraseSource: '',
  rephraseStop: undefined,
}

function forgetDraft(): void {
  live.checkTimer?.cancel()
  live.checkTimer = undefined
  live.draftText = ''
  live.checkedText = undefined
  live.spans = []
  live.hasDraft = false
  live.hiddenFor = undefined
}

async function resetState($: EngineInterface): Promise<void> {
  live.rephrase = 'idle'
  live.isChecked = false
  live.isOffering = false
  await update($, issues, () => [])
  await update($, isHidden, () => false)
  await update($, hasDraft, () => false)
  await update($, isChecked, () => false)
  await update($, isOffering, () => false)
  await update($, rephrase, () => IDLE)
}

function offeredAt(text: string, cursor: number): Span | undefined {
  return offeredSpan(live.spans, tokenAt(text, cursor))
}

async function setOffering($: EngineInterface, value: boolean): Promise<void> {
  if (value === live.isOffering) {
    return
  }
  live.isOffering = value
  await update($, isOffering, () => live.isOffering)
}

async function setChecked($: EngineInterface, value: boolean): Promise<void> {
  if (value === live.isChecked) {
    return
  }
  live.isChecked = value
  await update($, isChecked, () => live.isChecked)
}

async function writeIssues(
  $: EngineInterface,
  spans: readonly Span[],
): Promise<void> {
  live.spans = spans
  await update($, issues, () => live.spans.map(toIssue))
}

async function setDraft($: EngineInterface, value: boolean): Promise<void> {
  if (value === live.hasDraft) {
    return
  }
  live.hasDraft = value
  await update($, hasDraft, () => live.hasDraft)
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
  if (live.spans.length !== before.length) {
    await writeIssues($, live.spans)
  }
  await setDraft($, isDraft(text))
  await setChecked($, false)
  await settleRephrase($)
  scheduleCheck($, text)
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
  if (text !== live.draftText) {
    live.spans = shiftSpans(live.spans, diffSplice(live.draftText, text), text)
    live.draftText = text
  }
  await setDraft($, isDraft(text))
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
    if (live.backend === null) {
      await setChecked($, true)
    }
    return
  }
  const ignored = await readIgnored($)
  const fresh = found
    .filter(
      span =>
        !(span.kind === 'spelling' && ignored.has(span.original.toLowerCase())),
    )
    .sort((a, b) => a.start - b.start)

  const again = await $.prompt.read()
  if (again.text !== text) {
    return
  }
  await showIssues($, fresh)
  live.checkedText = text
  await setChecked($, true)
  await setOffering($, offeredAt(text, again.cursor) !== undefined)
  await paintNow($, text)
}

async function paintNow($: EngineInterface, text: string): Promise<void> {
  if (live.spans.length === 0) {
    return
  }
  const box = await $.prompt.read()
  if (box.text !== text || box.cursor !== text.length) {
    return
  }
  await $.prompt.fill({
    text,
    mode: 'replace',
    decorations: decorationsFor(live.spans, offeredAt(text, text.length)),
  })
}

async function showIssues(
  $: EngineInterface,
  spans: readonly Span[],
): Promise<void> {
  if (
    live.hiddenFor !== undefined &&
    listSignature(spans.map(toIssue)) !== live.hiddenFor
  ) {
    live.hiddenFor = undefined
    await update($, isHidden, () => false)
  }
  await writeIssues($, spans)
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

async function checkText(
  $: EngineInterface,
  text: string,
): Promise<Span[] | undefined> {
  const masked = maskCode(text)
  const candidates = candidateBackends()
  for (const candidate of candidates) {
    const found = await runBackend($, candidate, masked)
    if (found === 'unavailable') {
      continue
    }
    live.backend = candidate
    const spans =
      candidate.name === 'osascript' ? await withExtra($, found, masked) : found
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
  found: readonly Span[] | undefined,
  masked: string,
): Promise<readonly Span[] | undefined> {
  if (found === undefined || live.hunspell === undefined) {
    return found
  }
  const extra = await runBackend($, extraBackend(live.hunspell), masked)
  if (extra === 'unavailable' || extra === undefined) {
    $.ui.log(
      `typofix: hunspell -d ${live.hunspell} did not answer; macOS alone checks now`,
      { to: 'debug' },
    )
    live.hunspell = undefined
    return found
  }
  return mergeSpans(found, extra)
}

async function runBackend(
  $: EngineInterface,
  backend: Backend,
  masked: string,
): Promise<Span[] | 'unavailable' | undefined> {
  let ran: ProcessRunResult
  try {
    ran = await $.process.run(backend.argv($.plugin.root, live.language), {
      stdin: backend.input(masked),
      timeoutMs: SPELL_TIMEOUT_MS,
    })
  } catch (error) {
    $.ui.log(`typofix: ${backend.name} did not run: ${String(error)}`, {
      to: 'debug',
    })
    return live.backend === undefined ? 'unavailable' : undefined
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

  const warning = ran.stderr
    .split('\n')
    .find(line => line.startsWith('typofix:'))
  if (warning !== undefined && !live.hasWarned) {
    live.hasWarned = true
    $.ui.toast(warning, { timeoutMs: 8000 })
  }

  const spans = backend.parse(ran.stdout, masked)
  if (spans === undefined) {
    $.ui.log(`typofix: could not read what ${backend.name} printed`, {
      to: 'debug',
    })
  }
  return spans
}

async function readIgnored($: EngineInterface): Promise<Set<string>> {
  const stored = await $.store.get(IGNORED_KEY)
  const words = Array.isArray(stored)
    ? stored.filter((word: unknown): word is string => typeof word === 'string')
    : []
  return new Set(words)
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

  const { system, prompt } = buildRewriteRequest(source)
  const startedAt = await $.clock.now()
  const reply = await $.model.complete(
    {
      model: 'haiku',
      system,
      prompt,
      effort: 'low',
      maxTokens: Math.min(4000, 300 + 2 * source.length),
      timeoutMs: REPHRASE_TIMEOUT_MS,
    },
    { signal: stop.signal },
  )
  const elapsedMs = (await $.clock.now()) - startedAt
  $.ui.log(
    `typofix: haiku took ${String(elapsedMs)} ms, ${String(reply.usage.input_tokens)} tokens in, ${String(reply.usage.output_tokens)} out`,
    { to: 'debug' },
  )

  if (live.rephraseStop !== stop) {
    return { reason: 'cancelled' }
  }
  live.rephraseStop = undefined

  const rewrites = reply.isAnswered ? parseRewriteReply(reply.text) : undefined
  if (rewrites === undefined) {
    const reason = failureOf(reply)
    await setRephrase($, { status: 'failed', reason })
    return { reason }
  }
  await setRephrase($, { status: 'ready', rewrites })
  return { rewrites }
}

function failureOf(reply: ModelCompleteResult): string {
  if (reply.isAnswered) {
    return 'Haiku did not answer with 3 rewrites'
  }
  if (reply.reason === 'api-error') {
    return `Haiku failed (${reply.error})`
  }
  if (reply.reason === 'empty-reply') {
    return 'Haiku sent an empty reply'
  }
  return `Haiku took longer than ${String(REPHRASE_TIMEOUT_MS / 1000)} s`
}

async function rephraseDraft($: EngineInterface): Promise<void> {
  const { text } = await $.prompt.read()
  if (text.trim() === '') {
    return
  }
  await runRephrase($, text, 'band')
}

async function pickChoice(
  $: EngineInterface,
  id: string,
  choice: string,
): Promise<void> {
  const target = live.spans.find(span => span.id === id)
  if (target === undefined) {
    return
  }
  const { text } = await $.prompt.read()
  const rest = live.spans.filter(span => span.id !== id)
  const applied = applyChoice(text, target, choice)
  if (applied === undefined) {
    $.ui.toast('typofix: that word changed; the next check looks again')
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
    $.ui.toast('typofix: the prompt box did not take the fix')
    return
  }
  live.draftText = applied.text
  live.checkedText = applied.text
  await writeIssues($, shifted)
  await setDraft($, isDraft(applied.text))
  await setOffering($, false)
  scheduleCheck($, applied.text)
}

async function pickRewrite($: EngineInterface, rewrite: string): Promise<void> {
  const { text } = await $.prompt.read()
  if (text !== live.rephraseSource && text.trim() !== '') {
    $.ui.toast('typofix: the draft changed; press r again')
    await setRephrase($, IDLE)
    return
  }

  const filled = await $.prompt.fill({ text: rewrite, mode: 'replace' })
  if (!filled.isFilled) {
    $.ui.toast('typofix: the prompt box did not take the rewrite')
    return
  }
  live.draftText = rewrite
  await setRephrase($, IDLE)
  await writeIssues($, [])
  await setDraft($, isDraft(rewrite))
  await setChecked($, false)
  await setOffering($, false)
  scheduleCheck($, rewrite)
}

async function readShortcut($: EngineInterface): Promise<void> {
  const configDir =
    (await $.env.get('CLAUDE_CONFIG_DIR')) ??
    `${(await $.env.get('HOME')) ?? ''}/.claude`
  try {
    live.shortcut = focusShortcut(
      await $.fs.read(`${configDir}/keybindings.json`),
    )
  } catch {
    live.shortcut = focusShortcut(undefined)
  }
}

async function ignoreWord($: EngineInterface, word: string): Promise<void> {
  const lower = word.toLowerCase()
  const ignored = await readIgnored($)
  ignored.add(lower)
  await $.store.set(IGNORED_KEY, [...ignored])
  await writeIssues(
    $,
    live.spans.filter(
      span =>
        !(span.kind === 'spelling' && span.original.toLowerCase() === lower),
    ),
  )
}

async function hideIssues($: EngineInterface): Promise<void> {
  live.hiddenFor = listSignature(live.spans.map(toIssue))
  await update($, isHidden, () => true)
}

export const register: Register = (on, options) => {
  const language = options['language']
  live.language = typeof language === 'string' ? language.trim() : ''
  live.hunspell = hunspellDictionary(options['hunspell'])

  on('session.start', async ($, e, next) => {
    forgetDraft()
    await resetState($)
    await readShortcut($)
    await $.command.register({
      name: 'rephrase',
      description: 'Rewrite a text 3 ways with Haiku: fixed, natural and short',
      argumentHint: '<text>',
    })
    if (e.isInteractive) {
      scheduleCheck($, undefined)
    }
    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    const edited = await next(e)
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
    if (e.text !== live.draftText) {
      await onDraftChange($, diffSplice(live.draftText, e.text), e.text)
    }
    const spans = await checkedSpans($, e.text, next.signal)
    const fixes = spans === undefined ? [] : typeaheadRows(spans, e)
    if (fixes.length === 0) {
      return offered
    }
    await setOffering($, true)
    return { suggestions: [...offered.suggestions, ...fixes] }
  })

  on('prompt.submit', async ($, e, next) => {
    forgetDraft()
    const submitted = await next(e)
    await settleRephrase($)
    await update($, issues, () => [])
    await update($, isHidden, () => false)
    await update($, hasDraft, () => false)
    await setChecked($, false)
    await setOffering($, false)
    return submitted
  })

  on('command.run', { command: 'rephrase' }, async ($, e) => {
    const source = e.args.trim()
    if (source === '') {
      return { text: 'usage: /rephrase <text>' }
    }
    const outcome = await runRephrase($, source, 'command')
    if ('reason' in outcome) {
      return { text: `typofix: ${outcome.reason}` }
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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    const [list, hidden, draft, checked, offering, phrase] = await Promise.all([
      read($, issues),
      read($, isHidden),
      read($, hasDraft),
      read($, isChecked),
      read($, isOffering),
      read($, rephrase),
    ])
    const { Box, Button, Text } = $.ui.resolve(e)
    const header = <Text dimColor>typofix · {live.shortcut}, then a key</Text>

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
              onPress={() => void cancelRephrase($)}
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
              onPress={() => void rephraseDraft($)}
            >
              Try again
            </Button>
            <Button
              key="cancel"
              hotkey="x"
              plain
              onPress={() => void cancelRephrase($)}
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
              onPress={() => void pickRewrite($, rewrite)}
            >
              <Text dimColor>{REWRITE_LABELS[i] ?? ''}:</Text> {rewrite}
            </Button>
          ))}
          <Button
            key="cancel"
            hotkey="x"
            plain
            onPress={() => void cancelRephrase($)}
          >
            Cancel
          </Button>
        </Box>
      )
    }

    if (offering || hidden || (list.length === 0 && !draft)) {
      return next(e)
    }

    if (list.length === 0) {
      if (!checked) {
        return next(e)
      }
      const verdict = live.backend === null ? '' : 'no typos · '
      return (
        <Box columnGap={1}>
          <Text dimColor>
            typofix · {verdict}
            {live.shortcut}, then
          </Text>
          <Button
            key="rephrase"
            hotkey="r"
            plain
            dimColor
            onPress={() => void rephraseDraft($)}
          >
            Rephrase
          </Button>
        </Box>
      )
    }

    const room = Math.max(1, Math.min(MAX_LISTED, e.props.maxRows - 3))
    const shown = list.slice(0, room)
    const width = Math.max(...shown.map(issue => issue.original.length))
    const count = `${String(list.length)} ${list.length === 1 ? 'typo' : 'typos'}`
    let lettered = 0

    return (
      <Box flexDirection="column">
        <Text dimColor>
          typofix · {count} · {live.shortcut}, then a letter
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
                  onPress={() => void pickChoice($, issue.id, choice)}
                >
                  {choice}
                </Button>
              )
            })}
            {issue.kind === 'spelling' ? (
              <Button
                key={`ignore-${String(row + 1)}`}
                plain
                dimColor
                onPress={() => void ignoreWord($, issue.original)}
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
            onPress={() => void rephraseDraft($)}
          >
            Rephrase
          </Button>
          <Button
            key="hide"
            hotkey="x"
            plain
            onPress={() => void hideIssues($)}
          >
            Hide
          </Button>
        </Box>
      </Box>
    )
  })
}
