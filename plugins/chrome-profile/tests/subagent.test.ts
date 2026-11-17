import { describe, expect, test } from 'claude-code/testing'

import {
  B,
  LABELS,
  LIST_TOOL,
  NAVIGATE_TOOL,
  SELECT_TOOL,
  chrome,
  labelsOf,
} from './world'

const URL = 'https://example.com'
const AGENT = 'a1'
const LINE = expect.stringContaining('Connected Chrome profiles: ')

describe('a subagent’s browser calls get the same labels as Claude’s', () => {
  test('its first call carries the profile list', async ($, on) => {
    const { states } = chrome(on)

    const result = await $.tool.call({
      tool: NAVIGATE_TOOL,
      url: URL,
      agentId: AGENT,
    })

    expect(result.text).toBe('ok')
    expect(result.context).toEqual([LINE])
    expect(states.get('browserUsed')).toBe(true)
  })

  test('its list has the labels', async ($, on) => {
    chrome(on)

    const result = await $.tool.call({ tool: LIST_TOOL, agentId: AGENT })

    expect(labelsOf(result)).toEqual(LABELS)
  })

  test('its switch names the label', async ($, on) => {
    chrome(on)

    const result = await $.tool.call({
      tool: SELECT_TOOL,
      deviceId: B,
      agentId: AGENT,
    })

    expect(result.text).toBe(`Selected browser "${LABELS[1] ?? ''}".`)
  })

  test('after its first call, Claude gets the line on the next prompt', async ($, on) => {
    const { contexts } = chrome(on)

    await $.tool.call({ tool: NAVIGATE_TOOL, url: URL, agentId: AGENT })
    const claudes = await $.tool.call({ tool: NAVIGATE_TOOL, url: URL })
    await $.prompt.submit({
      text: 'one',
      wait: false,
      origin: { kind: 'composer' },
    })

    expect(claudes.context).toBeUndefined()
    expect(contexts).toEqual([[LINE]])
  })
})
