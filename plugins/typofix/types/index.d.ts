export interface TypoIssue {
  id: string
  original: string
  choices: string[]
  kind: 'spelling' | 'grammar'
}

export type Rephrase =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; rewrites: string[] }
  | { status: 'failed'; reason: string }

declare module 'claude-code' {
  interface PluginState {
    typofix: {
      issues: TypoIssue[]
      isHidden: boolean
      hasDraft: boolean
      isChecked: boolean
      isOffering: boolean
      rephrase: Rephrase
    }
  }
}
