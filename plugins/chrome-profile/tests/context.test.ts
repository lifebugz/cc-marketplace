import { describe, expect, test } from 'claude-code/testing'

import type { Description } from '../hooks/context'
import {
  joinedText,
  parseList,
  relabelSentence,
  rewriteList,
  toBrowser,
} from '../hooks/context'

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'

const LIST = [
  {
    deviceId: A,
    name: 'Browser 1',
    osPlatform: 'macOS',
    connectedAt: 1,
    isLocal: true,
    inUse: true,
  },
  { deviceId: B, name: 'Browser 2', osPlatform: 'Windows', isLocal: false },
]
const SENTENCE = `2 browsers are connected; "Browser 1" (deviceId ${A}) is the one picked last and will be used.`
const RESULT = [
  { type: 'text', text: JSON.stringify(LIST) },
  { type: 'text', text: SENTENCE },
]

const DESCRIPTIONS = new Map<string, Description>([
  [
    A,
    {
      label: 'Work (some.one@example.com) · Office Mac',
      extra: { machine: { name: 'Office Mac', isThisComputer: true } },
    },
  ],
])

describe('parseList', () => {
  test('finds the list block and its browsers', () => {
    const parsed = parseList(RESULT)

    expect(parsed?.listAt).toBe(0)
    expect(parsed?.browsers.map(b => b.deviceId)).toEqual([A, B])
  })

  test('anything else is not a list', () => {
    expect(parseList('text')).toBeUndefined()
    expect(parseList([{ type: 'text', text: 'not json' }])).toBeUndefined()
    expect(
      parseList([{ type: 'text', text: JSON.stringify([{ name: 'x' }]) }]),
    ).toBeUndefined()
  })
})

describe('toBrowser', () => {
  test('keeps the fields the labels use, and never isLocal', () => {
    const parsed = parseList(RESULT)
    const [first, second] = parsed?.browsers ?? []

    expect(first === undefined ? undefined : toBrowser(first, 1)).toEqual({
      deviceId: A,
      bridgeName: 'Browser 1',
      position: 1,
      os: 'macOS',
      inUse: true,
    })
    expect(second === undefined ? undefined : toBrowser(second, 2)).toEqual({
      deviceId: B,
      bridgeName: 'Browser 2',
      position: 2,
      os: 'Windows',
    })
  })
})

describe('rewriteList', () => {
  const parsed = parseList(RESULT)
  const blocks = parsed === undefined ? [] : rewriteList(parsed, DESCRIPTIONS)

  test('the list gets labels, bridgeName and the extra fields; deviceId stays', () => {
    const first = blocks[0]
    const text =
      typeof first === 'object' && first !== null && 'text' in first
        ? String(first.text)
        : ''

    expect(JSON.parse(text)).toEqual([
      {
        ...LIST[0],
        name: 'Work (some.one@example.com) · Office Mac',
        bridgeName: 'Browser 1',
        machine: { name: 'Office Mac', isThisComputer: true },
      },
      LIST[1],
    ])
  })

  test('the sentence names the label by device ID', () => {
    expect(blocks[1]).toEqual({
      type: 'text',
      text: `2 browsers are connected; "Work (some.one@example.com) · Office Mac" (deviceId ${A}) is the one picked last and will be used.`,
    })
  })

  test('a block that is not text is kept as it is', () => {
    const withImage = [...RESULT, { type: 'image', data: 'x' }]
    const parsedImage = parseList(withImage)

    expect(
      parsedImage === undefined
        ? undefined
        : rewriteList(parsedImage, DESCRIPTIONS)[2],
    ).toEqual({ type: 'image', data: 'x' })
  })
})

describe('relabelSentence', () => {
  test('the other wording seen so far', () => {
    expect(
      relabelSentence(
        `"Browser 1" (deviceId ${A}) is the one in use for this session.`,
        DESCRIPTIONS,
      ),
    ).toBe(
      `"Work (some.one@example.com) · Office Mac" (deviceId ${A}) is the one in use for this session.`,
    )
  })

  test('a device with no description is left alone', () => {
    const text = `"Browser 2" (deviceId ${B}) is the one picked last.`

    expect(relabelSentence(text, DESCRIPTIONS)).toBe(text)
  })
})

describe('joinedText', () => {
  test('the text blocks joined by new lines, as the tool sets `text`', () => {
    expect(joinedText(RESULT)).toBe(`${JSON.stringify(LIST)}\n${SENTENCE}`)
  })
})
