import { atom, read, update } from 'claude-code'
import type {
  ClassicEventOf,
  EngineInterface,
  Register,
  Timer,
} from 'claude-code'

import type { Row } from '../types'
import { RUN_TIMEOUT_MS, SWITCH_TIMEOUT_MS, switchTo, type Io } from './hosts'
import {
  buildNameRequest,
  isTypedPrompt,
  parseName,
  TYPED_ORIGINS,
  wantsName,
} from './naming'
import { Caches, readWorld, type WorldIo } from './refresh'
import {
  assignKeys,
  baseName,
  buildRows,
  cut,
  formatRow,
  headerOf,
  TITLE_COLUMN,
} from './sessions'

type SwitchRow = Extract<Row, { kind: 'switch' }>

const PANE = 'sessionz'
const REFRESH_MS = 3000
const NAME_WAIT_MS = 2000
const NAME_TIMEOUT_MS = 10_000
const TYPED_KEPT = 20
const ERROR_TOAST_MS = 8000
/** The terminal draws a plain Button with a hotkey as `1: label`. */
const HOTKEY_WIDTH = 3
const WIDE_PANE = 60

const rowsState = atom({ plugin: 'sessionz', key: 'rows' } as const, [])
const keysState = atom({ plugin: 'sessionz', key: 'keys' } as const, {})
const refreshedState = atom(
  { plugin: 'sessionz', key: 'refreshedAt' } as const,
  null,
)
const errorState = atom({ plugin: 'sessionz', key: 'error' } as const, null)

interface Live {
  autoName: boolean
  timer: Timer | undefined
  isRefreshing: boolean
  isSwitching: boolean
  shownRows: string
  shownKeys: string
  shownError: string | null | undefined
  readonly caches: Caches
  readonly naming: Map<string, Promise<string | undefined>>
  /** The texts of the last prompts the person typed, newest last. */
  typed: string[]
}

const live: Live = {
  autoName: true,
  timer: undefined,
  isRefreshing: false,
  isSwitching: false,
  shownRows: '',
  shownKeys: '',
  shownError: undefined,
  caches: new Caches(),
  naming: new Map(),
  typed: [],
}

const namedKey = (sessionId: string): string => `named:${sessionId}`
const pendingKey = (sessionId: string): string => `pendingName:${sessionId}`

function debug($: EngineInterface, text: string): void {
  $.ui.log(text, { to: 'debug' })
}

function ioOf($: EngineInterface, timeoutMs: number): Io {
  const io: Io = {
    run: async argv => {
      try {
        return await $.process.run(argv, { timeoutMs })
      } catch (error) {
        return `${argv[0] ?? ''} did not run: ${String(error)}`
      }
    },
    sleep: async ms => $.clock.sleep(ms),
    root: $.plugin.root,
  }
  return io
}

async function worldIoOf($: EngineInterface): Promise<WorldIo> {
  const home = (await $.env.get('HOME')) ?? ''
  const io: WorldIo = {
    ...ioOf($, RUN_TIMEOUT_MS),
    home,
    selfId: await $.session.id(),
    canSwitch: async () => $.fs.exists('/usr/bin/osascript'),
    extensions: async () => {
      if (home === '') {
        return []
      }
      try {
        const entries = await $.fs.list(`${home}/.vscode/extensions`)
        return entries.map(entry => entry.name)
      } catch {
        return []
      }
    },
    debug: text => {
      debug($, text)
    },
  }
  return io
}

async function showError(
  $: EngineInterface,
  error: string | null,
): Promise<void> {
  if (error === live.shownError) {
    return
  }
  live.shownError = error
  await update($, errorState, () => error)
}

