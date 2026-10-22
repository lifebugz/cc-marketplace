import type { Host, Row, Status, Target } from '../types'
import { booleanOf, isRecord, numberOf, parseJson, stringOf } from './guards'

export interface Agent {
  readonly sessionId: string
  readonly kind: 'interactive' | 'background'
  readonly name: string | null
  readonly cwd: string
  readonly pid: number | null
  readonly status: Status | null
  readonly waitingFor: string | null
  readonly state: string | null
}

export interface Parsed<T> {
  readonly items: T[]
  readonly dropped: number
}

export interface Proc {
  readonly pid: number
  readonly ppid: number
  readonly tty: string
  readonly comm: string
}

export interface GhosttyTerminal {
  readonly window: number
  readonly windowId: string
  readonly tab: number
  readonly selected: boolean
  readonly id: string
  readonly title: string
  readonly cwd: string
}

export interface GhosttySession {
  readonly sessionId: string
  readonly tty: string
  readonly name: string | null
  readonly cwd: string
}

export interface TmuxPane {
  readonly tty: string
  readonly session: string
  readonly window: number
  readonly paneId: string
}

export interface TmuxClient {
  readonly tty: string
  readonly session: string
  readonly activity: number
  readonly pid: number
}

export interface World {
  readonly agents: readonly Agent[]
  readonly selfId: string
  readonly home: string
  readonly canSwitch: boolean
  readonly hosts: ReadonlyMap<number, Host>
  readonly ghostty: readonly GhosttyTerminal[]
  readonly matched: ReadonlyMap<string, GhosttyTerminal>
  readonly panes: readonly TmuxPane[] | undefined
  readonly clients: readonly TmuxClient[] | undefined
}

export interface RowText {
  readonly label: string
  readonly detail: string
}

export interface RowWidths {
  readonly label: number
  readonly detail: number
}

export const HOTKEYS: readonly string[] =
  '123456789abcdefghijklmnopqrstuvwxyz'.split('')

const STATUSES: readonly Status[] = ['waiting', 'busy', 'idle']
const MAX_DEPTH = 64
const WORKTREES = '/.claude/worktrees/'
const CLAUDE_GLYPH = /^[\u2733\u25d0-\u25d3\u2800-\u28ff]\s/u
const LEADING_MARKS = /^[^\p{L}\p{N}]+/u
const STATUS_WIDTH = 'waiting'.length
/** Where a row's title starts: a glyph, a space, the status word, two spaces. */
export const TITLE_COLUMN = 2 + STATUS_WIDTH + 2
const GLYPHS: Readonly<Record<Status, string>> = {
  waiting: '●',
  busy: '◐',
  idle: '○',
}
const BACKGROUND_GLYPH = '·'

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function statusOf(value: string | undefined): Status | null {
  return STATUSES.find(status => status === value) ?? null
}

function agentOf(value: unknown): Agent | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const kind = stringOf(value, 'kind')
  const cwd = stringOf(value, 'cwd')
  const sessionId = stringOf(value, 'sessionId') ?? stringOf(value, 'id')
  if (kind !== 'interactive' && kind !== 'background') {
    return undefined
  }
  if (cwd === undefined || sessionId === undefined) {
    return undefined
  }
  const pid = numberOf(value, 'pid') ?? null
  if (kind === 'interactive' && pid === null) {
    return undefined
  }
  return {
    sessionId,
    kind,
    name: stringOf(value, 'name') ?? null,
    cwd,
    pid,
    status: statusOf(stringOf(value, 'status')),
    waitingFor: stringOf(value, 'waitingFor') ?? null,
    state: stringOf(value, 'state') ?? null,
  }
}

export function parseAgents(stdout: string): Parsed<Agent> | undefined {
  const data = parseJson(stdout)
  if (!Array.isArray(data)) {
    return undefined
  }
  const entries: readonly unknown[] = data
  const items = entries.map(agentOf).filter(isDefined)
  return { items, dropped: entries.length - items.length }
}

