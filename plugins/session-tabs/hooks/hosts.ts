import type { ProcessRunResult } from 'claude-code'

import type { Target } from '../types'
import {
  booleanOf,
  isRecord,
  numberOf,
  parseJson,
  stringOf,
  type Fields,
} from './guards'
import { hostOf, parsePs, parseTmuxClients, pickClient } from './sessions'

export const RUN_TIMEOUT_MS = 5000
export const VSCODE_SETTLE_MS = 300
export const PS_ARGV: readonly string[] = [
  'ps',
  '-A',
  '-o',
  'pid=,ppid=,tty=,comm=',
]
export const TMUX_PANES_ARGV: readonly string[] = [
  'tmux',
  'list-panes',
  '-a',
  '-F',
  '#{pane_tty}\t#{session_name}\t#{window_index}\t#{pane_id}',
]
export const TMUX_CLIENTS_ARGV: readonly string[] = [
  'tmux',
  'list-clients',
  '-F',
  '#{client_tty}\t#{client_session}\t#{client_activity}\t#{client_pid}',
]

/** Apple's errAEEventNotPermitted and errAEEventWouldRequireUserConsent. */
const PERMISSION_ERRORS: readonly number[] = [-1743, -1744]

export interface Failure {
  error: string
  number: number | null
}

export type Reply = { ok: true; fields: Fields } | ({ ok: false } & Failure)

export type SwitchResult =
  | { ok: true; terminalId: string | null; note: string | null }
  | { ok: false; message: string }

const DONE: SwitchResult = { ok: true, terminalId: null, note: null }

export function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}

export function scriptArgv(
  root: string,
  command: string,
  arg?: string,
): string[] {
  const argv = [
    'osascript',
    '-l',
    'JavaScript',
    `${root}/scripts/terminals.js`,
    command,
  ]
  return arg === undefined ? argv : [...argv, arg]
}

export function readReply(ran: ProcessRunResult): Reply {
  const data = parseJson(ran.stdout.trim())
  if (isRecord(data)) {
    if (booleanOf(data, 'ok') === true) return { ok: true, fields: data }
    const error = stringOf(data, 'error')
    if (error !== undefined) {
      return { ok: false, error, number: numberOf(data, 'number') ?? null }
    }
  }
  const stderr = ran.stderr.trim()
  const code = /\((-?\d+)\)$/.exec(stderr)?.[1]
  return {
    ok: false,
    error: firstLine(stderr) || `exited with ${String(ran.exitCode)}`,
    number: code === undefined ? null : Number(code),
  }
}

export function failureText(app: string, failure: Failure): string {
  return failure.number !== null && PERMISSION_ERRORS.includes(failure.number)
    ? `session-tabs: macOS did not let Claude Code control ${app}. Allow it in System Settings → Privacy & Security → Automation, under the app Claude Code runs in.`
    : `session-tabs: could not switch to ${app}: ${failure.error}`
}

/** The outside world as switching needs it; register.tsx builds it from `$`. */
export interface Io {
  /** Runs a program; a string says why it could not start or finish. */
  run: (argv: readonly string[]) => Promise<ProcessRunResult | string>
  sleep: (ms: number) => Promise<void>
  /** The plugin's folder. */
  root: string
}

async function viaScript(
  io: Io,
  app: string,
  command: string,
  arg: string,
): Promise<SwitchResult> {
  const ran = await io.run(scriptArgv(io.root, command, arg))
  if (typeof ran === 'string') {
    return {
      ok: false,
      message: failureText(app, { error: ran, number: null }),
    }
  }
  const reply = readReply(ran)
  if (!reply.ok) return { ok: false, message: failureText(app, reply) }
  return {
    ok: true,
    terminalId: stringOf(reply.fields, 'terminalId') ?? null,
    note: null,
  }
}