async function refresh($: EngineInterface): Promise<void> {
  if (live.isRefreshing) {
    return
  }
  live.isRefreshing = true
  try {
    const world = await readWorld(await worldIoOf($), live.caches)
    if (typeof world === 'string') {
      debug($, world)
      await showError($, world)
      return
    }
    const rows = buildRows(world)
    const keys = assignKeys(await read($, keysState), rows)
    await showError($, null)
    const shownRows = JSON.stringify(rows)
    if (shownRows !== live.shownRows) {
      live.shownRows = shownRows
      const now = await $.clock.now()
      await update($, rowsState, () => rows)
      await update($, refreshedState, () => now)
    }
    const shownKeys = JSON.stringify(keys)
    if (shownKeys !== live.shownKeys) {
      live.shownKeys = shownKeys
      await update($, keysState, () => keys)
    }
  } catch (error) {
    debug($, `refresh failed: ${String(error)}`)
  } finally {
    live.isRefreshing = false
  }
}

async function startPolling($: EngineInterface): Promise<void> {
  live.timer ??= $.clock.every(REFRESH_MS, () => {
    void refresh($)
  })
  return refresh($)
}

function stopPolling(): void {
  live.timer?.cancel()
  live.timer = undefined
}

async function switchRow($: EngineInterface, row: SwitchRow): Promise<void> {
  if (live.isSwitching) {
    return
  }
  live.isSwitching = true
  try {
    const result = await switchTo(ioOf($, SWITCH_TIMEOUT_MS), row.target)
    if (!result.ok) {
      $.ui.toast(result.message, { timeoutMs: ERROR_TOAST_MS })
      return
    }
    if (result.note !== null) {
      $.ui.toast(result.note)
    }
    if (row.target.kind === 'ghostty-tty' && result.terminalId !== null) {
      live.caches.remembered.set(row.target.tty, result.terminalId)
      await refresh($)
    }
  } finally {
    live.isSwitching = false
  }
}

async function within<T>(
  $: EngineInterface,
  task: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  const stop = new AbortController()
  const timeout = $.clock.sleep(ms, { signal: stop.signal }).then(
    () => undefined,
    () => undefined,
  )
  try {
    return await Promise.race([task, timeout])
  } finally {
    stop.abort()
  }
}

async function askName(
  $: EngineInterface,
  sessionId: string,
  prompt: string,
  folder: string,
): Promise<string | undefined> {
  let name: string | undefined
  try {
    const reply = await $.model.complete({
      model: 'haiku',
      effort: 'low',
      maxTokens: 40,
      timeoutMs: NAME_TIMEOUT_MS,
      ...buildNameRequest(prompt, folder),
    })
    if (!reply.isAnswered) {
      debug($, `Haiku gave no name: ${reply.reason}`)
    } else {
      name = parseName(reply.text)
      if (name === undefined) {
        debug($, `dropped Haiku's name reply: ${cut(reply.text, 80)}`)
      }
    }
  } catch (error) {
    debug($, `the Haiku call was refused: ${String(error)}`)
  }
  live.naming.delete(sessionId)
  if (name !== undefined) {
    await $.store.set(pendingKey(sessionId), name)
  }
  return name
}

async function markNamed($: EngineInterface, sessionId: string): Promise<void> {
  await $.store.set(namedKey(sessionId), true)
  await $.store.delete(pendingKey(sessionId))
}

/**
 * Waits for Haiku at most NAME_WAIT_MS; a later answer is kept as a pending
 * name that the session's next prompt sets with no wait.
 */
