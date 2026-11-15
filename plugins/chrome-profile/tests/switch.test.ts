import type { ToolCallResult } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import {
  A,
  B,
  LABELS,
  LIST_TOOL,
  SELECT_TOOL,
  blocksOf,
  chrome,
  textOf,
} from './world'

const UNLISTED = 'dddddddd-0000-4000-8000-000000000004'
const NOT_FOUND = `No connected browser has deviceId "${UNLISTED}".`
const FAILED: ToolCallResult = {
  result: [{ type: 'text', text: NOT_FOUND }],
  text: NOT_FOUND,
  isError: true,
}

describe('Claude’s own select_browser', () => {
  test('its result names the label of the browser it selected', async ($, on) => {
    chrome(on)

    const result = await $.tool.call({ tool: SELECT_TOOL, deviceId: B })
    const text = `Selected browser "${LABELS[1] ?? ''}".`

    expect(textOf(blocksOf(result)[0])).toBe(text)
    expect(result.text).toBe(text)
  })

  test('it marks the session chosen', async ($, on) => {
    const { states } = chrome(on)

    await $.tool.call({ tool: SELECT_TOOL, deviceId: A })

    expect(states.get('chosen')).toBe(true)
  })

  test('a failed one goes to Claude untouched and chooses nothing', async ($, on) => {
    const { states } = chrome(on, { selectAnswer: FAILED })

    const result = await $.tool.call({ tool: SELECT_TOOL, deviceId: UNLISTED })

    expect(result).toMatchObject({ isError: true, text: NOT_FOUND })
    expect(states.has('chosen')).toBe(false)
  })

  test('a browser the list does not show keeps its result', async ($, on) => {
    chrome(on)

    const result = await $.tool.call({ tool: SELECT_TOOL, deviceId: UNLISTED })

    expect(result.text).toBe('Selected browser "Browser 9".')
  })

  test('with no list to read, the result stays as it was', async ($, on) => {
    const { states } = chrome(on, { failing: ['bridge'] })

    const result = await $.tool.call({ tool: SELECT_TOOL, deviceId: B })

    expect(result.text).toBe('Selected browser "Browser 2".')
    expect(states.get('chosen')).toBe(true)
  })
})

describe('when the mod cannot list the browsers itself', () => {
  test('a switch is labelled from the list Claude last got', async ($, on) => {
    chrome(on, { failing: ['bridge'] })

    await $.tool.call({ tool: LIST_TOOL })
    const result = await $.tool.call({ tool: SELECT_TOOL, deviceId: B })

    expect(result.text).toBe(`Selected browser "${LABELS[1] ?? ''}".`)
  })
})
