import type { McpContentBlock, On, ToolCallResult } from 'claude-code'
import type { MockClock } from 'claude-code/testing'
import { mock } from 'claude-code/testing'

import { tableFile } from './bytes'

export type Source =
  | 'localState'
  | 'listing'
  | 'leveldb'
  | 'preferences'
  | 'extensions'
  | 'scutil'
  | 'store'
  | 'bridge'

export const HOME = '/home/test'
export const ROOT = `${HOME}/Library/Application Support/Google/Chrome`
export const EXT = 'fcoeoabgfenejglbffodgkkbkcdhcgfn'
export const LEVELDB = `${ROOT}/Default/Local Extension Settings/${EXT}`
export const LIST_TOOL = 'mcp__claude-in-chrome__list_connected_browsers'
export const SELECT_TOOL = 'mcp__claude-in-chrome__select_browser'
export const NAVIGATE_TOOL = 'mcp__claude-in-chrome__navigate'
export const A = 'aaaaaaaa-0000-4000-8000-000000000001'
export const B = 'bbbbbbbb-0000-4000-8000-000000000002'
export const C = 'cccccccc-0000-4000-8000-000000000003'

export const LIST = [
  {
    deviceId: A,
    name: 'Browser 1',
    osPlatform: 'macOS',
    isLocal: true,
    inUse: true,
  },
  { deviceId: B, name: 'Browser 2', osPlatform: 'Windows', isLocal: false },
  { deviceId: C, name: 'Browser 3', osPlatform: 'macOS', isLocal: true },
]
export const SENTENCE = `3 browsers are connected; "Browser 1" (deviceId ${A}) is the one picked last and will be used.`
export const BLOCKS = [
  { type: 'text', text: JSON.stringify(LIST) },
  { type: 'text', text: SENTENCE },
]
export const LOCAL_STATE = {
  profile: {
    info_cache: {
      Default: { name: 'Work', user_name: 'some.one@example.com' },
      'Profile 2': { name: 'Scratch' },
    },
  },
}
export const PREFERENCES = {
  account_info: [
    { email: 'some.one@example.com' },
    { email: 'web.one@example.com' },
  ],
  profile: { password_hash_data_list: [{ hash: 'secret-hash' }] },
}
export const TABLE = tableFile([
  { key: 'bridgeDeviceId', seq: 5n, value: `"${A}"` },
])
export const REFUSED = { deny: 'refused in this test' }

function folderEntry(
  name: string,
  kind: 'file' | 'dir',
  size = 0,
): {
  name: string
  kind: 'file' | 'dir'
  size: number
  mtimeMs: number
  isLink: boolean
} {
  return { name, kind, size, mtimeMs: 0, isLink: false }
}

function base64Of(bytes: Readonly<Uint8Array>): string {
  return btoa(String.fromCharCode(...bytes))
}

/** The text blocks of a list answer, as `$.mcp.call` hands them to the mod. */
function contentOf(result: unknown): McpContentBlock[] {
  const blocks: readonly unknown[] = Array.isArray(result) ? result : BLOCKS
  return blocks.flatMap(block => {
    if (!isRecord(block) || typeof block['text'] !== 'string') {
      return []
    }
    const text: McpContentBlock = { type: 'text', text: block['text'] }
    return [text]
  })
}

export interface WorldOptions {
  /** Sources the stubs refuse. */
  readonly failing?: readonly Source[]
  /** What `list_connected_browsers` answers Claude. */
  readonly listAnswer?: Readonly<ToolCallResult>
  /** What `select_browser` answers Claude, when not its usual success. */
  readonly selectAnswer?: Readonly<ToolCallResult>
  /** How long the mod's own list call waits on the mock clock before it answers. */
  readonly listDelayMs?: number
  /** What the store holds before the test. */
  readonly seed?: Readonly<Record<string, unknown>>
  /** Picks the answer to the mod's question from its option labels. */
  readonly ask?: (labels: readonly string[]) => string
}

export interface World {
  readonly store: Map<string, unknown>
  /** The context each submitted prompt carried to the model, in order. */
  readonly contexts: (readonly string[])[]
  /** The tools the mod itself called through `$.mcp.call`, in order. */
  readonly mcpCalls: string[]
  /** The last value the mod wrote under each of its `$.state` keys. */
  readonly states: Map<string, unknown>
  readonly clock: MockClock
}

function textResult(text: string): ToolCallResult {
  return { result: [{ type: 'text', text }], text }
}

