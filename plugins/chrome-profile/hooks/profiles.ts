/** One Google account signed in to a profile, from its `Preferences` file. */
export interface Account {
  readonly email: string
  readonly fullName?: string
  readonly givenName?: string
  readonly domain?: string
  readonly locale?: string
}

/** What `Local State` says about one profile. */
export interface LocalStateProfile {
  readonly name?: string
  readonly email?: string
  readonly fullName?: string
  readonly givenName?: string
  readonly domain?: string
  readonly isManaged?: boolean
  readonly lastUsed?: string
}

/** Everything known about the profile a device ID belongs to. */
export interface ProfileFacts extends LocalStateProfile {
  readonly browser: string
  readonly userDataDir: string
  readonly profileDir: string
  readonly accounts?: readonly Account[]
  readonly extensionVersion?: string
}

/** A `bridgeDeviceId` found in one profile's extension storage. */
export interface Sighting {
  readonly deviceId: string
  readonly profileDir: string
  readonly seq: bigint
}

/** One entry of Claude in Chrome's browser list, as the mod uses it. */
export interface Browser {
  readonly deviceId: string
  readonly bridgeName: string
  /** 1-based place in the list, which numbers browsers whose profile is unknown. */
  readonly position: number
  readonly os?: string
  readonly onThisComputer?: boolean
  readonly inUse?: boolean
}

/** Names you gave a browser with `/chrome-profile name` and `machine`. */
export interface GivenNames {
  readonly profile?: string
  readonly machine?: string
}

export interface Known {
  readonly profile?: ProfileFacts
  readonly names?: GivenNames
  readonly computerName?: string
  /**
   * False when this computer's Chrome files could not be read, so a browser
   * missing from them may still run here: it is then `a <OS> computer`, not
   * `another`. Left out, the files were read.
   */
  readonly filesRead?: boolean
}

export interface Machine {
  readonly name: string
  readonly isThisComputer: boolean
  readonly os?: string
}

const NO_DOMAIN = 'NO_HOSTED_DOMAIN'
const GENERIC_BRIDGE_NAME = /^Browser \d+$/

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOf(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function domainOf(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = textOf(record, key)
  return value === NO_DOMAIN ? undefined : value
}

function managedOf(value: unknown): boolean | undefined {
  if (typeof value === 'number') {
    return value !== 0
  }
  return typeof value === 'boolean' ? value : undefined
}

function lastUsedOf(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined
  }
  return new Date(value * 1000).toISOString()
}

function localStateProfile(
  info: Readonly<Record<string, unknown>>,
): LocalStateProfile {
  const name = textOf(info, 'name')
  const email = textOf(info, 'user_name')
  const fullName = textOf(info, 'gaia_name')
  const givenName = textOf(info, 'gaia_given_name')
  const domain = domainOf(info, 'hosted_domain')
  const isManaged = managedOf(info['is_managed'])
  const lastUsed = lastUsedOf(info['active_time'])
  return {
    ...(name === undefined ? {} : { name }),
    ...(email === undefined ? {} : { email }),
    ...(fullName === undefined ? {} : { fullName }),
    ...(givenName === undefined ? {} : { givenName }),
    ...(domain === undefined ? {} : { domain }),
    ...(isManaged === undefined ? {} : { isManaged }),
    ...(lastUsed === undefined ? {} : { lastUsed }),
  }
}

/** Reads `Local State` → `profile.info_cache`, keyed by profile folder. */
export function parseLocalState(
  json: unknown,
): ReadonlyMap<string, LocalStateProfile> {
  const profiles = new Map<string, LocalStateProfile>()
  if (!isRecord(json) || !isRecord(json['profile'])) {
    return profiles
  }
  const cache = json['profile']['info_cache']
  if (!isRecord(cache)) {
    return profiles
  }
  for (const [dir, info] of Object.entries(cache)) {
    if (isRecord(info)) {
      profiles.set(dir, localStateProfile(info))
    }
  }
  return profiles
}

