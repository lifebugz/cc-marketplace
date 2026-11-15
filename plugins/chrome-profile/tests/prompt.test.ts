import type { PromptSubmitResult, ToolCallResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, test } from 'claude-code/testing'

import {
  B,
  C,
  LABELS,
  LIST,
  LIST_TOOL,
  NAVIGATE_TOOL,
  SELECT_TOOL,
  chrome,
} from './world'

const URL = 'https://example.com'
const LINE =
  'Connected Chrome profiles: Work (some.one@example.com) · Office Mac (also: web.one@example.com) [in use], ' +
  'Browser 2 (profile unknown) · another Windows computer, ' +
  'Browser 3 (profile unknown) · another macOS computer. Switch with select_browser.'
const ONE_BROWSER = {
  result: [{ type: 'text', text: JSON.stringify(LIST.slice(0, 1)) }],
  text: '',
}
const FAILED: ToolCallResult = {
  result: [{ type: 'text', text: 'No connected browser has that deviceId.' }],
  text: 'No connected browser has that deviceId.',
  isError: true,
}

async function submit(
  $: Engine,
  text: string,
  context?: readonly string[],
): Promise<PromptSubmitResult> {
  return $.prompt.submit({
    text,
    wait: false,
    origin: { kind: 'composer' },
    ...(context === undefined ? {} : { context }),
  })
}

describe('the session’s first browser call', () => {
  test('carries the profile list for Claude', async ($, on) => {
    const { states } = chrome(on)

    const result = await $.tool.call({ tool: NAVIGATE_TOOL, url: URL })

    expect(result.context).toEqual([LINE])
    expect(result.text).toBe('ok')
    expect(states.get('browserUsed')).toBe(true)
  })

  test('later browser calls carry nothing and list nothing', async ($, on) => {
    const { mcpCalls } = chrome(on)

    await $.tool.call({ tool: NAVIGATE_TOOL, url: URL })
    const second = await $.tool.call({ tool: NAVIGATE_TOOL, url: URL })

    expect(second.context).toBeUndefined()
    expect(mcpCalls).toEqual(['list_connected_browsers'])
  })

  test('a first switch carries the list beside its label, from one list call', async ($, on) => {
    const { mcpCalls } = chrome(on)

    const result = await $.tool.call({ tool: SELECT_TOOL, deviceId: B })

    expect(result.context).toEqual([LINE])
    expect(result.text).toBe(`Selected browser "${LABELS[1] ?? ''}".`)
    expect(mcpCalls).toEqual(['list_connected_browsers'])
  })

  test('a first list counts, and adds nothing to what it already shows', async ($, on) => {
    const { states } = chrome(on)

    const result = await $.tool.call({ tool: LIST_TOOL })

    expect(result.context).toBeUndefined()
    expect(states.get('browserUsed')).toBe(true)
  })

  test('with one browser connected, there is no list to add', async ($, on) => {
    const { states } = chrome(on, { listAnswer: ONE_BROWSER })

    const result = await $.tool.call({ tool: NAVIGATE_TOOL, url: URL })

    expect(result.context).toBeUndefined()
    expect(states.get('browserUsed')).toBe(true)
  })

  test('a call that failed does not count', async ($, on) => {
    const { states } = chrome(on, { selectAnswer: FAILED })

    await $.tool.call({ tool: SELECT_TOOL, deviceId: B })

    expect(states.has('browserUsed')).toBe(false)
  })
})

describe('the line beside each prompt', () => {
  test('before the first browser call, a prompt gets nothing and lists nothing', async ($, on) => {
    const { contexts, mcpCalls } = chrome(on)

    await submit($, 'hello')

    expect(contexts).toEqual([[]])
    expect(mcpCalls).toEqual([])
  })

  test('after it, every prompt gets the line', async ($, on) => {
    const { contexts } = chrome(on)

    await $.tool.call({ tool: NAVIGATE_TOOL, url: URL })
    await submit($, 'one')
    await submit($, 'two')

    expect(contexts).toEqual([[LINE], [LINE]])
  })

  test('the line comes after the context the prompt already has', async ($, on) => {
    const { contexts } = chrome(on)

    await $.tool.call({ tool: NAVIGATE_TOOL, url: URL })
    await submit($, 'one', ['from another plugin'])

    expect(contexts).toEqual([['from another plugin', LINE]])
  })

  test('with one browser connected, there is no line', async ($, on) => {
    const { contexts } = chrome(on, { listAnswer: ONE_BROWSER })

    await $.tool.call({ tool: NAVIGATE_TOOL, url: URL })
    await submit($, 'one')

    expect(contexts).toEqual([[]])
  })

  test('a list that fails gives no line, and the prompt still goes in', async ($, on) => {
    const { contexts, mcpCalls } = chrome(on, { failing: ['bridge'] })

    await $.tool.call({ tool: NAVIGATE_TOOL, url: URL })
    const entered = await submit($, 'one')

    expect(entered.text).toBe('one')
    expect(contexts).toEqual([[]])
    expect(mcpCalls).toHaveLength(2)
  })

  test('a list that takes 1 second or more gives no line', async ($, on) => {
    const { contexts, clock } = chrome(on, { listDelayMs: 1500 })

    const first = $.tool.call({ tool: NAVIGATE_TOOL, url: URL })
    await clock.settle()
    await clock.advance(1500)
    await first
    const entered = submit($, 'slow')
    await clock.settle()
    await clock.advance(1000)
    await entered

    expect(contexts).toEqual([[]])
  })

  test('a list just under 1 second still gives the line', async ($, on) => {
    const { contexts, clock } = chrome(on, { listDelayMs: 900 })

    const first = $.tool.call({ tool: NAVIGATE_TOOL, url: URL })
    await clock.settle()
    await clock.advance(900)
    await first
    const entered = submit($, 'quick')
    await clock.settle()
    await clock.advance(900)
    await entered

    expect(contexts).toEqual([[LINE]])
  })
})

describe('calls that are not Claude’s', () => {
  test(
    'another plugin’s browser call does not turn the line on',
    {
      plugins: [
        {
          name: 'other',
          register: (on): void => {
            on('command.run', { command: 'browse' }, async $ => {
              await $.tool.call({
                tool: 'mcp__claude-in-chrome__navigate',
                url: 'https://example.com',
              })
              return { text: 'browsed' }
            })
          },
        },
      ],
    },
    async ($, on) => {
      const { contexts, mcpCalls, states } = chrome(on)

      await $.command.run({
        command: 'browse',
        args: '',
        origin: { kind: 'composer' },
        presentation: { isFullscreen: true, columns: 120 },
      })
      await submit($, 'one')

      expect(states.has('browserUsed')).toBe(false)
      expect(mcpCalls).toEqual([])
      expect(contexts).toEqual([[]])
    },
  )
})

describe('when the mod cannot list the browsers itself', () => {
  test('the line comes from the list Claude last got, with its switch in use', async ($, on) => {
    const { contexts } = chrome(on, { failing: ['bridge'] })

    await $.tool.call({ tool: NAVIGATE_TOOL, url: URL })
    await $.tool.call({ tool: LIST_TOOL })
    await $.tool.call({ tool: SELECT_TOOL, deviceId: C })
    await submit($, 'one')

    expect(contexts).toEqual([
      [
        'Connected Chrome profiles: Work (some.one@example.com) · Office Mac (also: web.one@example.com), ' +
          'Browser 2 (profile unknown) · another Windows computer, ' +
          'Browser 3 (profile unknown) · another macOS computer [in use]. Switch with select_browser.',
      ],
    ])
  })
})
