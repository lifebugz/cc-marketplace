export type Status = 'waiting' | 'busy' | 'idle'

export type Host =
  | { kind: 'ghostty'; tty: string }
  | { kind: 'iterm'; tty: string }
  | { kind: 'terminal'; tty: string }
  | { kind: 'tmux'; tty: string }
  | { kind: 'vscode-panel'; app: string }
  | { kind: 'vscode-terminal'; app: string }
  | { kind: 'other'; name: string }

export type Target =
  | { kind: 'ghostty'; terminalId: string }
  | { kind: 'ghostty-tty'; tty: string }
  | { kind: 'iterm'; tty: string }
  | { kind: 'terminal'; tty: string }
  | { kind: 'tmux'; paneId: string; session: string }
  | { kind: 'vscode-panel'; app: string; cwd: string; sessionId: string }
  | { kind: 'vscode-terminal'; app: string }

export interface RowBase {
  sessionId: string
  title: string
  /** The working directory with the home folder written as `~`. */
  path: string
  place: string
}

export interface LiveFields {
  status: Status
  waitingFor: string | null
}

export type Row =
  | (RowBase & LiveFields & { kind: 'switch'; target: Target })
  | (RowBase & LiveFields & { kind: 'stuck'; reason: string })
  | (RowBase & LiveFields & { kind: 'this' })
  | (RowBase & { kind: 'background'; state: string | null })

declare module 'claude-code' {
  interface PluginState {
    'session-tabs': {
      rows: Row[]
      /** Session id → the hotkey it keeps while the pane is open. */
      keys: Record<string, string>
      refreshedAt: number | null
      error: string | null
    }
  }
}
