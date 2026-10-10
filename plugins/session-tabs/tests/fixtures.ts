import type { ProcessRunResult } from 'claude-code'

import type { GhosttyTerminal } from '../hooks/sessions'

export const HOME = '/Users/someone'
export const SELF = 'self-0000'

/** One `ps -A -o pid=,ppid=,tty=,comm=` table with a session in every host. */
export const PS = `
    1     0 ??       /sbin/launchd
  100     1 ??       /Applications/Ghostty.app/Contents/MacOS/ghostty
  101   100 ttys001  /usr/bin/login
  102   101 ttys001  -/bin/zsh
  103   102 ttys001  claude
  104   100 ttys008  /usr/bin/login
  105   104 ttys008  -/bin/zsh
  106   105 ttys008  /Users/someone/.local/bin/claude
  107   100 ttys009  /usr/bin/login
  108   107 ttys009  -/bin/zsh
  109   108 ttys009  claude
  110   100 ttys005  /usr/bin/login
  111   110 ttys005  -/bin/zsh
  112   111 ttys005  tmux
  120   100 ttys010  /usr/bin/login
  121   120 ttys010  -/bin/zsh
  122   121 ttys010  claude
  200     1 ??       /Applications/iTerm.app/Contents/MacOS/iTerm2
  201   200 ttys002  /usr/bin/login
  202   201 ttys002  -zsh
  203   202 ttys002  claude
  300     1 ??       /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal
  301   300 ttys003  login
  302   301 ttys003  -zsh
  303   302 ttys003  /Users/someone/.local/bin/claude
  400     1 ??       tmux
  401   400 ttys004  -zsh
  402   401 ttys004  claude
  500     1 ??       /Applications/Visual Studio Code.app/Contents/MacOS/Code
  501   500 ??       /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)
  502   501 ??       /Users/someone/.vscode/extensions/anthropic.claude-code-2.1.295-darwin-arm64/resources/native-binary/claude
  503   501 ttys006  /bin/zsh
  504   503 ttys006  claude
  600     1 ??       /Applications/Cursor.app/Contents/MacOS/Cursor
  601   600 ttys007  -zsh
  602   601 ttys007  claude
`

interface AgentFixture {
  sessionId: string
  pid?: number
  name?: string
  cwd: string
  status?: string
  waitingFor?: string
  kind?: string
  state?: string
}

export function agent(fixture: AgentFixture): Record<string, unknown> {
  return {
    kind: fixture.kind ?? 'interactive',
    startedAt: 1_790_000_000_000,
    status: 'idle',
    ...fixture,
  }
}

export const AGENTS = [
  agent({
    sessionId: 'ghostty-named',
    pid: 103,
    name: 'fix-login-timeout',
    cwd: `${HOME}/projects/shop`,
    status: 'busy',
  }),
  agent({
    sessionId: 'ghostty-folder',
    pid: 106,
    name: 'shop-api-3f',
    cwd: `${HOME}/projects/api`,
    status: 'waiting',
    waitingFor: 'permission prompt',
  }),
  agent({
    sessionId: SELF,
    pid: 109,
    name: 'session-tabs-mod',
    cwd: `${HOME}/projects/marketplace`,
  }),
  agent({
    sessionId: 'ghostty-unknown',
    pid: 122,
    name: 'docs-2a',
    cwd: `${HOME}/projects/docs`,
  }),
  agent({
    sessionId: 'iterm',
    pid: 203,
    name: 'iterm-session',
    cwd: `${HOME}/projects/iterm`,
  }),
  agent({
    sessionId: 'terminal',
    pid: 303,
    name: 'terminal-session',
    cwd: `${HOME}/projects/terminal`,
  }),
  agent({
    sessionId: 'tmux',
    pid: 402,
    name: 'api-refactor',
    cwd: `${HOME}/projects/api`,
  }),
  agent({
    sessionId: 'vscode-panel',
    pid: 502,
    name: 'marketplace-1b',
    cwd: `${HOME}/projects/shop`,
  }),
  agent({
    sessionId: 'vscode-terminal',
    pid: 504,
    name: 'vscode-terminal-session',
    cwd: `${HOME}/projects/vs`,
  }),
  agent({
    sessionId: 'cursor',
    pid: 602,
    name: 'cursor-session',
    cwd: `${HOME}/projects/cursor`,
  }),
  agent({
    sessionId: 'bg-0001',
    kind: 'background',
    name: 'nightly-dependency-audit',
    cwd: `${HOME}/projects/infra`,
    state: 'blocked',
  }),
]

function terminal(
  tab: number,
  id: string,
  title: string,
  cwd: string,
): GhosttyTerminal {
  return { window: 1, windowId: 'w-1', tab, selected: false, id, title, cwd }
}

export const GHOSTTY: readonly GhosttyTerminal[] = [
  terminal(1, 'T-shell', '~/projects/shop', `${HOME}/projects/shop`),
  terminal(2, 'T-named', '✳ fix-login-timeout', `${HOME}/projects/shop`),
  terminal(3, 'T-api', '◐ Refactor the API layer', `${HOME}/projects/api`),
  terminal(4, 'T-self', '⠋ session-tabs-mod', `${HOME}/projects/marketplace`),
  terminal(5, 'T-docs-a', '✳ Draft the docs', `${HOME}/projects/docs`),
  terminal(6, 'T-docs-b', '✳ Review the docs', `${HOME}/projects/docs`),
  terminal(7, 'T-tmux', 'tmux', HOME),
]

export const PANES = '/dev/ttys004\tmain\t2\t%7\n/dev/ttys011\tother\t0\t%9\n'
export const CLIENTS = '/dev/ttys005\tmain\t1790000000\t112\n'

export function ran(
  stdout: string,
  exitCode = 0,
  stderr = '',
): ProcessRunResult {
  return {
    exitCode,
    stdout,
    stderr,
    isStdoutTruncated: false,
    isStderrTruncated: false,
  }
}
