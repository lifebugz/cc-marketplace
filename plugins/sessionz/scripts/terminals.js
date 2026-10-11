ObjC.import('Foundation')

const MARKER_POLLS = 10
const MARKER_POLL_SECONDS = 0.05
const LATE_MARKER_SECONDS = 0.2

/**
 * @typedef {{ window: number, windowId: string, tab: number, selected: boolean,
 *   id: string, title: string, cwd: string }} GhosttyRow
 * @typedef {{ ok: true, terminals?: GhosttyRow[], terminalId?: string }
 *   | { error: string, number: number | null }} Reply
 */

/** @param {string} tty */
function devicePath(tty) {
  return tty.startsWith('/dev/') ? tty : `/dev/${tty}`
}

/**
 * @param {string} tty
 * @param {string} title
 */
function writeTitle(tty, title) {
  const handle = $.NSFileHandle.fileHandleForWritingAtPath(devicePath(tty))
  if (handle.isNil()) throw new Error(`cannot write to ${tty}`)
  handle.writeData(
    $(`\u001b]2;${title}\u0007`).dataUsingEncoding($.NSUTF8StringEncoding),
  )
}

/** @returns {GhosttyRow[] | undefined} */
function readGhostty() {
  const windows = Application('Ghostty').windows
  const windowIds = windows.id()
  const tabIndex = windows.tabs.index()
  const tabSelected = windows.tabs.selected()
  const ids = windows.tabs.terminals.id()
  const titles = windows.tabs.terminals.name()
  const dirs = windows.tabs.terminals.workingDirectory()
  if (JSON.stringify(windows.tabs.terminals.id()) !== JSON.stringify(ids)) {
    return undefined
  }

  /** @type {GhosttyRow[]} */
  const rows = []
  for (const [w, windowId] of windowIds.entries()) {
    for (const [t, tab] of (tabIndex[w] ?? []).entries()) {
      for (const [s, id] of (ids[w]?.[t] ?? []).entries()) {
        rows.push({
          window: w + 1,
          windowId,
          tab,
          selected: tabSelected[w]?.[t] === true,
          id,
          title: titles[w]?.[t]?.[s] ?? '',
          cwd: dirs[w]?.[t]?.[s] ?? '',
        })
      }
    }
  }
  return rows
}

/** @returns {Reply} */
function listGhostty() {
  const terminals = readGhostty() ?? readGhostty()
  if (terminals === undefined) {
    return { error: 'Ghostty tabs changed while they were read', number: null }
  }
  return { ok: true, terminals }
}

/**
 * @param {GhosttyApp} ghostty
 * @param {string} id
 * @returns {Reply}
 */
function focusTerminal(ghostty, id) {
  ghostty.focus(ghostty.terminals.byId(id))
  ghostty.activate()
  return { ok: true, terminalId: id }
}

/**
 * @param {string} id
 * @returns {Reply}
 */
function focusGhostty(id) {
  const ghostty = Application('Ghostty')
  if (!ghostty.terminals.id().includes(id)) {
    return { error: 'that Ghostty tab is gone', number: null }
  }
  return focusTerminal(ghostty, id)
}

/**
 * @param {GhosttyApp} ghostty
 * @param {string} marker
 * @returns {string | undefined}
 */
function findMarker(ghostty, marker) {
  const ids = ghostty.terminals.id()
  const at = ghostty.terminals.name().indexOf(marker)
  return at < 0 ? undefined : ids[at]
}

/**
 * Ghostty does not say which tty a terminal runs, so this sets a unique title
 * on the tty, finds the terminal showing it, and puts the old title back.
 *
 * @param {string} tty
 * @returns {Reply}
 */
function focusGhosttyTty(tty) {
  const ghostty = Application('Ghostty')
  const ids = ghostty.terminals.id()
  const titles = ghostty.terminals.name()
  /** @type {Map<string, string>} */
  const before = new Map(ids.map((id, i) => [id, titles[i] ?? '']))
  const marker = `sessionz ${tty} ${String(Date.now())}`

  writeTitle(tty, marker)
  let found = undefined
  for (let poll = 0; poll < MARKER_POLLS && found === undefined; poll++) {
    delay(MARKER_POLL_SECONDS)
    found = findMarker(ghostty, marker)
  }
  if (found === undefined) {
    delay(LATE_MARKER_SECONDS)
    found = findMarker(ghostty, marker)
  }
  if (found === undefined) {
    return { error: 'no Ghostty tab showed the marker title', number: null }
  }
  writeTitle(tty, before.get(found) ?? '')
  return focusTerminal(ghostty, found)
}

/**
 * @param {string} tty
 * @returns {Reply}
 */
function focusIterm(tty) {
  const iterm = Application('com.googlecode.iterm2')
  const device = devicePath(tty)
  const windows = iterm.windows.tabs.sessions.tty()
  for (const [w, tabs] of windows.entries()) {
    for (const [t, sessions] of tabs.entries()) {
      const s = sessions.indexOf(device)
      if (s < 0) continue
      const window = iterm.windows.at(w)
      const tab = window.tabs.at(t)
      tab.sessions.at(s).select()
      tab.select()
      window.select()
      iterm.activate()
      return { ok: true }
    }
  }
  return { error: `no iTerm2 session runs on ${tty}`, number: null }
}

/**
 * @param {string} tty
 * @returns {Reply}
 */
function focusTerminalApp(tty) {
  const terminal = Application('com.apple.Terminal')
  const device = devicePath(tty)
  const windows = terminal.windows.tabs.tty()
  for (const [w, tabs] of windows.entries()) {
    const t = tabs.indexOf(device)
    if (t < 0) continue
    const window = terminal.windows.at(w)
    window.tabs.at(t).selected = true
    window.index = 1
    terminal.activate()
    return { ok: true }
  }
  return { error: `no Terminal tab runs on ${tty}`, number: null }
}

/**
 * @param {unknown} error
 * @returns {Reply}
 */
function failure(error) {
  if (!(error instanceof Error)) return { error: String(error), number: null }
  const number =
    'errorNumber' in error && typeof error.errorNumber === 'number'
      ? error.errorNumber
      : null
  return { error: error.message, number }
}

/**
 * @param {string} command
 * @param {string} arg
 * @returns {Reply}
 */
function dispatch(command, arg) {
  switch (command) {
    case 'list-ghostty':
      return listGhostty()
    case 'focus-ghostty':
      return focusGhostty(arg)
    case 'focus-ghostty-tty':
      return focusGhosttyTty(arg)
    case 'focus-iterm':
      return focusIterm(arg)
    case 'focus-terminal':
      return focusTerminalApp(arg)
    default:
      return { error: `unknown command: ${command}`, number: null }
  }
}

/**
 * @param {readonly string[]} argv
 * @returns {string}
 */
globalThis.run = function (argv) {
  try {
    return JSON.stringify(dispatch(argv[0] ?? '', argv[1] ?? ''))
  } catch (error) {
    return JSON.stringify(failure(error))
  }
}
