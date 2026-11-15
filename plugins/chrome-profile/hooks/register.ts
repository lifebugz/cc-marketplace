import type { EngineInterface, FsEntry, Register } from 'claude-code'

import type { ProfileCommand } from './command'
import { USAGE, chooser, parseCommand, pickedIndex } from './command'
import type { Description, Listed, ParsedList } from './context'
import {
  joinedText,
  parseList,
  profileLine,
  relabelSelected,
  rewriteList,
  toBrowser,
  withSelected,
} from './context'
import type { Entry } from './leveldb'
import { bytesFromBase64, newestValue, readLog, readTable } from './leveldb'
import type { Browser, Known, ProfileFacts, Sighting } from './profiles'
import {
  labelOf,
  machineOf,
  matchDevices,
  mergeProfile,
  newestVersion,
  otherEmails,
  parseAccounts,
  parseDeviceCache,
  parseLocalState,
  parseNames,
} from './profiles'

const CHROME_TOOL = /^mcp__claude-in-chrome__/
const LIST_TOOL = 'mcp__claude-in-chrome__list_connected_browsers'
const SELECT_TOOL = 'mcp__claude-in-chrome__select_browser'
const EXTENSION_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn'
const CHROME_DATA = 'Library/Application Support/Google/Chrome'
const BROWSER = 'Google Chrome'
// $.fs.read refuses larger files; a LevelDB .log grows past it before it is compacted.
const READ_LIMIT = 4194304
const PROFILE_FOLDER = /^(Default|Profile \d+)$/
const LEVELDB_FILE = /\.(ldb|log)$/
const LINE_LIMIT_MS = 1000
const TIMED_OUT = Symbol('timed out')

interface Resolved {
  readonly profiles: ReadonlyMap<string, ProfileFacts>
  readonly cached: ReadonlyMap<string, ProfileFacts>
  readonly computerName?: string
  readonly filesRead: boolean
}

/** One listed browser with everything known about it. */
interface Described {
  readonly listed: Listed
  readonly browser: Browser
  readonly known: Known
  readonly label: string
}

interface FolderRead {
  readonly device?: { readonly deviceId: string; readonly seq: bigint }
  readonly isReadable: boolean
}

let resolved: Resolved | undefined
const resolvedIds = new Set<string>()
// Desktop's auto mode refuses the mod's own list call, so the last list Claude itself got stands in.
let lastSeen: ParsedList | undefined

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function log($: EngineInterface, text: string): void {
  $.ui.log(`chrome-profile: ${text}`, { to: 'debug' })
}

function logError($: EngineInterface, what: string, error: unknown): void {
  log($, `${what}: ${messageOf(error)}`)
}

async function readJson($: EngineInterface, path: string): Promise<unknown> {
  let text: string
  try {
    text = await $.fs.read(path)
  } catch (error) {
    logError($, `could not read ${path}`, error)
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    // The parser's message can quote the file, and Preferences holds password data.
    log($, `${path} is not valid JSON`)
    return undefined
  }
}

async function listFolder(
  $: EngineInterface,
  path: string,
): Promise<readonly FsEntry[]> {
  try {
    return await $.fs.list(path)
  } catch (error) {
    logError($, `could not list ${path}`, error)
    return []
  }
}

async function exists($: EngineInterface, path: string): Promise<boolean> {
  try {
    return await $.fs.exists(path)
  } catch (error) {
    logError($, `could not check ${path}`, error)
    return false
  }
}

async function readEntries(
  $: EngineInterface,
  folder: string,
  file: string,
): Promise<readonly Entry[] | undefined> {
  try {
    const { base64 } = await $.fs.read(`${folder}/${file}`, { as: 'bytes' })
    const bytes = bytesFromBase64(base64)
    const read = file.endsWith('.ldb') ? readTable(bytes) : readLog(bytes)
    for (const problem of read.problems) {
      log($, `${folder}/${file}: ${problem}`)
    }
    return read.entries
  } catch (error) {
    logError($, `could not read ${folder}/${file}`, error)
    return undefined
  }
}

async function deviceIn(
  $: EngineInterface,
  folder: string,
): Promise<FolderRead> {
  const entries: Entry[] = []
  let isReadable = false
  for (const file of await listFolder($, folder)) {
    if (file.kind !== 'file' || !LEVELDB_FILE.test(file.name)) {
      continue
    }
    if (file.size > READ_LIMIT) {
      log($, `skipped ${folder}/${file.name}: ${String(file.size)} bytes`)
      continue
    }
    const read = await readEntries($, folder, file.name)
    if (read !== undefined) {
      isReadable = true
      entries.push(...read)
    }
  }
  const found = newestValue(entries, 'bridgeDeviceId')
  if (found === undefined) {
    return { isReadable }
  }
  try {
    const deviceId: unknown = JSON.parse(found.value)
    return typeof deviceId === 'string'
      ? { device: { deviceId, seq: found.seq }, isReadable }
      : { isReadable }
  } catch {
    log($, `${folder}: bridgeDeviceId is not JSON`)
    return { isReadable }
  }
}

