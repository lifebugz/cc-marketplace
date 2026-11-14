import { describe, expect, test } from 'claude-code/testing'

import type { Browser, Known, ProfileFacts } from '../hooks/profiles'
import {
  labelOf,
  machineOf,
  matchDevices,
  mergeProfile,
  newestVersion,
  parseAccounts,
  parseLocalState,
} from '../hooks/profiles'

const LOCAL_STATE = {
  profile: {
    info_cache: {
      Default: {
        name: 'Work',
        user_name: 'some.one@example.com',
        gaia_name: 'Some One',
        gaia_given_name: 'Some',
        hosted_domain: 'example.com',
        is_managed: 1,
        active_time: 1794600000.5,
        gaia_id: '123',
        last_downloaded_gaia_picture_url_with_size: 'https://example.com/p',
      },
      'Profile 1': {
        name: 'other.one@example.com',
        user_name: 'other.one@example.com',
        gaia_name: '',
        hosted_domain: 'NO_HOSTED_DOMAIN',
        is_managed: 0,
      },
      'Profile 2': { name: 'Scratch', user_name: '', gaia_name: '' },
      'Profile 9': 'not an object',
    },
  },
}

const PREFERENCES = {
  account_info: [
    {
      email: 'some.one@example.com',
      full_name: 'Some One',
      given_name: 'Some',
      hd: 'example.com',
      locale: 'en',
      account_id: 'secret-id',
      picture_url: 'https://example.com/p',
    },
    { email: 'web.one@example.com', hd: 'NO_HOSTED_DOMAIN' },
    { full_name: 'No Email' },
  ],
  profile: { password_hash_data_list: [{ hash: 'secret-hash' }] },
}

const WORK: ProfileFacts = {
  browser: 'Google Chrome',
  userDataDir: '/Chrome',
  profileDir: 'Default',
  name: 'Work',
  email: 'some.one@example.com',
}

function browser(position: number, extra: Partial<Browser> = {}): Browser {
  return {
    deviceId: `dddddddd-0000-4000-8000-00000000000${String(position)}`,
    bridgeName: `Browser ${String(position)}`,
    position,
    os: 'macOS',
    ...extra,
  }
}

const HERE: Known = { computerName: 'Office Mac' }

describe('parseLocalState', () => {
  const profiles = parseLocalState(LOCAL_STATE)

  test('reads every field it uses, and nothing else', () => {
    expect(profiles.get('Default')).toEqual({
      name: 'Work',
      email: 'some.one@example.com',
      fullName: 'Some One',
      givenName: 'Some',
      domain: 'example.com',
      isManaged: true,
      lastUsed: new Date(1794600000500).toISOString(),
    })
  })

  test('empty strings and NO_HOSTED_DOMAIN count as missing', () => {
    expect(profiles.get('Profile 1')).toEqual({
      name: 'other.one@example.com',
      email: 'other.one@example.com',
      isManaged: false,
    })
    expect(profiles.get('Profile 2')).toEqual({ name: 'Scratch' })
  })

  test('a profile that is not an object is skipped', () => {
    expect(profiles.has('Profile 9')).toBe(false)
  })

  test('anything that is not Local State gives no profiles', () => {
    expect(parseLocalState(null).size).toBe(0)
    expect(parseLocalState({ profile: [] }).size).toBe(0)
    expect(parseLocalState('text').size).toBe(0)
  })
})

describe('parseAccounts', () => {
  const accounts = parseAccounts(PREFERENCES)

  test('every account with an email, web sign-ins included', () => {
    expect(accounts).toEqual([
      {
        email: 'some.one@example.com',
        fullName: 'Some One',
        givenName: 'Some',
        domain: 'example.com',
        locale: 'en',
      },
      { email: 'web.one@example.com' },
    ])
  })

  test('nothing but account_info leaves the parser', () => {
    const text = JSON.stringify(accounts)

    expect(text).not.toContain('secret')
    expect(text).not.toContain('picture')
  })

  test('a file with no account_info gives no accounts', () => {
    expect(parseAccounts({ profile: {} })).toEqual([])
    expect(parseAccounts(undefined)).toEqual([])
  })
})

describe('matchDevices', () => {
  test('one device per profile', () => {
    const matched = matchDevices([
      { deviceId: 'a', profileDir: 'Default', seq: 5n },
      { deviceId: 'b', profileDir: 'Profile 2', seq: 1n },
    ])

    expect(matched.get('a')).toBe('Default')
    expect(matched.get('b')).toBe('Profile 2')
    expect(matched.has('remote')).toBe(false)
  })

  test('a device ID in two profiles goes to the newer write', () => {
    const matched = matchDevices([
      { deviceId: 'a', profileDir: 'Default', seq: 9n },
      { deviceId: 'a', profileDir: 'Profile 1', seq: 4n },
    ])

    expect(matched.get('a')).toBe('Default')
  })

  test('no sightings, no matches', () => {
    expect(matchDevices([]).size).toBe(0)
  })
})

describe('mergeProfile', () => {
  test('what was read now wins, and the cache fills the gaps', () => {
    const cached: ProfileFacts = {
      ...WORK,
      name: 'Old name',
      accounts: [{ email: 'some.one@example.com' }],
      extensionVersion: '1.0.0',
    }

    expect(mergeProfile(WORK, cached)).toEqual({
      ...WORK,
      accounts: [{ email: 'some.one@example.com' }],
      extensionVersion: '1.0.0',
    })
  })

  test('a cached profile from another folder is not mixed in', () => {
    const cached: ProfileFacts = {
      ...WORK,
      profileDir: 'Profile 4',
      accounts: [{ email: 'x@example.com' }],
    }

    expect(mergeProfile(WORK, cached)).toEqual(WORK)
  })

  test('each side alone, and neither', () => {
    expect(mergeProfile(undefined, WORK)).toEqual(WORK)
    expect(mergeProfile(WORK, undefined)).toEqual(WORK)
    expect(mergeProfile(undefined, undefined)).toBeUndefined()
  })
})

