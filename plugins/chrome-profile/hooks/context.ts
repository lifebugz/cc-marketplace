import type { Browser } from './profiles'

/** One browser in the list block, with its whole entry kept so no field is lost. */
export interface Listed {
  readonly deviceId: string
  readonly name: string
  readonly entry: Readonly<Record<string, unknown>>
}

export interface ParsedList {
  readonly blocks: readonly unknown[]
  /** Which block holds the JSON list; every other text block is prose. */
  readonly listAt: number
  readonly browsers: readonly Listed[]
}

/** What the mod adds for one browser: its label, and the fields Claude reads. */
export interface Description {
  readonly label: string
  readonly extra: Readonly<Record<string, unknown>>
}

const DEVICE_MENTION = /"([^"]*)" \(deviceId ([0-9a-fA-F-]+)\)/g

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOfBlock(block: unknown): string | undefined {
  if (!isRecord(block) || block['type'] !== 'text') {
    return undefined
  }
  const text = block['text']
  return typeof text === 'string' ? text : undefined
}

function browsersIn(text: string): Listed[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) {
    return undefined
  }
  const items: readonly unknown[] = parsed
  const browsers: Listed[] = []
  for (const item of items) {
    if (!isRecord(item)) {
      return undefined
    }
    const deviceId = item['deviceId']
    const name = item['name']
    if (typeof deviceId !== 'string' || typeof name !== 'string') {
      return undefined
    }
    browsers.push({ deviceId, name, entry: item })
  }
  return browsers
}

/** Finds the browser list in `list_connected_browsers`'s result; anything unexpected is undefined. */
export function parseList(result: unknown): ParsedList | undefined {
  if (!Array.isArray(result)) {
    return undefined
  }
  const blocks: readonly unknown[] = result
  for (let at = 0; at < blocks.length; at++) {
    const text = textOfBlock(blocks[at])
    const browsers = text === undefined ? undefined : browsersIn(text)
    if (browsers !== undefined) {
      return { blocks, listAt: at, browsers }
    }
  }
  return undefined
}

export function toBrowser(listed: Listed, position: number): Browser {
  const os = listed.entry['osPlatform']
  return {
    deviceId: listed.deviceId,
    bridgeName: listed.name,
    position,
    ...(typeof os === 'string' ? { os } : {}),
    ...(listed.entry['onThisComputer'] === true
      ? { onThisComputer: true }
      : {}),
    ...(listed.entry['inUse'] === true ? { inUse: true } : {}),
  }
}

/** Swaps each `"<name>" (deviceId <id>)` for its label, matched by device ID, whatever the wording. */
export function relabelSentence(
  text: string,
  descriptions: ReadonlyMap<string, Description>,
): string {
  return text.replace(
    DEVICE_MENTION,
    (whole: string, _name: string, id: string) => {
      const description = descriptions.get(id)
      return description === undefined
        ? whole
        : `"${description.label}" (deviceId ${id})`
    },
  )
}

export function rewriteList(
  parsed: ParsedList,
  descriptions: ReadonlyMap<string, Description>,
): unknown[] {
  return parsed.blocks.map((block, at) => {
    const text = textOfBlock(block)
    if (text === undefined || !isRecord(block)) {
      return block
    }
    if (at !== parsed.listAt) {
      return { ...block, text: relabelSentence(text, descriptions) }
    }
    const entries = parsed.browsers.map(listed => {
      const description = descriptions.get(listed.deviceId)
      return description === undefined
        ? listed.entry
        : {
            ...listed.entry,
            name: description.label,
            bridgeName: listed.name,
            ...description.extra,
          }
    })
    return { ...block, text: JSON.stringify(entries) }
  })
}

/** The text blocks joined by new lines, the way the tool's own `text` field holds them. */
export function joinedText(blocks: readonly unknown[]): string {
  return blocks
    .map(textOfBlock)
    .filter(text => text !== undefined)
    .join('\n')
}
