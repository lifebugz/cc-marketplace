import { describe, expect, test } from 'claude-code/testing'

import { chooser, parseCommand, pickedIndex } from '../hooks/command'
import { parseDeviceCache, parseNames } from '../hooks/profiles'

describe('parseCommand', () => {
  test('name and machine take the rest of the line', () => {
    expect(parseCommand('name Laptop work')).toEqual({
      kind: 'name',
      label: 'Laptop work',
    })
    expect(parseCommand('  machine   Home  PC ')).toEqual({
      kind: 'machine',
      name: 'Home PC',
    })
  })

  test('quotes are dropped, and a long name is cut', () => {
    expect(parseCommand('name "Work"')).toEqual({ kind: 'name', label: 'Work' })
    expect(parseCommand(`name ${'x'.repeat(80)}`)).toEqual({
      kind: 'name',
      label: 'x'.repeat(60),
    })
  })

  test('anything else is the usage line', () => {
    for (const args of ['', 'name', 'name   ', 'forget', 'rename x']) {
      expect(parseCommand(args)).toEqual({ kind: 'usage' })
    }
  })
})

describe('chooser and pickedIndex', () => {
  const labels = ['L1', 'L2', 'L3', 'L4', 'L5']

  test('up to 4 labels are the options', () => {
    expect(chooser('Which?', labels.slice(0, 4))).toEqual({
      question: 'Which?',
      options: ['L1', 'L2', 'L3', 'L4'],
    })
  })

  test('5 or more are numbered in the question', () => {
    const asked = chooser('Which?', labels)

    expect(asked.options).toEqual(['L1', 'L2', 'L3'])
    expect(asked.question).toContain('5. L5')
  })

  test('an answer is a label or a typed number', () => {
    expect(pickedIndex('L2', labels)).toBe(1)
    expect(pickedIndex(' 5 ', labels)).toBe(4)
    expect(pickedIndex('6', labels)).toBeUndefined()
    expect(pickedIndex('something else', labels)).toBeUndefined()
  })
})

describe('parseDeviceCache', () => {
  test('reads back what the mod saved, and skips the rest', () => {
    const cache = parseDeviceCache({
      a: {
        browser: 'Google Chrome',
        userDataDir: '/Chrome',
        profileDir: 'Default',
        name: 'Work',
        email: 'some.one@example.com',
        isManaged: true,
        accounts: [{ email: 'some.one@example.com', fullName: 'Some One' }, {}],
        seenAt: '2026-11-14T00:00:00.000Z',
      },
      b: { name: 'no folder' },
      c: 'text',
    })

    expect([...cache.keys()]).toEqual(['a'])
    expect(cache.get('a')).toEqual({
      browser: 'Google Chrome',
      userDataDir: '/Chrome',
      profileDir: 'Default',
      name: 'Work',
      email: 'some.one@example.com',
      isManaged: true,
      accounts: [{ email: 'some.one@example.com', fullName: 'Some One' }],
    })
  })

  test('anything that is not a cache is empty', () => {
    expect(parseDeviceCache(undefined).size).toBe(0)
    expect(parseDeviceCache([]).size).toBe(0)
  })
})

describe('parseNames', () => {
  test('profile and machine names by device ID', () => {
    const names = parseNames({
      a: { profile: 'Work' },
      b: { machine: 'Home PC' },
      c: { profile: '' },
      d: 'text',
    })

    expect([...names]).toEqual([
      ['a', { profile: 'Work' }],
      ['b', { machine: 'Home PC' }],
    ])
  })
})