describe('labelOf: the profile part', () => {
  test('a profile with an email', () => {
    expect(labelOf(browser(1), { ...HERE, profile: WORK })).toBe(
      'Work (some.one@example.com) · Office Mac',
    )
  })

  test('a profile whose name is its email shows the email once', () => {
    const profile = { ...WORK, name: 'some.one@example.com' }

    expect(labelOf(browser(1), { ...HERE, profile })).toBe(
      'some.one@example.com · Office Mac',
    )
  })

  test('no primary email, but a web sign-in', () => {
    const profile: ProfileFacts = {
      browser: 'Google Chrome',
      userDataDir: '/Chrome',
      profileDir: 'Profile 2',
      name: 'Scratch',
      accounts: [{ email: 'web.one@example.com' }],
    }

    expect(labelOf(browser(1), { ...HERE, profile })).toBe(
      'Scratch (web: web.one@example.com) · Office Mac',
    )
  })

  test('no Google account at all', () => {
    const profile: ProfileFacts = {
      browser: 'Google Chrome',
      userDataDir: '/Chrome',
      profileDir: 'Profile 2',
      name: 'Scratch',
    }

    expect(labelOf(browser(1), { ...HERE, profile })).toBe(
      'Scratch (no account) · Office Mac',
    )
  })

  test('a profile known only by its folder', () => {
    const profile: ProfileFacts = {
      browser: 'Google Chrome',
      userDataDir: '/Chrome',
      profileDir: 'Default',
    }

    expect(labelOf(browser(1), { ...HERE, profile })).toBe(
      'Default (no account) · Office Mac',
    )
  })

  test('an unknown profile is numbered by its place in the list', () => {
    const remote = { os: 'Windows' }

    expect(labelOf(browser(2, remote), {})).toBe(
      'Browser 2 (profile unknown) · another Windows computer',
    )
    expect(labelOf(browser(3, remote), {})).toBe(
      'Browser 3 (profile unknown) · another Windows computer',
    )
  })

  test('a name you gave is used only while the profile is unknown', () => {
    const names = { profile: 'Laptop work' }

    expect(labelOf(browser(2, { os: 'Windows' }), { names })).toBe(
      'Laptop work (named by you) · another Windows computer',
    )
    expect(labelOf(browser(1), { ...HERE, profile: WORK, names })).toBe(
      'Work (some.one@example.com) · Office Mac',
    )
  })

  test('the browser in use is marked when asked', () => {
    const inUse = browser(1, { inUse: true })

    expect(
      labelOf(inUse, { ...HERE, profile: WORK }, { markInUse: true }),
    ).toBe('Work (some.one@example.com) · Office Mac (in use)')
    expect(labelOf(inUse, { ...HERE, profile: WORK })).toBe(
      'Work (some.one@example.com) · Office Mac',
    )
  })

  test('a label never contains a double quote', () => {
    const profile = { ...WORK, name: 'The "Work" one' }

    expect(labelOf(browser(1), { ...HERE, profile })).not.toContain('"')
  })
})

describe('machineOf: the computer part', () => {
  test('a device found in this computer’s files is this computer', () => {
    expect(machineOf(browser(1), { ...HERE, profile: WORK })).toEqual({
      name: 'Office Mac',
      isThisComputer: true,
      os: 'macOS',
    })
  })

  test('onThisComputer counts too, even with the profile unknown', () => {
    expect(machineOf(browser(1, { onThisComputer: true }), HERE)).toEqual({
      name: 'Office Mac',
      isThisComputer: true,
      os: 'macOS',
    })
  })

  test('this computer with no name known', () => {
    expect(machineOf(browser(1), { profile: WORK }).name).toBe('this computer')
  })

  test('a Mac not found in the files is another computer', () => {
    expect(machineOf(browser(2), HERE)).toEqual({
      name: 'another macOS computer',
      isThisComputer: false,
      os: 'macOS',
    })
  })

  test('a bridge name that is not Browser N names the other computer', () => {
    const named = browser(2, { bridgeName: 'Home PC', os: 'Windows' })

    expect(machineOf(named, HERE).name).toBe('Home PC')
  })

  test('a computer name you gave wins over the bridge name', () => {
    const named = browser(2, { bridgeName: 'Home PC', os: 'Windows' })

    expect(
      machineOf(named, { ...HERE, names: { machine: 'Study PC' } }).name,
    ).toBe('Study PC')
  })

  test('with this computer’s files unread, a browser not found may still be here', () => {
    expect(machineOf(browser(2), { ...HERE, filesRead: false }).name).toBe(
      'a macOS computer',
    )
  })

  test('no OS known', () => {
    const bare: Browser = {
      deviceId: 'eeee',
      bridgeName: 'Browser 2',
      position: 2,
    }

    expect(machineOf(bare, HERE).name).toBe('another computer')
    expect(machineOf(bare, { ...HERE, filesRead: false }).name).toBe(
      'an unknown computer',
    )
  })
})

describe('newestVersion', () => {
  test('the highest version, by number not by text', () => {
    expect(newestVersion(['1.0.99_0', '1.0.107_0', 'Temp'])).toBe('1.0.107')
  })

  test('no version folders', () => {
    expect(newestVersion([])).toBeUndefined()
    expect(newestVersion(['Temp'])).toBeUndefined()
  })
})