async function profileFolders(
  $: EngineInterface,
  root: string,
  fromLocalState: Iterable<string>,
): Promise<readonly string[]> {
  const folders = new Set(fromLocalState)
  for (const entry of await listFolder($, root)) {
    if (entry.kind === 'dir' && PROFILE_FOLDER.test(entry.name)) {
      folders.add(entry.name)
    }
  }
  return [...folders]
}

async function storeGet($: EngineInterface, key: string): Promise<unknown> {
  try {
    const value: unknown = await $.store.get(key)
    return value
  } catch (error) {
    logError($, `could not read ${key} from the store`, error)
    return undefined
  }
}

async function storeSet(
  $: EngineInterface,
  key: string,
  value: unknown,
): Promise<void> {
  try {
    await $.store.set(key, value)
  } catch (error) {
    logError($, `could not save ${key} in the store`, error)
  }
}

async function readComputerName(
  $: EngineInterface,
): Promise<string | undefined> {
  try {
    const run = await $.process.run(['scutil', '--get', 'ComputerName'], {
      timeoutMs: 2000,
    })
    const name = run.stdout.trim()
    if (run.exitCode === 0 && name !== '') {
      await storeSet($, 'computer', name)
      return name
    }
    log($, `scutil exited ${String(run.exitCode)}`)
  } catch (error) {
    logError($, 'could not run scutil', error)
  }
  const saved = await storeGet($, 'computer')
  return typeof saved === 'string' && saved !== '' ? saved : undefined
}

async function saveDevices(
  $: EngineInterface,
  profiles: ReadonlyMap<string, ProfileFacts>,
  cached: ReadonlyMap<string, ProfileFacts>,
): Promise<void> {
  if (profiles.size === 0) {
    return
  }
  const seenAt = new Date().toISOString()
  const devices = new Map<string, unknown>(cached)
  for (const [deviceId, profile] of profiles) {
    devices.set(deviceId, { ...profile, seenAt })
  }
  await storeSet($, 'devices', Object.fromEntries(devices))
}

async function resolveProfiles($: EngineInterface): Promise<Resolved> {
  const started = Date.now()
  const computerName = await readComputerName($)
  const named = computerName === undefined ? {} : { computerName }
  const cached = parseDeviceCache(await storeGet($, 'devices'))
  const home = await $.env.get('HOME')
  if (home === undefined) {
    log($, 'HOME is not set, so no profile was read')
    return { profiles: new Map(), cached, filesRead: false, ...named }
  }
  const root = `${home}/${CHROME_DATA}`
  const local = parseLocalState(await readJson($, `${root}/Local State`))
  const sightings: Sighting[] = []
  let filesRead = false
  for (const dir of await profileFolders($, root, local.keys())) {
    const folder = `${root}/${dir}/Local Extension Settings/${EXTENSION_ID}`
    if (!(await exists($, folder))) {
      continue
    }
    const { device, isReadable } = await deviceIn($, folder)
    filesRead ||= isReadable
    if (device !== undefined) {
      sightings.push({ ...device, profileDir: dir })
    }
  }
  const profiles = new Map<string, ProfileFacts>()
  for (const [deviceId, dir] of matchDevices(sightings)) {
    const accounts = parseAccounts(
      await readJson($, `${root}/${dir}/Preferences`),
    )
    const versions = await listFolder(
      $,
      `${root}/${dir}/Extensions/${EXTENSION_ID}`,
    )
    const extensionVersion = newestVersion(
      versions.filter(entry => entry.kind === 'dir').map(entry => entry.name),
    )
    profiles.set(deviceId, {
      browser: BROWSER,
      userDataDir: root,
      profileDir: dir,
      ...local.get(dir),
      ...(accounts.length === 0 ? {} : { accounts }),
      ...(extensionVersion === undefined ? {} : { extensionVersion }),
    })
  }
  log(
    $,
    `resolved ${String(profiles.size)} of ${String(sightings.length)} device(s) in ${String(Date.now() - started)} ms`,
  )
  await saveDevices($, profiles, cached)
  return { profiles, cached, filesRead, ...named }
}