async function nameFor(
  $: EngineInterface,
  e: Readonly<
    Pick<
      ClassicEventOf['classic.UserPromptSubmit'],
      'cwd' | 'prompt' | 'session_id' | 'session_title' | 'source'
    >
  >,
): Promise<string | undefined> {
  const isTyped = isTypedPrompt(e.source, e.prompt, live.typed)
  const check = { isTyped, prompt: e.prompt, sessionTitle: e.session_title }
  if (!wantsName(check)) {
    if (!isTyped) {
      debug($, `naming skipped: not typed (source ${String(e.source)})`)
    }
    return undefined
  }
  const sessionId = e.session_id
  if ((await $.store.get(namedKey(sessionId))) === true) {
    return undefined
  }
  const pending = await $.store.get(pendingKey(sessionId))
  if (typeof pending === 'string') {
    await markNamed($, sessionId)
    return pending
  }
  const asked =
    live.naming.get(sessionId) ??
    askName($, sessionId, e.prompt, baseName(e.cwd))
  live.naming.set(sessionId, asked)
  const name = await within($, asked, NAME_WAIT_MS)
  if (name === undefined) {
    return undefined
  }
  await markNamed($, sessionId)
  return name
}

function remember(text: string): void {
  live.typed = [...live.typed, text].slice(-TYPED_KEPT)
}

export const register: Register = (on, options) => {
  const autoName = options['autoName']
  live.autoName = typeof autoName === 'boolean' ? autoName : true

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tabs',
      description: 'Show every Claude Code session and switch to its tab',
    })
    const panes = await $.ui.panes()
    if (panes.some(pane => pane.id === PANE)) {
      void startPolling($)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    stopPolling()
    const sessionId = await $.session.id()
    await $.store.delete(namedKey(sessionId))
    await $.store.delete(pendingKey(sessionId))
    return next(e)
  })

  on('command.run', { command: 'tabs' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Sessions', focus: true })
    if (!opened.isPlaced) {
      return { text: `sessionz: the pane did not open: ${opened.reason}` }
    }
    await startPolling($)
    return {}
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    stopPolling()
    live.shownKeys = JSON.stringify({})
    await update($, keysState, () => ({}))
    return closed
  }).catch(async (_$, e, next) => next(e))

  on('prompt.submit', async (_$, e, next) => {
    const isTyped = TYPED_ORIGINS.includes(e.origin.kind)
    // The UserPromptSubmit hooks run inside next(e), so the text is
    // remembered before it; a rewrite from a hook beneath is added after.
    if (isTyped) {
      remember(e.text)
    }
    const submitted = await next(e)
    if (isTyped && submitted.drop === undefined && submitted.text !== e.text) {
      remember(submitted.text)
    }
    return submitted
  }).catch(async (_$, e, next) => next(e))

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e)
    if (!live.autoName || result.sessionTitle !== undefined) {
      return result
    }
    const name = await nameFor($, e)
    return name === undefined ? result : { ...result, sessionTitle: name }
  }).catch(async (_$, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [rows, keys, error] = await Promise.all([
      read($, rowsState),
      read($, keysState),
      read($, errorState),
    ])
    const { Box, Button, Text } = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    const indent = ' '.repeat(
      HOTKEY_WIDTH + (columns >= WIDE_PANE ? TITLE_COLUMN : 2),
    )
    const widths = {
      label: Math.max(10, columns - HOTKEY_WIDTH),
      detail: Math.max(10, columns - indent.length),
    }

    return (
      <Box flexDirection="column">
        <Text bold>{cut(headerOf(rows), columns)}</Text>
        {error !== null && <Text color="error">{cut(error, columns)}</Text>}
        {rows.length === 0 && error === null && (
          <Text dimColor>Reading sessions…</Text>
        )}
        {rows.map(row => {
          const text = formatRow(row, widths)
          const hotkey = keys[row.sessionId]
          return (
            <Box key={row.sessionId} flexDirection="column">
              {row.kind === 'switch' ? (
                <Button
                  key={`go-${row.sessionId}`}
                  plain
                  {...(hotkey === undefined ? {} : { hotkey })}
                  onPress={() => {
                    void switchRow($, row)
                  }}
                >
                  {text.label}
                </Button>
              ) : (
                <Text dimColor>
                  {' '.repeat(HOTKEY_WIDTH)}
                  {text.label}
                </Text>
              )}
              <Text dimColor>
                {indent}
                {text.detail}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}
