/**
 * The few JavaScript for Automation calls scripts/terminals.js makes, typed by
 * hand from each app's scripting dictionary (`sdef /Applications/<App>.app`).
 *
 * Reading a property of an element array (`windows.tabs.terminals.id()`)
 * returns one value per element, nested one array per level.
 */

interface ElementArray<T> {
  (): T[]
  at(index: number): T
}

interface GhosttyTerminal {
  name(): string
}

interface GhosttyApp {
  windows: {
    id(): string[]
    tabs: {
      index(): number[][]
      selected(): boolean[][]
      terminals: {
        id(): string[][][]
        name(): string[][][]
        workingDirectory(): string[][][]
      }
    }
  }
  terminals: {
    id(): string[]
    name(): string[]
    byId(id: string): GhosttyTerminal
  }
  focus(terminal: GhosttyTerminal): void
  activate(): void
}

interface ITermSession {
  select(): void
}

interface ITermTab {
  sessions: ElementArray<ITermSession>
  select(): void
}

interface ITermWindow {
  tabs: ElementArray<ITermTab>
  select(): void
}

interface ITermApp {
  windows: ElementArray<ITermWindow> & {
    tabs: { sessions: { tty(): string[][][] } }
  }
  activate(): void
}

interface TerminalTab {
  selected: boolean
}

interface TerminalWindow {
  tabs: ElementArray<TerminalTab>
  index: number
}

interface TerminalApp {
  windows: ElementArray<TerminalWindow> & { tabs: { tty(): string[][] } }
  activate(): void
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
  dataUsingEncoding(encoding: string): NSData
}

interface NSFileHandle {
  isNil(): boolean
  writeData(data: NSData): void
}

interface ObjCBridge {
  (text: string): NSString
  NSFileHandle: {
    fileHandleForWritingAtPath(path: string): NSFileHandle
  }
  /** JXA hands every NSUInteger over as a string: this is "4". */
  NSUTF8StringEncoding: string
}

declare const $: ObjCBridge

declare const ObjC: {
  import(framework: string): void
}

/** osascript calls the script's run(argv) and prints what it returns. */
declare function run(argv: readonly string[]): string
