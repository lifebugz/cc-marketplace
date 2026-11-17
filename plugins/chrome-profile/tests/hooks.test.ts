import { describe, expect, test } from 'claude-code/testing'

import type { Source } from './world'
import {
  ROOT,
  LIST_TOOL,
  A,
  LIST,
  BLOCKS,
  isRecord,
  blocksOf,
  textOf,
  entriesOf,
  labelsOf,
  LABELS,
  chrome,
} from './world'

describe('the browser list Claude reads', () => {
  test('every browser gets its label, profile and computer', async ($, on) => {
    chrome(on)

    const result = await $.tool.call({ tool: LIST_TOOL })
    const [first, second] = entriesOf(result)

    expect(labelsOf(result)).toEqual(LABELS)
    expect(first).toEqual({
      ...LIST[0],
      name: LABELS[0],
      bridgeName: 'Browser 1',
      profile: {
        browser: 'Google Chrome',
        userDataDir: ROOT,
        profileDir: 'Default',
        name: 'Work',
        email: 'some.one@example.com',
        accounts: [
          { email: 'some.one@example.com' },
          { email: 'web.one@example.com' },
        ],
      },
      machine: { name: 'Office Mac', isThisComputer: true, os: 'macOS' },
      extensionVersion: '1.0.107',
    })
    expect(second).toEqual({
      ...LIST[1],
      name: LABELS[1],
      bridgeName: 'Browser 2',
      machine: {
        name: 'another Windows computer',
        isThisComputer: false,
        os: 'Windows',
      },
    })
  })

  test('the sentence and the text field carry the labels too', async ($, on) => {
    chrome(on)

    const result = await $.tool.call({ tool: LIST_TOOL })
    const blocks = blocksOf(result)

    expect(textOf(blocks[1])).toBe(
      `3 browsers are connected; "${LABELS[0] ?? ''}" (deviceId ${A}) is the one picked last and will be used.`,
    )
    expect(result.text).toBe(`${textOf(blocks[0])}\n${textOf(blocks[1])}`)
  })

  test('the device cache is saved, with no password data', async ($, on) => {
    const { store } = chrome(on)

    await $.tool.call({ tool: LIST_TOOL })
    const devices = store.get('devices')

    expect(
      isRecord(devices) && isRecord(devices[A])
        ? devices[A]['profileDir']
        : undefined,
    ).toBe('Default')
    expect(JSON.stringify(devices)).not.toContain('secret')
  })

  test('a refused list goes to Claude untouched', async ($, on) => {
    chrome(on, { listAnswer: { deny: 'no browser' } })

    expect(await $.tool.call({ tool: LIST_TOOL })).toMatchObject({
      deny: 'no browser',
    })
  })

  test('a list the tool marked as an error goes to Claude untouched', async ($, on) => {
    chrome(on, {
      listAnswer: { result: BLOCKS, text: 'original', isError: true },
    })

    expect(labelsOf(await $.tool.call({ tool: LIST_TOOL }))).toEqual(
      LIST.map(entry => entry.name),
    )
  })
})

describe('best effort: a failing source costs only its own fields', () => {
  const cases: readonly (readonly [Source, readonly string[]])[] = [
    [
      'localState',
      [
        'Default (web: some.one@example.com) · Office Mac',
        LABELS[1] ?? '',
        LABELS[2] ?? '',
      ],
    ],
    ['listing', LABELS],
    ['preferences', LABELS],
    ['extensions', LABELS],
    ['store', LABELS],
    [
      'scutil',
      [
        'Work (some.one@example.com) · this computer',
        LABELS[1] ?? '',
        LABELS[2] ?? '',
      ],
    ],
    [
      'leveldb',
      [
        'Browser 1 (profile unknown) · a macOS computer',
        'Browser 2 (profile unknown) · a Windows computer',
        'Browser 3 (profile unknown) · a macOS computer',
      ],
    ],
  ]
  for (const [source, labels] of cases) {
    test(`${source} refused`, async ($, on) => {
      chrome(on, { failing: [source] })

      expect(labelsOf(await $.tool.call({ tool: LIST_TOOL }))).toEqual(labels)
    })
  }

  test('every source refused still lists every browser', async ($, on) => {
    chrome(on, {
      failing: [
        'localState',
        'listing',
        'leveldb',
        'preferences',
        'extensions',
        'scutil',
        'store',
      ],
    })

    expect(labelsOf(await $.tool.call({ tool: LIST_TOOL }))).toEqual([
      'Browser 1 (profile unknown) · a macOS computer',
      'Browser 2 (profile unknown) · a Windows computer',
      'Browser 3 (profile unknown) · a macOS computer',
    ])
  })
})
