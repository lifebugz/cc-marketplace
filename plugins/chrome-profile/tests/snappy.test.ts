import { describe, expect, test } from 'claude-code/testing'

import { snappyDecompress } from '../hooks/snappy'
import { concat, snappyLiterals, utf8, varint } from './bytes'

function decodedText(block: Readonly<Uint8Array>): string {
  const result = snappyDecompress(block)
  if (!result.ok) {
    throw new Error(result.error)
  }
  return new TextDecoder().decode(result.value)
}

describe('snappyDecompress', () => {
  test('a short literal run', () => {
    expect(decodedText(snappyLiterals(utf8('hello')))).toBe('hello')
  })

  test('literal runs longer than 60 bytes', () => {
    const text = 'x'.repeat(130)

    expect(decodedText(snappyLiterals(utf8(text)))).toBe(text)
  })

  test('a literal with a 1-byte extended length', () => {
    const text = 'y'.repeat(100)
    const block = concat(varint(100), [60 << 2, 99], [...utf8(text)])

    expect(decodedText(block)).toBe(text)
  })

  test('a copy with a 1-byte offset', () => {
    const block = concat(
      varint(8),
      [3 << 2],
      [...utf8('abcd')],
      [(0 << 2) | 1, 4],
    )

    expect(decodedText(block)).toBe('abcdabcd')
  })

  test('a copy with a 2-byte offset', () => {
    const block = concat(
      varint(6),
      [2 << 2],
      [...utf8('abc')],
      [(2 << 2) | 2, 3, 0],
    )

    expect(decodedText(block)).toBe('abcabc')
  })

  test('a copy with a 4-byte offset', () => {
    const block = concat(
      varint(4),
      [1 << 2],
      [...utf8('ab')],
      [(1 << 2) | 3, 2, 0, 0, 0],
    )

    expect(decodedText(block)).toBe('abab')
  })

  test('an overlapping copy repeats the bytes it has just written', () => {
    const block = concat(varint(6), [0 << 2], [...utf8('a')], [(1 << 2) | 1, 1])

    expect(decodedText(block)).toBe('aaaaaa')
  })

  const corrupt: readonly (readonly [string, Uint8Array])[] = [
    ['empty input', concat()],
    ['a copy with offset 0', concat(varint(5), [0], [...utf8('a')], [1, 0])],
    [
      'a copy reaching before the start',
      concat(varint(5), [0], [...utf8('a')], [1, 4]),
    ],
    [
      'a literal past the end of the input',
      concat(varint(5), [4 << 2], [...utf8('ab')]),
    ],
    [
      'output longer than its header says',
      concat(varint(1), [1 << 2], [...utf8('ab')]),
    ],
    [
      'output shorter than its header says',
      concat(varint(9), [1 << 2], [...utf8('ab')]),
    ],
  ]
  for (const [name, block] of corrupt) {
    test(`${name} is an error, not a throw`, () => {
      expect(snappyDecompress(block).ok).toBe(false)
    })
  }
})
