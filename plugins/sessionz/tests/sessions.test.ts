import { describe, expect, test } from 'claude-code/testing'

import {
  assignKeys,
  buildRows,
  claudeCandidates,
  formatRow,
  hasClaudeGlyph,
  headerOf,
  hostOf,
  matchGhostty,
  parseAgents,
  parsePs,
  parseTmuxClients,
  parseTmuxPanes,
  pickClient,
  shortenPath,
  stripTitle,
  tildePath,
  type Agent,
  type GhosttySession,
  type World,
} from '../hooks/sessions'
import type { Host, Row } from '../types'
import { AGENTS, CLIENTS, GHOSTTY, HOME, PANES, PS, SELF } from './fixtures'

function agents(): Agent[] {
  return parseAgents(JSON.stringify(AGENTS))?.items ?? []
}

function worldOf(overrides: Partial<World> = {}): World {
  const table = parsePs(PS)
  const list = agents()
  const hosts = new Map<number, Host>(
    list.flatMap(a => (a.pid === null ? [] : [[a.pid, hostOf(a.pid, table)]])),
  )
  const inGhostty = list.flatMap((a): GhosttySession[] => {
    const host = a.pid === null ? undefined : hosts.get(a.pid)
    return host?.kind === 'ghostty'
      ? [{ sessionId: a.sessionId, tty: host.tty, name: a.name, cwd: a.cwd }]
      : []
  })
  return {
    agents: list,
    selfId: SELF,
    home: HOME,
    canSwitch: true,
    hosts,
    ghostty: GHOSTTY,
    matched: matchGhostty(inGhostty, GHOSTTY, new Map()),
    panes: parseTmuxPanes(PANES),
    clients: parseTmuxClients(CLIENTS),
    ...overrides,
  }
}

function rowFor(rows: readonly Row[], sessionId: string): Row | undefined {
  return rows.find(row => row.sessionId === sessionId)
}

describe('reading claude agents --json', () => {
  test('keeps live and background sessions and drops malformed entries', () => {
    const parsed = parseAgents(
      JSON.stringify([
        ...AGENTS.slice(0, 2),
        { kind: 'interactive', cwd: '/x', sessionId: 'no-pid' },
        { kind: 'robot', cwd: '/x', sessionId: 'odd', pid: 1 },
        { kind: 'interactive', sessionId: 'no-cwd', pid: 1 },
        'not an object',
        AGENTS.at(-1),
      ]),
    )
    expect(parsed?.items.map(a => a.sessionId)).toEqual([
      'ghostty-named',
      'ghostty-folder',
      'bg-0001',
    ])
    expect(parsed?.dropped).toBe(4)
    expect(parsed?.items[1]).toMatchObject({
      status: 'waiting',
      waitingFor: 'permission prompt',
      pid: 106,
    })
  })

  test('a reply that is not a JSON list is no list at all', () => {
    expect(parseAgents('{"sessions": []}')).toBeUndefined()
    expect(parseAgents('Error: not logged in')).toBeUndefined()
  })
})

describe('finding the app a session runs in', () => {
  const table = parsePs(PS)

  test('reads every terminal app, tmux and VS Code from the parent chain', () => {
    expect(hostOf(103, table)).toEqual({ kind: 'ghostty', tty: 'ttys001' })
    expect(hostOf(203, table)).toEqual({ kind: 'iterm', tty: 'ttys002' })
    expect(hostOf(303, table)).toEqual({ kind: 'terminal', tty: 'ttys003' })
    expect(hostOf(402, table)).toEqual({ kind: 'tmux', tty: 'ttys004' })
    expect(hostOf(502, table)).toEqual({
      kind: 'vscode-panel',
      app: '/Applications/Visual Studio Code.app',
    })
    expect(hostOf(504, table)).toEqual({
      kind: 'vscode-terminal',
      app: '/Applications/Visual Studio Code.app',
    })
  })

  test('an app it cannot drive, or a gone process, is other', () => {
    expect(hostOf(602, table)).toEqual({ kind: 'other', name: 'Cursor' })
    expect(hostOf(9999, table)).toEqual({
      kind: 'other',
      name: 'process not found',
    })
  })

  test('the tmux client is found in its own Ghostty tab', () => {
    expect(hostOf(112, table)).toEqual({ kind: 'ghostty', tty: 'ttys005' })
  })

  test('a comm with spaces stays whole', () => {
    expect(table.get(501)?.comm).toEndWith('Code Helper (Plugin)')
    expect(table.get(1)?.tty).toBe('')
  })
})