/** A Chrome folder with one profile that holds device A; `failing` sources are refused. */
export function chrome(on: On, options: WorldOptions = {}): World {
  const failing = options.failing ?? []
  const listAnswer = options.listAnswer ?? { result: BLOCKS, text: 'original' }
  const fails = new Set(failing)
  const store = new Map<string, unknown>(Object.entries(options.seed ?? {}))
  const world: World = {
    store,
    contexts: [],
    mcpCalls: [],
    states: new Map(),
    clock: mock.clock(on),
  }
  mock.env(on, { HOME })
  on('ui.log', () => ({ value: undefined }))
  on('process.run', () =>
    fails.has('scutil')
      ? REFUSED
      : {
          value: {
            exitCode: 0,
            stdout: 'Office Mac\n',
            stderr: '',
            isStdoutTruncated: false,
            isStderrTruncated: false,
          },
        },
  )
  on('store.get', (_$, e) =>
    fails.has('store') ? REFUSED : { value: store.get(e.key) },
  )
  on('store.set', (_$, e) => {
    if (fails.has('store')) {
      return REFUSED
    }
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: e.path === LEVELDB }))
  on('fs.list', (_$, e) => {
    if (e.path === ROOT && !fails.has('listing')) {
      return {
        value: [
          folderEntry('Default', 'dir'),
          folderEntry('Profile 2', 'dir'),
          folderEntry('Crashpad', 'dir'),
          folderEntry('Local State', 'file', 100),
        ],
      }
    }
    if (e.path === LEVELDB) {
      return {
        value: [
          folderEntry('000005.ldb', 'file', TABLE.length),
          folderEntry('LOCK', 'file'),
        ],
      }
    }
    if (
      e.path === `${ROOT}/Default/Extensions/${EXT}` &&
      !fails.has('extensions')
    ) {
      return { value: [folderEntry('1.0.107_0', 'dir')] }
    }
    return REFUSED
  })
  on('fs.read', (_$, e) => {
    if (e.path === `${ROOT}/Local State` && !fails.has('localState')) {
      return { value: JSON.stringify(LOCAL_STATE) }
    }
    if (e.path === `${ROOT}/Default/Preferences` && !fails.has('preferences')) {
      return { value: JSON.stringify(PREFERENCES) }
    }
    if (e.path === `${LEVELDB}/000005.ldb` && !fails.has('leveldb')) {
      return { value: { base64: base64Of(TABLE) } }
    }
    return REFUSED
  })
  on('mcp.call', async (_$, e) => {
    world.mcpCalls.push(e.tool)
    if (options.listDelayMs !== undefined) {
      await world.clock.sleep(options.listDelayMs)
    }
    return fails.has('bridge')
      ? REFUSED
      : { value: { content: contentOf(listAnswer.result), isError: false } }
  })
  on('state.set', { plugin: 'chrome-profile' }, async (_$, e, next) => {
    world.states.set(e.key, e.value)
    return next(e)
  })
  on('prompt.submit', (_$, e) => {
    world.contexts.push(e.context ?? [])
    return { text: e.text }
  })
  on('tool.call', (_$, e) => {
    if (e.tool === 'AskUserQuestion') {
      const [question] = e.questions
      const labels = (question?.options ?? []).map(option => option.label)
      const answer = options.ask?.(labels) ?? labels[0] ?? ''
      return { result: { answers: { [question?.question ?? '']: answer } } }
    }
    if (e.tool === LIST_TOOL) {
      return listAnswer
    }
    if (e.tool === SELECT_TOOL) {
      const picked = LIST.find(entry => entry.deviceId === e['deviceId'])
      return (
        options.selectAnswer ??
        textResult(`Selected browser "${picked?.name ?? 'Browser 9'}".`)
      )
    }
    return textResult('ok')
  })
  return world
}

export function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function blocksOf(result: unknown): readonly unknown[] {
  if (!isRecord(result) || !Array.isArray(result['result'])) {
    return []
  }
  const blocks: readonly unknown[] = result['result']
  return blocks
}

export function textOf(block: unknown): string {
  return isRecord(block) && typeof block['text'] === 'string'
    ? block['text']
    : ''
}

export function entriesOf(
  result: unknown,
): readonly Readonly<Record<string, unknown>>[] {
  const parsed: unknown = JSON.parse(textOf(blocksOf(result)[0]))
  if (!Array.isArray(parsed)) {
    return []
  }
  const items: readonly unknown[] = parsed
  return items.filter(isRecord)
}

export function labelsOf(result: unknown): readonly unknown[] {
  return entriesOf(result).map(entry => entry['name'])
}

export const LABELS = [
  'Work (some.one@example.com) · Office Mac',
  'Browser 2 (profile unknown) · another Windows computer',
  'Browser 3 (profile unknown) · another macOS computer',
]