async function tmux(
  io: Io,
  argv: readonly string[],
): Promise<string | undefined> {
  const ran = await io.run(argv)
  if (typeof ran === 'string') return ran
  return ran.exitCode === 0 ? undefined : `tmux: ${firstLine(ran.stderr)}`
}

async function focusOuter(io: Io, clientPid: number): Promise<SwitchResult> {
  const ps = await io.run(PS_ARGV)
  if (typeof ps === 'string') return DONE
  const outer = hostOf(clientPid, parsePs(ps.stdout))
  switch (outer.kind) {
    case 'ghostty': {
      const focused = await viaScript(
        io,
        'Ghostty',
        'focus-ghostty-tty',
        outer.tty,
      )
      return focused.ok ? DONE : focused
    }
    case 'iterm':
      return viaScript(io, 'iTerm2', 'focus-iterm', outer.tty)
    case 'terminal':
      return viaScript(io, 'Terminal', 'focus-terminal', outer.tty)
    case 'vscode-terminal':
      return openApp(io, outer.app)
    case 'tmux':
    case 'vscode-panel':
    case 'other':
      return DONE
    default:
      return outer satisfies never
  }
}

async function switchTmux(
  io: Io,
  paneId: string,
  session: string,
): Promise<SwitchResult> {
  for (const argv of [
    ['tmux', 'select-window', '-t', paneId],
    ['tmux', 'select-pane', '-t', paneId],
  ]) {
    const failed = await tmux(io, argv)
    if (failed !== undefined) return { ok: false, message: failed }
  }
  const listed = await io.run(TMUX_CLIENTS_ARGV)
  const clients =
    typeof listed === 'string' ? [] : parseTmuxClients(listed.stdout)
  const client = pickClient(clients, session)
  if (client === undefined) return { ok: false, message: 'tmux: not attached' }
  if (client.session !== session) {
    const failed = await tmux(io, [
      'tmux',
      'switch-client',
      '-c',
      `/dev/${client.tty}`,
      '-t',
      paneId,
    ])
    if (failed !== undefined) return { ok: false, message: failed }
  }
  return focusOuter(io, client.pid)
}

async function openApp(io: Io, app: string): Promise<SwitchResult> {
  const ran = await io.run(['open', '-a', app])
  if (typeof ran === 'string' || ran.exitCode !== 0) {
    return { ok: false, message: `session-tabs: could not open ${app}` }
  }
  return {
    ok: true,
    terminalId: null,
    note: 'session-tabs: VS Code is in front; pick the terminal tab there.',
  }
}

async function openVsCodePanel(
  io: Io,
  app: string,
  cwd: string,
  sessionId: string,
): Promise<SwitchResult> {
  const window = await io.run(['open', '-a', app, cwd])
  if (typeof window === 'string' || window.exitCode !== 0) {
    return { ok: false, message: `session-tabs: could not open ${app}` }
  }
  await io.sleep(VSCODE_SETTLE_MS)
  const uri = `vscode://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`
  const tab = await io.run(['open', uri])
  if (typeof tab === 'string' || tab.exitCode !== 0) {
    return { ok: false, message: 'session-tabs: VS Code did not open the tab' }
  }
  return DONE
}

export async function switchTo(io: Io, target: Target): Promise<SwitchResult> {
  switch (target.kind) {
    case 'ghostty':
      return viaScript(io, 'Ghostty', 'focus-ghostty', target.terminalId)
    case 'ghostty-tty':
      return viaScript(io, 'Ghostty', 'focus-ghostty-tty', target.tty)
    case 'iterm':
      return viaScript(io, 'iTerm2', 'focus-iterm', target.tty)
    case 'terminal':
      return viaScript(io, 'Terminal', 'focus-terminal', target.tty)
    case 'tmux':
      return switchTmux(io, target.paneId, target.session)
    case 'vscode-panel':
      return openVsCodePanel(io, target.app, target.cwd, target.sessionId)
    case 'vscode-terminal':
      return openApp(io, target.app)
    default:
      return target satisfies never
  }
}
