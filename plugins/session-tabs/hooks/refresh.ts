import type { ProcessRunResult } from 'claude-code'

import type { Host } from '../types'
import {
  firstLine,
  PS_ARGV,
  readReply,
  scriptArgv,
  TMUX_CLIENTS_ARGV,
  TMUX_PANES_ARGV,
  type Io,
} from './hosts'
import {
  claudeCandidates,
  ghosttyTerminalsOf,
  hostOf,
  matchGhostty,
  parseAgents,
  parsePs,
  parseTmuxClients,
  parseTmuxPanes,
  type Agent,
  type GhosttySession,
  type GhosttyTerminal,
  type TmuxClient,
  type TmuxPane,
  type World,
} from './sessions'

/** What a refresh reads beside processes; register.tsx builds it from `$`. */
export interface WorldIo extends Io {
  home: string
  selfId: string
  /** Whether `osascript` exists, so tabs can be switched at all. */
  canSwitch: () => Promise<boolean>
  /** Names in ~/.vscode/extensions, empty when there is none. */
  extensions: () => Promise<string[]>
  debug: (text: string) => void
}

export interface Caches {
  /** pid → the app the session runs in; a pid's parents never change. */
  hosts: Map<number, Host>
  /** tty → the Ghostty terminal the marker found showing it. */
  remembered: Map<string, string>
  claude: string | undefined
  canSwitch: boolean | undefined
}

export function emptyCaches(): Caches {
  return {
    hosts: new Map(),
    remembered: new Map(),
    claude: undefined,
    canSwitch: undefined,
  }
}

async function runAgents(
  io: WorldIo,
  caches: Caches,
): Promise<ProcessRunResult | string> {
  const candidates =
    caches.claude === undefined
      ? claudeCandidates(io.home, await io.extensions())
      : [caches.claude]
  let reason = 'claude was not found'
  for (const program of candidates) {
    const ran = await io.run([program, 'agents', '--json'])
    if (typeof ran === 'string') {
      reason = ran
      continue
    }
    caches.claude = program
    return ran
  }
  caches.claude = undefined
  return reason
}

async function readHosts(
  io: WorldIo,
  caches: Caches,
  agents: readonly Agent[],
): Promise<void> {
  const live = new Set(agents.flatMap(agent => agent.pid ?? []))
  for (const pid of caches.hosts.keys()) {
    if (!live.has(pid)) caches.hosts.delete(pid)
  }
  const fresh = [...live].filter(pid => !caches.hosts.has(pid))
  if (fresh.length === 0) return
  const ps = await io.run(PS_ARGV)
  if (typeof ps === 'string') {
    io.debug(ps)
    return
  }
  const table = parsePs(ps.stdout)
  for (const pid of fresh) caches.hosts.set(pid, hostOf(pid, table))
}

async function readGhostty(io: WorldIo): Promise<GhosttyTerminal[]> {
  const ran = await io.run(scriptArgv(io.root, 'list-ghostty'))
  if (typeof ran === 'string') {
    io.debug(ran)
    return []
  }
  const reply = readReply(ran)
  if (!reply.ok) {
    io.debug(`listing Ghostty tabs failed: ${reply.error}`)
    return []
  }
  const parsed = ghosttyTerminalsOf(reply.fields['terminals'])
  if (parsed === undefined) {
    io.debug('the Ghostty listing held no terminals list')
    return []
  }
  if (parsed.dropped > 0) {
    io.debug(`dropped ${String(parsed.dropped)} unreadable Ghostty terminals`)
  }
  return parsed.items
}

async function readTmux(
  io: WorldIo,
): Promise<[TmuxPane[] | undefined, TmuxClient[] | undefined]> {
  const panes = await io.run(TMUX_PANES_ARGV)
  if (typeof panes === 'string' || panes.exitCode !== 0) {
    io.debug('tmux list-panes failed')
    return [undefined, undefined]
  }
  const clients = await io.run(TMUX_CLIENTS_ARGV)
  return [
    parseTmuxPanes(panes.stdout),
    typeof clients === 'string' || clients.exitCode !== 0
      ? []
      : parseTmuxClients(clients.stdout),
  ]
}

function forgetClosedTerminals(
  caches: Caches,
  terminals: readonly GhosttyTerminal[],
): void {
  const open = new Set(terminals.map(terminal => terminal.id))
  for (const [tty, id] of caches.remembered) {
    if (!open.has(id)) caches.remembered.delete(tty)
  }
}

/** Reads every live session and where it runs; a string says what failed. */
export async function readWorld(
  io: WorldIo,
  caches: Caches,
): Promise<World | string> {
  const ran = await runAgents(io, caches)
  if (typeof ran === 'string') return ran
  if (ran.exitCode !== 0) {
    return `claude agents --json failed: ${firstLine(ran.stderr)}`
  }
  const parsed = parseAgents(ran.stdout)
  if (parsed === undefined) return 'claude agents --json printed no list'
  if (parsed.dropped > 0) {
    io.debug(`dropped ${String(parsed.dropped)} unreadable session entries`)
  }
  const agents = parsed.items
  caches.canSwitch ??= await io.canSwitch()
  await readHosts(io, caches, agents)

  const hostOfAgent = (agent: Agent): Host | undefined =>
    agent.pid === null ? undefined : caches.hosts.get(agent.pid)
  const inGhostty = agents.flatMap((agent): GhosttySession[] => {
    const host = hostOfAgent(agent)
    return host?.kind === 'ghostty'
      ? [
          {
            sessionId: agent.sessionId,
            tty: host.tty,
            name: agent.name,
            cwd: agent.cwd,
          },
        ]
      : []
  })
  const ghostty =
    inGhostty.length > 0 && caches.canSwitch ? await readGhostty(io) : []
  if (ghostty.length > 0) forgetClosedTerminals(caches, ghostty)
  const usesTmux = agents.some(agent => hostOfAgent(agent)?.kind === 'tmux')
  const [panes, clients] = usesTmux
    ? await readTmux(io)
    : [undefined, undefined]

  return {
    agents,
    selfId: io.selfId,
    home: io.home,
    canSwitch: caches.canSwitch,
    hosts: caches.hosts,
    ghostty,
    matched: matchGhostty(inGhostty, ghostty, caches.remembered),
    panes,
    clients,
  }
}