describe('tab titles', () => {
  test('strips Claude Code glyphs: ✳, half circles and braille', () => {
    expect(stripTitle('✳ fix-login-timeout')).toBe('fix-login-timeout')
    expect(stripTitle('◐ fix-login-timeout')).toBe('fix-login-timeout')
    expect(stripTitle('⠋ fix-login-timeout')).toBe('fix-login-timeout')
  })

  test('only Claude Code glyphs mark a Claude Code tab', () => {
    expect(hasClaudeGlyph('✳ Draft the docs')).toBe(true)
    expect(hasClaudeGlyph('◑ busy')).toBe(true)
    expect(hasClaudeGlyph('⠙ busy')).toBe(true)
    expect(hasClaudeGlyph('…/projects/experiments/x')).toBe(false)
    expect(hasClaudeGlyph('~/projects/shop')).toBe(false)
    expect(hasClaudeGlyph('caffeinate -d')).toBe(false)
  })
})

describe('matching Ghostty tabs', () => {
  const session = (
    sessionId: string,
    cwd: string,
    name: string | null = null,
    tty = `tty-${sessionId}`,
  ): GhosttySession => ({ sessionId, tty, name, cwd })

  test('by the name in the title', () => {
    const matched = matchGhostty(
      [session('a', `${HOME}/projects/shop`, 'fix-login-timeout')],
      GHOSTTY,
      new Map(),
    )
    expect(matched.get('a')?.id).toBe('T-named')
  })

  test('by the only Claude Code tab in the same folder', () => {
    const matched = matchGhostty(
      [session('a', `${HOME}/projects/api`, 'shop-api-3f')],
      GHOSTTY,
      new Map(),
    )
    expect(matched.get('a')?.id).toBe('T-api')
  })

  test('by the folder a worktree session was started from', () => {
    const matched = matchGhostty(
      [session('a', `${HOME}/projects/api/.claude/worktrees/bold-fox`)],
      GHOSTTY,
      new Map(),
    )
    expect(matched.get('a')?.id).toBe('T-api')
  })

  test('from the terminal the marker found for that tty', () => {
    const matched = matchGhostty(
      [session('a', `${HOME}/projects/docs`, null, 'ttys010')],
      GHOSTTY,
      new Map([['ttys010', 'T-docs-b']]),
    )
    expect(matched.get('a')?.id).toBe('T-docs-b')
  })

  test('two Claude Code tabs in one folder leave the session unknown', () => {
    const matched = matchGhostty(
      [session('a', `${HOME}/projects/docs`, 'docs-2a')],
      GHOSTTY,
      new Map(),
    )
    expect(matched.has('a')).toBe(false)
  })

  test('two sessions in one folder with one tab leave both unknown', () => {
    const matched = matchGhostty(
      [
        session('a', `${HOME}/projects/api`),
        session('b', `${HOME}/projects/api`),
      ],
      GHOSTTY,
      new Map(),
    )
    expect(matched.size).toBe(0)
  })

  test('a shell tab at ~ is not claimed by a session in ~/projects/x', () => {
    const matched = matchGhostty(
      [session('a', `${HOME}/projects/x`)],
      [
        {
          window: 1,
          windowId: 'w',
          tab: 1,
          selected: false,
          id: 'T-home',
          title: '✳ something',
          cwd: HOME,
        },
      ],
      new Map(),
    )
    expect(matched.size).toBe(0)
  })

  test("a plain shell tab in the session's own folder is not claimed", () => {
    const matched = matchGhostty(
      [session('a', `${HOME}/projects/shop`)],
      GHOSTTY.filter(t => t.id !== 'T-named'),
      new Map(),
    )
    expect(matched.size).toBe(0)
  })

  test('a tab claimed by name is not handed to another session by folder', () => {
    const matched = matchGhostty(
      [
        session('a', `${HOME}/projects/shop`, 'fix-login-timeout'),
        session('b', `${HOME}/projects/shop`),
      ],
      GHOSTTY,
      new Map(),
    )
    expect(matched.get('a')?.id).toBe('T-named')
    expect(matched.has('b')).toBe(false)
  })
})

