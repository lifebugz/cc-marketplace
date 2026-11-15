declare module 'claude-code' {
  interface PluginState {
    'chrome-profile': {
      /** A browser was chosen in this session: by the mod, or by Claude's own `select_browser`. */
      chosen: boolean
      /** A browser tool call of this session ran, so each prompt may list the browsers. */
      browserUsed: boolean
    }
  }
}
