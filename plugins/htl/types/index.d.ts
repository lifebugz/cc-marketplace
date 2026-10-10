export type Blocker =
  'secret' | 'login' | 'physical' | 'payment_or_legal' | 'no_access'

export type Mode = 'now' | 'parallel'

export type Decision = 'accept' | 'reject' | 'handback'

export type SecretsMode = '1password' | 'none'

export interface HtlRequest {
  title: string
  steps: string
  blocker: Blocker
  why: string
  tried: string
  mode: Mode
  check?: string
}

export interface HtlTask extends HtlRequest {
  id: number
  isArmed: boolean
}

export interface ClosedTask {
  id: number
  title: string
  decision: Decision
}

export type View =
  | { step: 'decide'; taskId: number | null }
  | { step: 'message'; taskId: number; decision: Decision }

declare module 'claude-code' {
  interface PluginState {
    htl: {
      tasks: HtlTask[]
      closed: ClosedTask[]
      nextId: number
      view: View
    }
  }
}