export function parsePs(stdout: string): Map<number, Proc> {
  const table = new Map<number, Proc>()
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*\S)\s*$/.exec(line)
    const [, pid, ppid, tty, comm] = match ?? []
    if (pid === undefined || ppid === undefined) {
      continue
    }
    if (tty === undefined || comm === undefined) {
      continue
    }
    table.set(Number(pid), {
      pid: Number(pid),
      ppid: Number(ppid),
      tty: tty === '??' ? '' : tty,
      comm,
    })
  }
  return table
}

export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1).replace(/^-/, '')
}

function appBundle(comm: string): string | undefined {
  return /^(.*?\.app)\//.exec(comm)?.[1]
}

function hostAt(proc: Proc, tty: string): Host | undefined {
  if (baseName(proc.comm) === 'tmux') {
    return tty === '' ? { kind: 'other', name: 'tmux' } : { kind: 'tmux', tty }
  }
  const app = appBundle(proc.comm)
  if (app === undefined) {
    return undefined
  }
  const bundle = baseName(app)
  const name = bundle.replace(/\.app$/, '')
  if (bundle === 'Visual Studio Code.app') {
    return tty === ''
      ? { kind: 'vscode-panel', app }
      : { kind: 'vscode-terminal', app }
  }
  if (tty === '') {
    return { kind: 'other', name }
  }
  if (bundle === 'Ghostty.app') {
    return { kind: 'ghostty', tty }
  }
  if (bundle === 'iTerm.app') {
    return { kind: 'iterm', tty }
  }
  if (bundle === 'Terminal.app') {
    return { kind: 'terminal', tty }
  }
  return { kind: 'other', name }
}

export function hostOf(pid: number, table: ReadonlyMap<number, Proc>): Host {
  const self = table.get(pid)
  if (self === undefined) {
    return { kind: 'other', name: 'process not found' }
  }
  let proc = table.get(self.ppid)
  for (let depth = 0; proc !== undefined && depth < MAX_DEPTH; depth++) {
    const host = hostAt(proc, self.tty)
    if (host !== undefined) {
      return host
    }
    if (proc.ppid === proc.pid) {
      break
    }
    proc = table.get(proc.ppid)
  }
  return { kind: 'other', name: 'unknown app' }
}

export function hostTty(host: Host): string | undefined {
  switch (host.kind) {
    case 'ghostty':
    case 'iterm':
    case 'terminal':
    case 'tmux':
      return host.tty
    case 'vscode-panel':
    case 'vscode-terminal':
    case 'other':
      return undefined
    default:
      return host satisfies never
  }
}

function ghosttyTerminalOf(value: unknown): GhosttyTerminal | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const window = numberOf(value, 'window')
  const windowId = stringOf(value, 'windowId')
  const tab = numberOf(value, 'tab')
  const selected = booleanOf(value, 'selected')
  const id = stringOf(value, 'id')
  const title = stringOf(value, 'title')
  const cwd = stringOf(value, 'cwd')
  if (window === undefined || windowId === undefined || tab === undefined) {
    return undefined
  }
  if (selected === undefined || id === undefined) {
    return undefined
  }
  if (title === undefined || cwd === undefined) {
    return undefined
  }
  return { window, windowId, tab, selected, id, title, cwd }
}

export function ghosttyTerminalsOf(
  value: unknown,
): Parsed<GhosttyTerminal> | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const entries: readonly unknown[] = value
  const items = entries.map(ghosttyTerminalOf).filter(isDefined)
  return { items, dropped: entries.length - items.length }
}

export function stripTitle(title: string): string {
  return title.replace(LEADING_MARKS, '')
}

export function hasClaudeGlyph(title: string): boolean {
  return CLAUDE_GLYPH.test(title)
}

function worktreeRoot(cwd: string): string | undefined {
  const at = cwd.indexOf(WORKTREES)
  return at < 0 ? undefined : cwd.slice(0, at)
}

function sitsIn(terminal: GhosttyTerminal, session: GhosttySession): boolean {
  return (
    terminal.cwd === session.cwd || terminal.cwd === worktreeRoot(session.cwd)
  )
}

/**
 * Pairs each Ghostty session with its terminal: by the name in the tab title,
 * then by a terminal the marker found for that tty, then by folder when one
 * session and one Claude Code tab are the only ones there.
 */
