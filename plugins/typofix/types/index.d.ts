export interface TypoIssue {
  readonly id: string
  readonly original: string
  readonly choices: readonly string[]
  readonly kind: 'spelling' | 'grammar'
}

export type Rephrase =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly rewrites: readonly string[] }
  | { readonly status: 'failed'; readonly reason: string }

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