describe('rows', () => {
  test('sorted waiting, busy, idle, then this session, then background', () => {
    const rows = buildRows(worldOf())
    expect(rows.map(row => row.sessionId)).toEqual([
      'ghostty-folder',
      'ghostty-named',
      'ghostty-unknown',
      'iterm',
      'terminal',
      'tmux',
      'vscode-panel',
      'vscode-terminal',
      'cursor',
      SELF,
      'bg-0001',
    ])
  })

  test('each host gets its place and its way to switch', () => {
    const rows = buildRows(worldOf())
    expect(rowFor(rows, 'ghostty-named')).toMatchObject({
      kind: 'switch',
      place: 'Ghostty tab 2',
      target: { kind: 'ghostty', terminalId: 'T-named' },
    })
    expect(rowFor(rows, 'ghostty-unknown')).toMatchObject({
      kind: 'switch',
      place: 'Ghostty',
      target: { kind: 'ghostty-tty', tty: 'ttys010' },
    })
    expect(rowFor(rows, 'iterm')).toMatchObject({
      place: 'iTerm2',
      target: { kind: 'iterm', tty: 'ttys002' },
    })
    expect(rowFor(rows, 'terminal')).toMatchObject({
      place: 'Terminal',
      target: { kind: 'terminal', tty: 'ttys003' },
    })
    expect(rowFor(rows, 'tmux')).toMatchObject({
      place: 'tmux main:2',
      target: { kind: 'tmux', paneId: '%7', session: 'main' },
    })
    expect(rowFor(rows, 'vscode-terminal')).toMatchObject({
      target: { kind: 'vscode-terminal' },
    })
    expect(rowFor(rows, 'cursor')).toMatchObject({
      kind: 'stuck',
      reason: 'Cursor: cannot switch there',
    })
    expect(rowFor(rows, SELF)).toMatchObject({
      kind: 'this',
      place: 'Ghostty tab 4',
    })
    expect(rowFor(rows, 'bg-0001')).toMatchObject({
      kind: 'background',
      place: 'background',
      state: 'blocked',
    })
  })

  test('the VS Code session never takes a Ghostty tab in its folder', () => {
    const rows = buildRows(worldOf())
    expect(rowFor(rows, 'vscode-panel')).toMatchObject({
      kind: 'switch',
      place: 'VS Code',
      target: {
        kind: 'vscode-panel',
        app: '/Applications/Visual Studio Code.app',
        cwd: `${HOME}/projects/shop`,
        sessionId: 'vscode-panel',
      },
    })
  })

  test('tmux with no client attached cannot switch', () => {
    const rows = buildRows(worldOf({ clients: [] }))
    expect(rowFor(rows, 'tmux')).toMatchObject({
      kind: 'stuck',
      reason: 'tmux: not attached',
    })
  })

  test('a tmux pane on another tmux server, or no pane list, cannot switch', () => {
    const elsewhere = buildRows(
      worldOf({ panes: parseTmuxPanes(PANES).slice(1) }),
    )
    expect(rowFor(elsewhere, 'tmux')).toMatchObject({
      kind: 'stuck',
      reason: 'tmux: not on the default server',
    })
    const unread = buildRows(worldOf({ panes: undefined }))
    expect(rowFor(unread, 'tmux')).toMatchObject({
      kind: 'stuck',
      reason: 'tmux: could not list its panes',
    })
  })

  test('without osascript no live row can switch', () => {
    const rows = buildRows(worldOf({ canSwitch: false }))
    expect(rows.filter(row => row.kind === 'switch')).toHaveLength(0)
    expect(rowFor(rows, 'iterm')).toMatchObject({
      kind: 'stuck',
      reason: 'switching needs macOS',
    })
  })

  test('the folder is shown under ~ and the header counts live sessions', () => {
    const rows = buildRows(worldOf())
    expect(rowFor(rows, 'iterm')?.path).toBe('~/projects/iterm')
    expect(headerOf(rows)).toBe(
      'Sessions · 1 waiting · 1 busy · 8 idle · 1 background',
    )
  })
})