/**
 * Reads the accounts in a profile's `Preferences` file. Only `account_info`
 * leaves this function: the file also holds password hash data.
 */
export function parseAccounts(json: unknown): readonly Account[] {
  if (!isRecord(json) || !Array.isArray(json['account_info'])) {
    return []
  }
  const items: readonly unknown[] = json['account_info']
  const accounts: Account[] = []
  for (const item of items) {
    if (!isRecord(item)) {
      continue
    }
    const email = textOf(item, 'email')
    if (email === undefined) {
      continue
    }
    const fullName = textOf(item, 'full_name')
    const givenName = textOf(item, 'given_name')
    const domain = domainOf(item, 'hd')
    const locale = textOf(item, 'locale')
    accounts.push({
      email,
      ...(fullName === undefined ? {} : { fullName }),
      ...(givenName === undefined ? {} : { givenName }),
      ...(domain === undefined ? {} : { domain }),
      ...(locale === undefined ? {} : { locale }),
    })
  }
  return accounts
}

/** Device ID → profile folder; a device ID seen in two profiles goes to the newer write. */
export function matchDevices(
  sightings: readonly Sighting[],
): ReadonlyMap<string, string> {
  const newest = new Map<string, Sighting>()
  for (const sighting of sightings) {
    const seen = newest.get(sighting.deviceId)
    if (seen === undefined || sighting.seq > seen.seq) {
      newest.set(sighting.deviceId, sighting)
    }
  }
  return new Map(
    [...newest].map(([deviceId, sighting]) => [deviceId, sighting.profileDir]),
  )
}

/** What was read now wins; the cache fills the fields that could not be read. */
export function mergeProfile(
  live: ProfileFacts | undefined,
  cached: ProfileFacts | undefined,
): ProfileFacts | undefined {
  if (live === undefined) {
    return cached
  }
  if (
    cached?.profileDir !== live.profileDir ||
    cached.userDataDir !== live.userDataDir
  ) {
    return live
  }
  return { ...cached, ...live }
}

function profilePart(browser: Browser, known: Known): string {
  const profile = known.profile
  if (profile === undefined) {
    const given = known.names?.profile
    if (given !== undefined) {
      return `${given} (named by you)`
    }
    return `Browser ${String(browser.position)} (profile unknown)`
  }
  const name = profile.name ?? profile.profileDir
  if (profile.email !== undefined) {
    return name === profile.email ? name : `${name} (${profile.email})`
  }
  const web = profile.accounts?.[0]?.email
  return web === undefined ? `${name} (no account)` : `${name} (web: ${web})`
}

/** Where the browser runs, decided from strong signals only: `isLocal` is never used. */
export function machineOf(browser: Browser, known: Known): Machine {
  const os = browser.os === undefined ? {} : { os: browser.os }
  if (known.profile !== undefined || browser.onThisComputer === true) {
    return {
      name: known.computerName ?? 'this computer',
      isThisComputer: true,
      ...os,
    }
  }
  const bridge = GENERIC_BRIDGE_NAME.test(browser.bridgeName)
    ? undefined
    : browser.bridgeName
  const which = known.filesRead === false ? 'a' : 'another'
  const fallback =
    browser.os === undefined
      ? `${which === 'a' ? 'an unknown' : 'another'} computer`
      : `${which} ${browser.os} computer`
  return {
    name: known.names?.machine ?? bridge ?? fallback,
    isThisComputer: false,
    ...os,
  }
}

/**
 * `<profile> · <computer>`, built from whatever is known. A label never holds
 * `"`, because the terminal quotes a multiple-choice answer that holds a comma.
 */
export function labelOf(
  browser: Browser,
  known: Known,
  options: { readonly markInUse?: boolean } = {},
): string {
  const label =
    `${profilePart(browser, known)} · ${machineOf(browser, known).name}`.replaceAll(
      '"',
      "'",
    )
  return options.markInUse === true && browser.inUse === true
    ? `${label} (in use)`
    : label
}

