declare module 'claude-code' {
  interface PluginState {
    'chrome-profile': {
      /** A browser tool call of this session ran, so each prompt may list the browsers. */
      browserUsed: boolean
    }
  }
}
