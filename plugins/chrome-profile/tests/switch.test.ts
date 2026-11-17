import type { ToolCallResult } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import {
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

  test('a failed one goes to Claude untouched', async ($, on) => {
    chrome(on, { selectAnswer: FAILED })

    const result = await $.tool.call({ tool: SELECT_TOOL, deviceId: UNLISTED })

    expect(result).toMatchObject({ isError: true, text: NOT_FOUND })
  })

  test('a browser the list does not show keeps its result', async ($, on) => {
    chrome(on)

    const result = await $.tool.call({ tool: SELECT_TOOL, deviceId: UNLISTED })

    expect(result.text).toBe('Selected browser "Browser 9".')
  })

  test('with no list to read, the result stays as it was', async ($, on) => {
    chrome(on, { failing: ['bridge'] })

    const result = await $.tool.call({ tool: SELECT_TOOL, deviceId: B })

    expect(result.text).toBe('Selected browser "Browser 2".')
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