async function describeAll(
  $: EngineInterface,
  parsed: ParsedList,
): Promise<readonly Described[]> {
  const ids = parsed.browsers.map(listed => listed.deviceId)
  let current = resolved
  if (current === undefined || ids.some(id => !resolvedIds.has(id))) {
    current = await resolveProfiles($)
    resolved = current
    for (const id of ids) {
      resolvedIds.add(id)
    }
  }
  const names = parseNames(await storeGet($, 'names'))
  return parsed.browsers.map((listed, index) => {
    const browser = toBrowser(listed, index + 1)
    const profile = mergeProfile(
      current.profiles.get(listed.deviceId),
      current.cached.get(listed.deviceId),
    )
    const given = names.get(listed.deviceId)
    const known: Known = {
      filesRead: current.filesRead,
      ...(profile === undefined ? {} : { profile }),
      ...(given === undefined ? {} : { names: given }),
      ...(current.computerName === undefined
        ? {}
        : { computerName: current.computerName }),
    }
    return { listed, browser, known, label: labelOf(browser, known) }
  })
}

function descriptionsOf(
  described: readonly Described[],
): ReadonlyMap<string, Description> {
  return new Map(
    described.map(({ listed, browser, known, label }) => {
      const { extensionVersion, ...profileFields } = known.profile ?? {}
      return [
        listed.deviceId,
        {
          label,
          extra: {
            ...(known.profile === undefined ? {} : { profile: profileFields }),
            machine: machineOf(browser, known),
            ...(extensionVersion === undefined ? {} : { extensionVersion }),
          },
        },
      ]
    }),
  )
}

async function listBrowsers(
  $: EngineInterface,
): Promise<ParsedList | undefined> {
  try {
    const result = await $.mcp.call(
      'claude-in-chrome',
      'list_connected_browsers',
    )
    const parsed = result.isError ? undefined : parseList(result.content)
    if (parsed !== undefined) {
      lastSeen = parsed
      return parsed
    }
  } catch (error) {
    logError($, 'could not list the browsers', error)
  }
  if (lastSeen !== undefined) {
    log($, 'using the last list Claude got instead')
  }
  return lastSeen
}

async function listDescribed(
  $: EngineInterface,
): Promise<readonly Described[] | undefined> {
  const parsed = await listBrowsers($)
  return parsed === undefined ? undefined : describeAll($, parsed)
}

async function markChosen($: EngineInterface): Promise<void> {
  try {
    await $.state.set({ plugin: 'chrome-profile', key: 'chosen' }, true)
  } catch (error) {
    logError($, 'could not mark the session chosen', error)
  }
}

/** True for the one call that marks the browser as used in this session. */
async function markUsed($: EngineInterface): Promise<boolean> {
  try {
    const held = await $.state.get({
      plugin: 'chrome-profile',
      key: 'browserUsed',
    })
    if (held.value === true) {
      return false
    }
    const written = await $.state.set(
      { plugin: 'chrome-profile', key: 'browserUsed' },
      true,
      { ifVersion: held.version },
    )
    return written.isSet
  } catch (error) {
    logError($, 'could not mark the browser as used', error)
    return false
  }
}

function lineOf(
  described: readonly Described[] | undefined,
): string | undefined {
  return described === undefined
    ? undefined
    : profileLine(
        described.map(item => ({
          label: item.label,
          isInUse: item.browser.inUse === true,
          also: otherEmails(item.known.profile),
        })),
      )
}

async function isBrowserUsed($: EngineInterface): Promise<boolean> {
  try {
    const held = await $.state.get({
      plugin: 'chrome-profile',
      key: 'browserUsed',
    })
    return held.value === true
  } catch (error) {
    logError($, 'could not read whether the browser was used', error)
    return false
  }
}

/** The profile line, or undefined when listing the browsers fails or takes `LINE_LIMIT_MS` or more. */
async function lineWithinLimit(
  $: EngineInterface,
): Promise<string | undefined> {
  const line = listDescribed($).then(lineOf, (error: unknown) => {
    logError($, 'no profile line for this prompt', error)
    return undefined
  })
  const stop = new AbortController()
  const late = $.clock.sleep(LINE_LIMIT_MS, { signal: stop.signal }).then(
    (): typeof TIMED_OUT => TIMED_OUT,
    async () => line,
  )
  const first = await Promise.race([line, late])
  stop.abort()
  if (first === TIMED_OUT) {
    log(
      $,
      `listing the browsers took ${String(LINE_LIMIT_MS)} ms or more, so this prompt has no profile line`,
    )
    return undefined
  }
  return first
}

async function choose(
  $: EngineInterface,
  question: string,
  labels: readonly string[],
): Promise<number | undefined> {
  if (labels.length === 1) {
    return 0
  }
  const asked = chooser(question, labels)
  try {
    const answer = await $.ui.ask(asked.question, {
      options: asked.options,
      header: 'Chrome',
    })
    return pickedIndex(answer, labels)
  } catch (error) {
    logError($, 'the question got no answer', error)
    return undefined
  }
}

