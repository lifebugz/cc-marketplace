export type Status = 'waiting' | 'busy' | 'idle'

export type Host =
  | { readonly kind: 'ghostty'; readonly tty: string }
  | { readonly kind: 'iterm'; readonly tty: string }
  | { readonly kind: 'terminal'; readonly tty: string }
  | { readonly kind: 'tmux'; readonly tty: string }
  | { readonly kind: 'vscode-panel'; readonly app: string }
  | { readonly kind: 'vscode-terminal'; readonly app: string }
  | { readonly kind: 'other'; readonly name: string }

export type Target =
  | { readonly kind: 'ghostty'; readonly terminalId: string }
  | { readonly kind: 'ghostty-tty'; readonly tty: string }
  | { readonly kind: 'iterm'; readonly tty: string }
  | { readonly kind: 'terminal'; readonly tty: string }
  | { readonly kind: 'tmux'; readonly paneId: string; readonly session: string }
  | {
      readonly kind: 'vscode-panel'
      readonly app: string
      readonly cwd: string
      readonly sessionId: string
    }
  | { readonly kind: 'vscode-terminal'; readonly app: string }

export interface RowBase {
  readonly sessionId: string
  readonly title: string
  /** The working directory with the home folder written as `~`. */
  readonly path: string
  readonly place: string
}

export interface LiveFields {
  readonly status: Status
  readonly waitingFor: string | null
}

export type Row =
  | (RowBase &
      LiveFields & { readonly kind: 'switch'; readonly target: Target })
  | (RowBase & LiveFields & { readonly kind: 'stuck'; readonly reason: string })
  | (RowBase & LiveFields & { readonly kind: 'this' })
  | (RowBase & { readonly kind: 'background'; readonly state: string | null })

declare module 'claude-code' {
  interface PluginState {
    sessionz: {
      rows: Row[]
      /** Session id → the hotkey it keeps while the pane is open. */
      keys: Record<string, string>
      refreshedAt: number | null
      error: string | null
    }
  }
}
