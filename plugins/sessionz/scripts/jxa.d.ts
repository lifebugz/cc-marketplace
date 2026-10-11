/**
 * The few JavaScript for Automation calls scripts/terminals.js makes, typed by
 * hand from each app's scripting dictionary (`sdef /Applications/<App>.app`).
 *
 * Reading a property of an element array (`windows.tabs.terminals.id()`)
 * returns one value per element, nested one array per level.
 */

interface ElementArray<T> {
  (): T[]
  readonly at: (index: number) => T
}

interface GhosttyTerminal {
  readonly name: () => string
}

interface GhosttyApp {
  windows: {
    readonly id: () => string[]
    tabs: {
      readonly index: () => number[][]
      readonly selected: () => boolean[][]
      terminals: {
        readonly id: () => string[][][]
        readonly name: () => string[][][]
        readonly workingDirectory: () => string[][][]
      }
    }
  }
  terminals: {
    readonly id: () => string[]
    readonly name: () => string[]
    readonly byId: (id: string) => GhosttyTerminal
  }
  readonly focus: (terminal: GhosttyTerminal) => void
  readonly activate: () => void
}

interface ITermSession {
  readonly select: () => void
}

interface ITermTab {
  sessions: ElementArray<ITermSession>
  readonly select: () => void
}

interface ITermWindow {
  tabs: ElementArray<ITermTab>
  readonly select: () => void
}

interface ITermApp {
  windows: ElementArray<ITermWindow> & {
    tabs: { sessions: { tty: () => string[][][] } }
  }
  readonly activate: () => void
}

interface TerminalTab {
  selected: boolean
}

interface TerminalWindow {
  tabs: ElementArray<TerminalTab>
  index: number
}

interface TerminalApp {
  windows: ElementArray<TerminalWindow> & { tabs: { tty: () => string[][] } }
  readonly activate: () => void
}

declare function Application(name: 'Ghostty'): GhosttyApp
declare function Application(name: 'com.googlecode.iterm2'): ITermApp
declare function Application(name: 'com.apple.Terminal'): TerminalApp

/** Waits, in seconds. */
declare function delay(seconds: number): void

interface NSData {
  readonly length: string
}

interface NSString {
  readonly dataUsingEncoding: (encoding: string) => NSData
}

interface NSFileHandle {
  readonly isNil: () => boolean
  readonly writeData: (data: NSData) => void
}

interface ObjCBridge {
  (text: string): NSString
  NSFileHandle: {
    readonly fileHandleForWritingAtPath: (path: string) => NSFileHandle
  }
  /** JXA hands every NSUInteger over as a string: this is "4". */
  NSUTF8StringEncoding: string
}

declare const $: ObjCBridge

declare const ObjC: {
  readonly import: (framework: string) => void
}

/** osascript calls the script's run(argv) and prints what it returns. */
declare function run(argv: readonly string[]): string
