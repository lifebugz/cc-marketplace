import type { ProcessRunResult } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import {
  failureText,
  readReply,
  switchTo,
  VSCODE_SETTLE_MS,
  type Io,
} from '../hooks/hosts'
import type { Target } from '../types'
import { CLIENTS, PS, ran } from './fixtures'

const ROOT = '/plugins/sessionz'
const SCRIPT = ['osascript', '-l', 'JavaScript', `${ROOT}/scripts/terminals.js`]
const VSCODE = '/Applications/Visual Studio Code.app'

type Answer = (argv: readonly string[]) => ProcessRunResult | string

interface Fake {
  io: Io
  argvs: string[][]
  slept: number[]
}

function fake(answer: Answer = () => ran('{"ok":true}')): Fake {
  const argvs: string[][] = []
  const slept: number[] = []
  return {
    argvs,
    slept,
    io: {
      root: ROOT,
      run: argv => {
        argvs.push([...argv])
        return Promise.resolve(answer(argv))
      },
      sleep: ms => {
        slept.push(ms)
        return Promise.resolve()
      },
    },
  }
}

describe('reading what osascript printed', () => {
  test('an ok reply carries its fields', () => {
    expect(readReply(ran('{"ok":true,"terminalId":"T-1"}\n'))).toEqual({
      ok: true,
      fields: { ok: true, terminalId: 'T-1' },
    })
  })

  test('an error reply carries its message and number', () => {
    expect(readReply(ran('{"error":"Not authorized","number":-1743}'))).toEqual(
      { ok: false, error: 'Not authorized', number: -1743 },
    )
  })

  test('an error osascript itself printed ends with its number', () => {
    const reply = readReply(
      ran(
        '',
        1,
        'execution error: Not authorized to send Apple events to iTerm2. (-1744)\n',
      ),
    )
    expect(reply).toMatchObject({ ok: false, number: -1744 })
  })

  test('both Automation denials become the permission message', () => {
    for (const number of [-1743, -1744]) {
      expect(failureText('iTerm2', { error: 'denied', number })).toContain(
        'Privacy & Security → Automation',
      )
    }
    expect(failureText('iTerm2', { error: 'boom', number: -1 })).toBe(
      'sessionz: could not switch to iTerm2: boom',
    )
  })
})

describe('switching runs the right commands per host', () => {
  test('Ghostty, iTerm2 and Terminal go through the JXA script', async () => {
    const cases: [Target, string[]][] = [
      [
        { kind: 'ghostty', terminalId: 'T-1' },
        [...SCRIPT, 'focus-ghostty', 'T-1'],
      ],
      [
        { kind: 'ghostty-tty', tty: 'ttys010' },
        [...SCRIPT, 'focus-ghostty-tty', 'ttys010'],
      ],
      [
        { kind: 'iterm', tty: 'ttys002' },
        [...SCRIPT, 'focus-iterm', 'ttys002'],
      ],
      [
        { kind: 'terminal', tty: 'ttys003' },
        [...SCRIPT, 'focus-terminal', 'ttys003'],
      ],
    ]
    for (const [target, argv] of cases) {
      const world = fake()
      expect(await switchTo(world.io, target)).toMatchObject({ ok: true })
      expect(world.argvs).toEqual([argv])
    }
  })

  test('the marker hands back the terminal it found', async () => {
    const world = fake(() => ran('{"ok":true,"terminalId":"T-docs-b"}'))
    expect(
      await switchTo(world.io, { kind: 'ghostty-tty', tty: 'ttys010' }),
    ).toEqual({ ok: true, terminalId: 'T-docs-b', note: null })
  })

  test('an Automation denial becomes the permission message', async () => {
    const world = fake(() => ran('{"error":"Not authorized","number":-1743}'))
    const result = await switchTo(world.io, { kind: 'iterm', tty: 'ttys002' })
    expect(result).toMatchObject({ ok: false })
    if (result.ok) throw new Error('expected a failure')
    expect(result.message).toContain('System Settings')
  })

  test('tmux selects the pane, moves a client, then focuses its outer tab', async () => {
    const world = fake(argv => {
      if (argv[1] === 'list-clients') {
        return ran('/dev/ttys005\tother\t1790000000\t112\n')
      }
      if (argv[0] === 'ps') return ran(PS)
      return ran(
        argv[0] === 'osascript' ? '{"ok":true,"terminalId":"T-x"}' : '',
      )
    })
    expect(
      await switchTo(world.io, { kind: 'tmux', paneId: '%7', session: 'main' }),
    ).toEqual({ ok: true, terminalId: null, note: null })
    expect(world.argvs).toEqual([
      ['tmux', 'select-window', '-t', '%7'],
      ['tmux', 'select-pane', '-t', '%7'],
      expect.arrayContaining(['tmux', 'list-clients']),
      ['tmux', 'switch-client', '-c', '/dev/ttys005', '-t', '%7'],
      ['ps', '-A', '-o', 'pid=,ppid=,tty=,comm='],
      [...SCRIPT, 'focus-ghostty-tty', 'ttys005'],
    ])
  })

  test('tmux leaves a client that already shows the session where it is', async () => {
    const world = fake(argv => {
      if (argv[1] === 'list-clients') return ran(CLIENTS)
      if (argv[0] === 'ps') return ran(PS)
      return ran(argv[0] === 'osascript' ? '{"ok":true}' : '')
    })
    await switchTo(world.io, { kind: 'tmux', paneId: '%7', session: 'main' })
    expect(world.argvs.some(argv => argv[1] === 'switch-client')).toBe(false)
  })

  test('tmux with no client says it is not attached', async () => {
    const world = fake(() => ran(''))
    expect(
      await switchTo(world.io, { kind: 'tmux', paneId: '%7', session: 'main' }),
    ).toEqual({ ok: false, message: 'tmux: not attached' })
  })

  test('the VS Code panel opens its folder window, then the session tab', async () => {
    const world = fake(() => ran(''))
    await switchTo(world.io, {
      kind: 'vscode-panel',
      app: VSCODE,
      cwd: '/Users/someone/projects/shop',
      sessionId: 'abc-123',
    })
    expect(world.argvs).toEqual([
      ['open', '-a', VSCODE, '/Users/someone/projects/shop'],
      ['open', 'vscode://anthropic.claude-code/open?session=abc-123'],
    ])
    expect(world.slept).toEqual([VSCODE_SETTLE_MS])
  })

  test('a VS Code terminal only brings the window forward, and says so', async () => {
    const world = fake(() => ran(''))
    const result = await switchTo(world.io, {
      kind: 'vscode-terminal',
      app: VSCODE,
    })
    expect(world.argvs).toEqual([['open', '-a', VSCODE]])
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error('expected success')
    expect(result.note).toContain('pick the terminal tab')
  })

  test('a program that cannot start becomes a message, never a throw', async () => {
    const world = fake(() => 'osascript did not run: not found')
    expect(
      await switchTo(world.io, { kind: 'terminal', tty: 'ttys003' }),
    ).toEqual({
      ok: false,
      message:
        'sessionz: could not switch to Terminal: osascript did not run: not found',
    })
  })
})