export function matchGhostty(
  sessions: readonly GhosttySession[],
  terminals: readonly GhosttyTerminal[],
  remembered: ReadonlyMap<string, string>,
): Map<string, GhosttyTerminal> {
  const matched = new Map<string, GhosttyTerminal>()
  const claimed = new Set<string>()
  const claim = (session: GhosttySession, terminal: GhosttyTerminal): void => {
    matched.set(session.sessionId, terminal)
    claimed.add(terminal.id)
  }

  for (const session of sessions) {
    if (session.name === null) {
      continue
    }
    const hits = terminals.filter(t => stripTitle(t.title) === session.name)
    const [hit] = hits
    if (hits.length === 1 && hit !== undefined && !claimed.has(hit.id)) {
      claim(session, hit)
    }
  }

  for (const session of sessions) {
    if (matched.has(session.sessionId)) {
      continue
    }
    const id = remembered.get(session.tty)
    const terminal = terminals.find(t => t.id === id)
    if (terminal !== undefined && !claimed.has(terminal.id)) {
      claim(session, terminal)
    }
  }

  const rest = sessions.filter(session => !matched.has(session.sessionId))
  const candidates = new Map(
    rest.map(session => [
      session,
      terminals.filter(
        t =>
          !claimed.has(t.id) && hasClaudeGlyph(t.title) && sitsIn(t, session),
      ),
    ]),
  )
  for (const [session, hits] of candidates) {
    const [hit] = hits
    if (hits.length !== 1 || hit === undefined) {
      continue
    }
    const rivals = [...candidates.values()].filter(other => other.includes(hit))
    if (rivals.length === 1) {
      claim(session, hit)
    }
  }
  return matched
}

export function parseTmuxPanes(stdout: string): TmuxPane[] {
  return stdout
    .split('\n')
    .map(line => line.split('\t'))
    .flatMap(([tty, session, window, paneId]) =>
      tty === undefined ||
      session === undefined ||
      window === undefined ||
      paneId === undefined ||
      !/^\d+$/.test(window)
        ? []
        : [{ tty: devName(tty), session, window: Number(window), paneId }],
    )
}

export function parseTmuxClients(stdout: string): TmuxClient[] {
  return stdout
    .split('\n')
    .map(line => line.split('\t'))
    .flatMap(([tty, session, activity, pid]) =>
      tty === undefined ||
      session === undefined ||
      activity === undefined ||
      pid === undefined ||
      !/^\d+$/.test(activity) ||
      !/^\d+$/.test(pid)
        ? []
        : [
            {
              tty: devName(tty),
              session,
              activity: Number(activity),
              pid: Number(pid),
            },
          ],
    )
}