describe('hotkeys', () => {
  test('stay with their session when a status change re-sorts the rows', () => {
    const first = buildRows(worldOf())
    const keys = assignKeys({}, first)
    expect(keys['ghostty-folder']).toBe('1')
    expect(keys['ghostty-named']).toBe('2')
    expect(keys['iterm']).toBe('4')

    const busy = agents().map(a =>
      a.sessionId === 'iterm' ? { ...a, status: 'waiting' as const } : a,
    )
    const second = buildRows(worldOf({ agents: busy }))
    const at = (id: string): number => second.findIndex(r => r.sessionId === id)
    expect(at('iterm')).toBeLessThan(at('ghostty-named'))
    expect(assignKeys(keys, second)).toEqual(keys)
  })

  test('are freed when a session ends and given to the next new one', () => {
    const keys = assignKeys({}, buildRows(worldOf()))
    const without = agents().filter(a => a.sessionId !== 'ghostty-named')
    const later = assignKeys(keys, buildRows(worldOf({ agents: without })))
    expect(later['ghostty-named']).toBeUndefined()
    const base = agents()[0]
    if (base === undefined) {
      throw new Error('missing agent')
    }
    const fresh = [...without, { ...base, sessionId: 'new-one', pid: 106 }]
    const again = assignKeys(later, buildRows(worldOf({ agents: fresh })))
    expect(again['new-one']).toBe('2')
    expect(again['iterm']).toBe('4')
  })

  test('only rows that can switch get one', () => {
    const keys = assignKeys({}, buildRows(worldOf()))
    expect(keys[SELF]).toBeUndefined()
    expect(keys['cursor']).toBeUndefined()
    expect(keys['bg-0001']).toBeUndefined()
  })
})

describe('paths and row text', () => {
  test('the home folder is written as ~', () => {
    expect(tildePath(`${HOME}/projects/shop`, HOME)).toBe('~/projects/shop')
    expect(tildePath(HOME, HOME)).toBe('~')
    expect(tildePath('/Users/someoneelse/x', HOME)).toBe('/Users/someoneelse/x')
  })

  test('a long path is cut in the middle and keeps its last folder', () => {
    const path = '~/code/samples/recipes-website/shopping-list-builder'
    expect(shortenPath(path, 80)).toBe(path)
    expect(shortenPath(path, 45)).toBe('~/code/samples/…/shopping-list-builder')
    expect(shortenPath(path, 30)).toBe('~/code/…/shopping-list-builder')
    expect(shortenPath(path, 12)).toBe('…ist-builder')
  })

  test('both lines fit their width and the detail says what it waits for', () => {
    const row = rowFor(buildRows(worldOf()), 'ghostty-folder')
    if (row === undefined) {
      throw new Error('missing row')
    }
    const text = formatRow(row, { label: 50, detail: 40 })
    expect(text.label.length).toBeLessThanOrEqual(50)
    expect(text.label).toStartWith('● waiting  shop-api-3f')
    expect(text.label).toEndWith('Ghostty tab 3')
    expect(text.detail).toBe('~/projects/api · permission prompt')
  })

  test('a row that cannot switch says why', () => {
    const row = rowFor(buildRows(worldOf({ clients: [] })), 'tmux')
    if (row === undefined) {
      throw new Error('missing row')
    }
    expect(formatRow(row, { label: 60, detail: 60 }).detail).toBe(
      '~/projects/api · tmux: not attached',
    )
  })
})

describe('tmux and the claude binary', () => {
  test('tmux panes and clients are read from tab-separated lines', () => {
    expect(parseTmuxPanes(PANES)).toEqual([
      { tty: 'ttys004', session: 'main', window: 2, paneId: '%7' },
      { tty: 'ttys011', session: 'other', window: 0, paneId: '%9' },
    ])
    expect(parseTmuxClients(`${CLIENTS}garbage\n`)).toEqual([
      { tty: 'ttys005', session: 'main', activity: 1_790_000_000, pid: 112 },
    ])
  })

  test('a client on the session wins, else the most recently active one', () => {
    const clients = [
      { tty: 'a', session: 'main', activity: 5, pid: 1 },
      { tty: 'b', session: 'other', activity: 9, pid: 2 },
      { tty: 'c', session: 'main', activity: 7, pid: 3 },
    ]
    expect(pickClient(clients, 'main')?.tty).toBe('c')
    expect(pickClient(clients, 'gone')?.tty).toBe('b')
    expect(pickClient([], 'main')).toBeUndefined()
  })

  test('claude is tried on PATH, then ~/.local/bin, then the newest VS Code copy', () => {
    expect(
      claudeCandidates(HOME, [
        'anthropic.claude-code-2.1.30-darwin-arm64',
        'anthropic.claude-code-2.10.1-darwin-arm64',
        'anthropic.claude-code-2.1.295-darwin-arm64',
        'ms-python.python-2026.1.0',
      ]),
    ).toEqual([
      'claude',
      `${HOME}/.local/bin/claude`,
      `${HOME}/.vscode/extensions/anthropic.claude-code-2.10.1-darwin-arm64/resources/native-binary/claude`,
    ])
    expect(claudeCandidates('', [])).toEqual(['claude'])
  })
})