async function nameBrowser(
  $: EngineInterface,
  command: Exclude<ProfileCommand, { readonly kind: 'usage' }>,
): Promise<string> {
  const parsed = await listBrowsers($)
  if (parsed === undefined || parsed.browsers.length === 0) {
    return 'No browsers are connected.'
  }
  const described = await describeAll($, parsed)
  const isProfile = command.kind === 'name'
  const candidates = described.filter(item =>
    isProfile
      ? item.known.profile === undefined
      : !machineOf(item.browser, item.known).isThisComputer,
  )
  if (candidates.length === 0) {
    return isProfile
      ? 'Every connected browser’s profile is already known.'
      : 'No connected browser runs on another computer.'
  }
  const newName = isProfile ? command.label : command.name
  const picked =
    candidates[
      (await choose(
        $,
        isProfile
          ? `Which browser is "${newName}"?`
          : `Which browser runs on "${newName}"?`,
        candidates.map(item => item.label),
      )) ?? -1
    ]
  if (picked === undefined) {
    return 'Nothing was named.'
  }
  const names = new Map(parseNames(await storeGet($, 'names')))
  const id = picked.listed.deviceId
  const given = {
    ...names.get(id),
    ...(isProfile ? { profile: newName } : { machine: newName }),
  }
  names.set(id, given)
  await storeSet($, 'names', Object.fromEntries(names))
  return `${picked.label} is now ${labelOf(picked.browser, { ...picked.known, names: given })}.`
}

async function runCommand($: EngineInterface, args: string): Promise<string> {
  const command = parseCommand(args)
  return command.kind === 'usage' ? USAGE : nameBrowser($, command)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'chrome-profile',
        description:
          'Show and choose the Chrome profiles Claude in Chrome uses',
        argumentHint: '[name <label> | machine <name> | forget]',
        immediate: true,
      })
    } catch (error) {
      logError($, '/chrome-profile was not registered', error)
    }
    return next(e)
  })

  // Not before the first browser call: the first list opens the bridge connection, which takes up to 1.7 s.
  on('prompt.submit', async ($, e, next) => {
    if (!(await isBrowserUsed($))) {
      return next(e)
    }
    const line = await lineWithinLimit($)
    return next(
      line === undefined ? e : { ...e, context: [...(e.context ?? []), line] },
    )
  }).catch(async (_$, e, next) => next(e))

  on('command.run', { command: 'chrome-profile' }, async ($, e) => ({
    text: await runCommand($, e.args),
  }))

  on('tool.call', { tool: SELECT_TOOL }, async ($, e, next) => {
    if (next.origin.plugin !== 'engine') {
      return next(e)
    }
    const result = await next(e)
    if (result.deny !== undefined || result.isError === true) {
      return result
    }
    await markChosen($)
    const isFirst = await markUsed($)
    const deviceId = e['deviceId']
    if (lastSeen !== undefined && typeof deviceId === 'string') {
      lastSeen = withSelected(lastSeen, deviceId)
    }
    const described = await listDescribed($)
    const picked = described?.find(item => item.listed.deviceId === deviceId)
    const blocks =
      picked === undefined
        ? undefined
        : relabelSelected(result.result, picked.label)
    const relabelled =
      blocks === undefined
        ? result
        : { ...result, result: blocks, text: joinedText(blocks) }
    const line = isFirst ? lineOf(described) : undefined
    return line === undefined
      ? relabelled
      : { ...relabelled, context: [...(result.context ?? []), line] }
  }).catch(async (_$, e, next) => next(e))

  on('tool.call', { tool: CHROME_TOOL }, async ($, e, next) => {
    if (
      next.origin.plugin !== 'engine' ||
      e.tool === LIST_TOOL ||
      e.tool === SELECT_TOOL
    ) {
      return next(e)
    }
    const result = await next(e)
    if (
      result.deny !== undefined ||
      result.isError === true ||
      !(await markUsed($))
    ) {
      return result
    }
    const line = lineOf(await listDescribed($))
    return line === undefined
      ? result
      : { ...result, context: [...(result.context ?? []), line] }
  }).catch(async (_$, e, next) => next(e))

  on('tool.call', { tool: LIST_TOOL }, async ($, e, next) => {
    if (next.origin.plugin !== 'engine') {
      return next(e)
    }
    const result = await next(e)
    if (result.deny !== undefined || result.isError === true) {
      return result
    }
    await markUsed($)
    const parsed = parseList(result.result)
    if (parsed === undefined) {
      return result
    }
    lastSeen = parsed
    const blocks = rewriteList(
      parsed,
      descriptionsOf(await describeAll($, parsed)),
    )
    return { ...result, result: blocks, text: joinedText(blocks) }
  }).catch(async (_$, e, next) => next(e))
}
