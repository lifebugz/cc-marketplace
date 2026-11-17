import type { PromptSubmitResult, ToolCallResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, test } from 'claude-code/testing'

import type { Source } from './world'
import { B, LIST_TOOL, NAVIGATE_TOOL, SELECT_TOOL, chrome } from './world'

type Name = 'navigate' | 'list' | 'select'

const URL = 'https://example.com'
const AGENT = 'a1'
const NAMES: readonly Name[] = ['navigate', 'list', 'select']
const TOOLS: Readonly<Record<Name, string>> = {
  navigate: NAVIGATE_TOOL,
  list: LIST_TOOL,
  select: SELECT_TOOL,
}
const SOURCES: readonly Source[] = [
  'localState',
  'listing',
  'leveldb',
  'preferences',
  'extensions',
  'scutil',
  'store',
  'bridge',
]
const FAILURES: readonly (readonly [string, readonly Source[]])[] = [
  ['no source fails', []],
  ...SOURCES.map((source): readonly [string, readonly Source[]] => [
    `${source} fails`,
    [source],
  ]),
  ['every source fails', SOURCES],
]

async function call(
  $: Engine,
  name: Name,
  agentId?: string,
): Promise<ToolCallResult> {
  const agent = agentId === undefined ? {} : { agentId }
  if (name === 'navigate') {
    return $.tool.call({ tool: NAVIGATE_TOOL, url: URL, ...agent })
  }
  if (name === 'list') {
    return $.tool.call({ tool: LIST_TOOL, ...agent })
  }
  return $.tool.call({ tool: SELECT_TOOL, deviceId: B, ...agent })
}

async function submit($: Engine): Promise<PromptSubmitResult> {
  return $.prompt.submit({
    text: 'one',
    wait: false,
    origin: { kind: 'composer' },
  })
}

describe('the mod never refuses or holds a browser call', () => {
  for (const [what, failing] of FAILURES) {
    for (const first of NAMES) {
      test(`${what}, ${first} first`, async ($, on) => {
        const { toolCalls, contexts } = chrome(on, { failing })
        const order = [first, ...NAMES.filter(name => name !== first)]
        const results: ToolCallResult[] = []

        for (const name of [...order, ...order]) {
          results.push(await call($, name))
        }
        for (const name of order) {
          results.push(await call($, name, AGENT))
        }
        const prompt = await submit($)

        for (const result of results) {
          expect(result.deny).toBeUndefined()
          expect(result.isError).toBeUndefined()
        }
        expect(toolCalls).toEqual(
          [...order, ...order, ...order].map(name => TOOLS[name]),
        )
        expect(prompt.drop).toBeUndefined()
        expect(contexts).toHaveLength(1)
      })
    }
  }
})