export function devName(tty: string): string {
  return tty.replace(/^\/dev\//, '')
}

export function pickClient(
  clients: readonly TmuxClient[],
  session: string,
): TmuxClient | undefined {
  const latest = (list: readonly TmuxClient[]): TmuxClient | undefined =>
    list.reduce<TmuxClient | undefined>(
      (best, client) =>
        best === undefined || client.activity > best.activity ? client : best,
      undefined,
    )
  return latest(clients.filter(c => c.session === session)) ?? latest(clients)
}

function ghosttyPlace(
  terminal: GhosttyTerminal,
  terminals: readonly GhosttyTerminal[],
): string {
  const windows = new Set(terminals.map(t => t.windowId)).size
  return windows > 1
    ? `Ghostty window ${String(terminal.window)} tab ${String(terminal.tab)}`
    : `Ghostty tab ${String(terminal.tab)}`
}

interface Placed {
  readonly place: string
  readonly order: number
  readonly target: Target | { reason: string }
}

function placeOf(agent: Agent, host: Host, world: World): Placed {
  switch (host.kind) {
    case 'ghostty': {
      const terminal = world.matched.get(agent.sessionId)
      return terminal === undefined
        ? {
            place: 'Ghostty',
            order: 1e6,
            target: { kind: 'ghostty-tty', tty: host.tty },
          }
        : {
            place: ghosttyPlace(terminal, world.ghostty),
            order: terminal.window * 1000 + terminal.tab,
            target: { kind: 'ghostty', terminalId: terminal.id },
          }
    }
    case 'iterm':
      return {
        place: 'iTerm2',
        order: 2e6,
        target: { kind: 'iterm', tty: host.tty },
      }
    case 'terminal':
      return {
        place: 'Terminal',
        order: 3e6,
        target: { kind: 'terminal', tty: host.tty },
      }
    case 'tmux': {
      const pane = world.panes?.find(p => p.tty === host.tty)
      if (pane === undefined) {
        return {
          place: 'tmux',
          order: 4e6,
          target: {
            reason:
              world.panes === undefined
                ? 'tmux: could not list its panes'
                : 'tmux: not on the default server',
          },
        }
      }
      const place = `tmux ${pane.session}:${String(pane.window)}`
      return world.clients === undefined || world.clients.length === 0
        ? { place, order: 4e6, target: { reason: 'tmux: not attached' } }
        : {
            place,
            order: 4e6,
            target: {
              kind: 'tmux',
              paneId: pane.paneId,
              session: pane.session,
            },
          }
    }
    case 'vscode-panel':
      return {
        place: 'VS Code',
        order: 5e6,
        target: {
          kind: 'vscode-panel',
          app: host.app,
          cwd: agent.cwd,
          sessionId: agent.sessionId,
        },
      }
    case 'vscode-terminal':
      return {
        place: 'VS Code terminal',
        order: 5e6,
        target: { kind: 'vscode-terminal', app: host.app },
      }
    case 'other':
      return {
        place: host.name,
        order: 6e6,
        target: { reason: `${host.name}: cannot switch there` },
      }
    default:
      return host satisfies never
  }
}

function rank(row: Row): number {
  switch (row.kind) {
    case 'switch':
    case 'stuck':
      return STATUSES.indexOf(row.status)
    case 'this':
      return STATUSES.length
    case 'background':
      return STATUSES.length + 1
    default:
      return row satisfies never
  }
}

function rowOf(agent: Agent, world: World): { row: Row; order: number } {
  const base = {
    sessionId: agent.sessionId,
    title: agent.name ?? baseName(agent.cwd),
    path: tildePath(agent.cwd, world.home),
  }
  if (agent.kind === 'background' || agent.pid === null) {
    return {
      row: {
        ...base,
        kind: 'background',
        place: 'background',
        state: agent.state,
      },
      order: 0,
    }
  }
  const live = { status: agent.status ?? 'idle', waitingFor: agent.waitingFor }
  const host = world.hosts.get(agent.pid) ?? {
    kind: 'other',
    name: 'unknown app',
  }
  const { place, order, target } = placeOf(agent, host, world)
  if (agent.sessionId === world.selfId) {
    return { row: { ...base, ...live, kind: 'this', place }, order }
  }
  if (!world.canSwitch) {
    return {
      row: {
        ...base,
        ...live,
        kind: 'stuck',
        place,
        reason: 'switching needs macOS',
      },
      order,
    }
  }
  return 'reason' in target
    ? {
        row: { ...base, ...live, kind: 'stuck', place, reason: target.reason },
        order,
      }
    : { row: { ...base, ...live, kind: 'switch', place, target }, order }
}

export function buildRows(world: World): Row[] {
  return world.agents
    .map(agent => rowOf(agent, world))
    .sort(
      (a, b) =>
        [
          rank(a.row) - rank(b.row),
          a.order - b.order,
          a.row.title.localeCompare(b.row.title),
        ].find(difference => difference !== 0) ?? 0,
    )
    .map(({ row }) => row)
}

export function assignKeys(
  previous: Readonly<Record<string, string>>,
  rows: readonly Row[],
): Record<string, string> {
  const present = new Set(rows.map(row => row.sessionId))
  const keys = new Map(
    Object.entries(previous).filter(([sessionId]) => present.has(sessionId)),
  )
  const used = new Set(keys.values())
  for (const row of rows) {
    if (row.kind !== 'switch' || keys.has(row.sessionId)) {
      continue
    }
    const free = HOTKEYS.find(key => !used.has(key))
    if (free === undefined) {
      break
    }
    keys.set(row.sessionId, free)
    used.add(free)
  }
  return Object.fromEntries(keys)
}

export function tildePath(path: string, home: string): string {
  if (home === '' || home === '/') {
    return path
  }
  if (path === home) {
    return '~'
  }
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

export function cut(text: string, width: number): string {
  if (text.length <= width) {
    return text
  }
  return width <= 0 ? '' : `${text.slice(0, width - 1)}…`
}

/** Cuts a path in the middle so its last folder stays readable. */
export function shortenPath(path: string, width: number): string {
  if (path.length <= width) {
    return path
  }
  const parts = path.split('/')
  const last = parts.pop() ?? ''
  for (let keep = parts.length - 1; keep >= 1; keep--) {
    const shortened = `${parts.slice(0, keep).join('/')}/…/${last}`
    if (shortened.length <= width) {
      return shortened
    }
  }
  const tail = `…/${last}`
  if (tail.length <= width) {
    return tail
  }
  return width <= 1 ? cut(last, width) : `…${last.slice(-(width - 1))}`
}

function statusWord(row: Row): string {
  switch (row.kind) {
    case 'switch':
    case 'stuck':
      return row.status
    case 'this':
      return 'this'
    case 'background':
      return 'bg'
    default:
      return row satisfies never
  }
}

function glyphOf(row: Row): string {
  return row.kind === 'background' ? BACKGROUND_GLYPH : GLYPHS[row.status]
}

function noteOf(row: Row): string | null {
  switch (row.kind) {
    case 'switch':
    case 'this':
      return row.waitingFor
    case 'stuck':
      return row.waitingFor === null
        ? row.reason
        : `${row.waitingFor} · ${row.reason}`
    case 'background':
      return row.state
    default:
      return row satisfies never
  }
}

export function formatRow(row: Row, widths: RowWidths): RowText {
  const width = widths.label
  const head = `${glyphOf(row)} ${statusWord(row).padEnd(STATUS_WIDTH)}  `
  const room = width - head.length
  const place = cut(row.place, Math.max(0, Math.floor(room / 2)))
  const titleRoom = Math.max(0, room - place.length - 2)
  const title = cut(row.title, titleRoom).padEnd(titleRoom)
  const label = `${head}${title}  ${place}`.trimEnd()

  const note = noteOf(row)
  const suffix = note === null ? '' : ` · ${note}`
  const pathRoom = Math.max(8, widths.detail - suffix.length)
  const detail = cut(
    `${shortenPath(row.path, pathRoom)}${suffix}`,
    widths.detail,
  )
  return { label: cut(label, width), detail }
}

export function headerOf(rows: readonly Row[]): string {
  const live = rows.flatMap(row => (row.kind === 'background' ? [] : [row]))
  const counts = STATUSES.map(
    status =>
      `${String(live.filter(row => row.status === status).length)} ${status}`,
  )
  const background = rows.length - live.length
  const extra = background > 0 ? [`${String(background)} background`] : []
  return ['Sessions', ...counts, ...extra].join(' · ')
}

const EXTENSION = /^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/

function extensionVersion(name: string): number[] | undefined {
  const match = EXTENSION.exec(name)
  return match?.slice(1).map(Number)
}

/**
 * Where `claude` may be: on PATH, the native installer's place, then the
 * newest VS Code extension's own copy (a session started there may have no
 * `claude` on PATH).
 */
export function claudeCandidates(
  home: string,
  extensions: readonly string[],
): string[] {
  const newest = extensions
    .flatMap(name => {
      const version = extensionVersion(name)
      return version === undefined ? [] : [{ name, version }]
    })
    .sort((a, b) => {
      for (const [i, part] of b.version.entries()) {
        const diff = part - (a.version[i] ?? 0)
        if (diff !== 0) {
          return diff
        }
      }
      return 0
    })
    .at(0)
  const candidates = ['claude']
  if (home !== '') {
    candidates.push(`${home}/.local/bin/claude`)
  }
  if (newest !== undefined && home !== '') {
    candidates.push(
      `${home}/.vscode/extensions/${newest.name}/resources/native-binary/claude`,
    )
  }
  return candidates
}
