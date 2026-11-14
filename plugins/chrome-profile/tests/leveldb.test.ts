import { describe, expect, test } from 'claude-code/testing'

import {
  bytesFromBase64,
  newestValue,
  readLog,
  readTable,
} from '../hooks/leveldb'
import { batch, logFile, tableFile } from './bytes'

const KEY = 'bridgeDeviceId'
const FIRST = '"aaaaaaaa-0000-4000-8000-000000000001"'
const SECOND = '"bbbbbbbb-0000-4000-8000-000000000002"'

describe('readLog', () => {
  test('a record that fits in one block', () => {
    const read = readLog(logFile([batch(5n, [{ key: KEY, value: FIRST }])]))

    expect(read.problems).toEqual([])
    expect(newestValue(read.entries, KEY)).toEqual({ value: FIRST, seq: 5n })
  })

  test('a batch split into FIRST, MIDDLE and LAST records across blocks', () => {
    const filler = { key: 'filler', value: 'z'.repeat(70000) }
    const read = readLog(
      logFile([batch(1n, [filler, { key: KEY, value: FIRST }])]),
    )

    expect(read.problems).toEqual([])
    expect(newestValue(read.entries, KEY)).toEqual({ value: FIRST, seq: 2n })
  })

  test('a block tail too short for a header is skipped', () => {
    const fill = {
      key: 'f',
      value: 'z'.repeat(32768 - 7 - 12 - 1 - 1 - 1 - 3 - 3),
    }
    const read = readLog(
      logFile([batch(1n, [fill]), batch(9n, [{ key: KEY, value: SECOND }])]),
    )

    expect(read.problems).toEqual([])
    expect(newestValue(read.entries, KEY)).toEqual({ value: SECOND, seq: 9n })
  })

  test('a record cut off at the end of the file keeps the records before it', () => {
    const whole = logFile([
      batch(3n, [{ key: KEY, value: FIRST }]),
      batch(4n, [{ key: 'other', value: '"x"' }]),
    ])
    const read = readLog(whole.subarray(0, whole.length - 4))

    expect(newestValue(read.entries, KEY)).toEqual({ value: FIRST, seq: 3n })
  })

  test('an unknown record type is a problem, and the records before it stay', () => {
    const good = logFile([batch(3n, [{ key: KEY, value: FIRST }])])
    const bad = Uint8Array.from([...good, 0, 0, 0, 0, 1, 0, 9, 0])
    const read = readLog(bad)

    expect(read.problems.length).toBe(1)
    expect(newestValue(read.entries, KEY)).toEqual({ value: FIRST, seq: 3n })
  })

  test('garbage gives problems, not a throw', () => {
    const read = readLog(Uint8Array.from([1, 2, 3, 4, 200, 0, 1, 5, 5, 5]))

    expect(read.entries).toEqual([])
    expect(read.problems.length).toBeGreaterThan(0)
  })
})

describe('readTable', () => {
  for (const compression of ['none', 'snappy'] as const) {
    test(`a data block stored with ${compression}`, () => {
      const read = readTable(
        tableFile([{ key: KEY, seq: 7n, value: FIRST }], { compression }),
      )

      expect(read.problems).toEqual([])
      expect(newestValue(read.entries, KEY)).toEqual({ value: FIRST, seq: 7n })
    })
  }

  test('an unknown compression type is a problem', () => {
    const read = readTable(
      tableFile([{ key: KEY, seq: 7n, value: FIRST }], {
        compression: 'unknown',
      }),
    )

    expect(read.entries).toEqual([])
    expect(read.problems.length).toBe(1)
  })

  test('a file that is not a table is a problem, not a throw', () => {
    const read = readTable(Uint8Array.from([1, 2, 3]))

    expect(read.entries).toEqual([])
    expect(read.problems.length).toBe(1)
  })
})

describe('newestValue', () => {
  test('the higher sequence number wins, wherever it was read', () => {
    const table = readTable(tableFile([{ key: KEY, seq: 9n, value: SECOND }]))
    const log = readLog(logFile([batch(4n, [{ key: KEY, value: FIRST }])]))

    expect(newestValue([...log.entries, ...table.entries], KEY)).toEqual({
      value: SECOND,
      seq: 9n,
    })
  })

  test('a newer deletion hides the key', () => {
    const table = readTable(tableFile([{ key: KEY, seq: 2n, value: FIRST }]))
    const log = readLog(logFile([batch(6n, [{ key: KEY }])]))

    expect(newestValue([...table.entries, ...log.entries], KEY)).toBeUndefined()
  })

  test('a key that was never written', () => {
    expect(newestValue([], KEY)).toBeUndefined()
  })
})

describe('bytesFromBase64', () => {
  test('every byte value survives the round trip', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
    const base64 = btoa(String.fromCharCode(...bytes))

    expect([...bytesFromBase64(base64)]).toEqual([...bytes])
  })
})
