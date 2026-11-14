import { describe, expect, test } from 'claude-code/testing'

import type { Engine } from 'claude-code/testing'
import { A, B, LABELS, LIST, LIST_TOOL, ROOT, chrome, labelsOf } from './world'

const CACHED = {
  [A]: {
    browser: 'Google Chrome',
    userDataDir: ROOT,
    profileDir: 'Default',
    name: 'Work',
    email: 'some.one@example.com',
    seenAt: '2026-11-14T00:00:00.000Z',
  },
}
const TWO = [
  { type: 'text', text: JSON.stringify(LIST.slice(0, 2)) },
  { type: 'text', text: 'Two browsers are connected.' },
]

async function run($: Engine, args: string): Promise<string | undefined> {
  const answer = await $.command.run({
    command: 'chrome-profile',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
  return answer.text
}

describe('the device cache', () => {
  test('stands in for files that cannot be read', async ($, on) => {
    chrome(on, { failing: ['leveldb'], seed: { devices: CACHED } })

    expect(labelsOf(await $.tool.call({ tool: LIST_TOOL }))).toEqual([
      'Work (some.one@example.com) · Office Mac',
      'Browser 2 (profile unknown) · a Windows computer',
      'Browser 3 (profile unknown) · a macOS computer',
    ])
  })

  test('this computer’s name is saved, and used when scutil fails', async ($, on) => {
    const store = chrome(on)

    await $.tool.call({ tool: LIST_TOOL })

    expect(store.get('computer')).toBe('Office Mac')
  })

  test('a saved computer name stands in for scutil', async ($, on) => {
    chrome(on, { failing: ['scutil'], seed: { computer: 'Saved Mac' } })

    expect(labelsOf(await $.tool.call({ tool: LIST_TOOL }))).toEqual([
      'Work (some.one@example.com) · Saved Mac',
      LABELS[1],
      LABELS[2],
    ])
  })
})

describe('names you gave', () => {
  test('label a browser whose profile and computer are unknown', async ($, on) => {
    chrome(on, {
      seed: { names: { [B]: { profile: 'Laptop work', machine: 'Home PC' } } },
    })

    expect(labelsOf(await $.tool.call({ tool: LIST_TOOL }))[1]).toBe(
      'Laptop work (named by you) · Home PC',
    )
  })

  test('give way to the real profile once the files can be read', async ($, on) => {
    chrome(on, { seed: { names: { [A]: { profile: 'Old name' } } } })

    expect(labelsOf(await $.tool.call({ tool: LIST_TOOL }))[0]).toBe(LABELS[0])
  })
})

describe('/chrome-profile name and machine', () => {
  test('one unknown browser is named without a question', async ($, on) => {
    const store = chrome(on, {
      listAnswer: { result: TWO, text: '' },
      ask: () => 'asked',
    })

    expect(await run($, 'name Laptop work')).toBe(
      'Browser 2 (profile unknown) · another Windows computer is now Laptop work (named by you) · another Windows computer.',
    )
    expect(store.get('names')).toEqual({ [B]: { profile: 'Laptop work' } })
  })

  test('with several unknown browsers, you pick which one', async ($, on) => {
    const store = chrome(on, {
      ask: labels => labels.find(label => label.startsWith('Browser 2')) ?? '',
    })

    await run($, 'machine Home PC')

    expect(store.get('names')).toEqual({ [B]: { machine: 'Home PC' } })
    expect(labelsOf(await $.tool.call({ tool: LIST_TOOL }))[1]).toBe(
      'Browser 2 (profile unknown) · Home PC',
    )
  })

  test('an answer that picks no browser names nothing', async ($, on) => {
    const store = chrome(on, { ask: () => 'something else' })

    expect(await run($, 'name Laptop')).toBe('Nothing was named.')
    expect(store.has('names')).toBe(false)
  })

  test('with every profile known, there is nothing to name', async ($, on) => {
    chrome(on, {
      listAnswer: {
        result: [{ type: 'text', text: JSON.stringify(LIST.slice(0, 1)) }],
        text: '',
      },
    })

    expect(await run($, 'name Laptop')).toBe(
      'Every connected browser’s profile is already known.',
    )
  })

  test('no browsers connected', async ($, on) => {
    chrome(on, {
      listAnswer: { result: [{ type: 'text', text: '[]' }], text: '' },
    })

    expect(await run($, 'name Laptop')).toBe('No browsers are connected.')
  })
})