function compareVersions(
  left: readonly number[],
  right: readonly number[],
): number {
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference !== 0) {
      return difference
    }
  }
  return 0
}

/** The newest version among an extension's folders, named like `1.0.107_0`. */
export function newestVersion(folders: readonly string[]): string | undefined {
  let newest: { readonly name: string; readonly parts: number[] } | undefined
  for (const folder of folders) {
    const name = folder.replace(/_\d+$/, '')
    if (!/^\d+(\.\d+)*$/.test(name)) {
      continue
    }
    const parts = name.split('.').map(Number)
    if (newest === undefined || compareVersions(parts, newest.parts) > 0) {
      newest = { name, parts }
    }
  }
  return newest?.name
}

function ownAccounts(value: unknown): readonly Account[] {
  if (!Array.isArray(value)) {
    return []
  }
  const items: readonly unknown[] = value
  const accounts: Account[] = []
  for (const item of items) {
    if (!isRecord(item)) {
      continue
    }
    const email = textOf(item, 'email')
    if (email === undefined) {
      continue
    }
    const fullName = textOf(item, 'fullName')
    const givenName = textOf(item, 'givenName')
    const domain = textOf(item, 'domain')
    const locale = textOf(item, 'locale')
    accounts.push({
      email,
      ...(fullName === undefined ? {} : { fullName }),
      ...(givenName === undefined ? {} : { givenName }),
      ...(domain === undefined ? {} : { domain }),
      ...(locale === undefined ? {} : { locale }),
    })
  }
  return accounts
}

function cachedProfile(
  record: Readonly<Record<string, unknown>>,
): ProfileFacts | undefined {
  const browser = textOf(record, 'browser')
  const userDataDir = textOf(record, 'userDataDir')
  const profileDir = textOf(record, 'profileDir')
  if (
    browser === undefined ||
    userDataDir === undefined ||
    profileDir === undefined
  ) {
    return undefined
  }
  const texts = [
    'name',
    'email',
    'fullName',
    'givenName',
    'domain',
    'lastUsed',
    'extensionVersion',
  ] as const
  const fields: Record<string, string> = {}
  for (const key of texts) {
    const value = textOf(record, key)
    if (value !== undefined) {
      fields[key] = value
    }
  }
  const isManaged = record['isManaged']
  const accounts = ownAccounts(record['accounts'])
  return {
    browser,
    userDataDir,
    profileDir,
    ...fields,
    ...(typeof isManaged === 'boolean' ? { isManaged } : {}),
    ...(accounts.length === 0 ? {} : { accounts }),
  }
}

/** The `devices` store key: profiles this computer resolved before, by device ID. */
export function parseDeviceCache(
  json: unknown,
): ReadonlyMap<string, ProfileFacts> {
  const devices = new Map<string, ProfileFacts>()
  if (!isRecord(json)) {
    return devices
  }
  for (const [deviceId, value] of Object.entries(json)) {
    const profile = isRecord(value) ? cachedProfile(value) : undefined
    if (profile !== undefined) {
      devices.set(deviceId, profile)
    }
  }
  return devices
}

/** The `names` store key: what you named a browser and its computer, by device ID. */
export function parseNames(json: unknown): ReadonlyMap<string, GivenNames> {
  const names = new Map<string, GivenNames>()
  if (!isRecord(json)) {
    return names
  }
  for (const [deviceId, value] of Object.entries(json)) {
    if (!isRecord(value)) {
      continue
    }
    const profile = textOf(value, 'profile')
    const machine = textOf(value, 'machine')
    if (profile !== undefined || machine !== undefined) {
      names.set(deviceId, {
        ...(profile === undefined ? {} : { profile }),
        ...(machine === undefined ? {} : { machine }),
      })
    }
  }
  return names
}
