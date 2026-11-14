import { byteAt, readLittle, readVarint, snappyDecompress } from './snappy'

export interface Entry {
  readonly key: string
  readonly value: string
  readonly seq: bigint
  readonly isDeleted: boolean
}

/** What a file gave: every entry that could be read, and why the rest could not. */
export interface Read {
  readonly entries: readonly Entry[]
  readonly problems: readonly string[]
}

const LOG_BLOCK = 32768
const LOG_HEADER = 7
const FOOTER = 48
const MAGIC = [0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb] as const
const text = new TextDecoder()

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readBigUint64(bytes: Readonly<Uint8Array>, at: number): bigint {
  if (at + 8 > bytes.length) {
    throw new Error(`a sequence number at byte ${String(at)} is past the end`)
  }
  return new DataView(bytes.buffer, bytes.byteOffset + at, 8).getBigUint64(
    0,
    true,
  )
}

function readBatch(data: Readonly<Uint8Array>): Entry[] {
  const seq = readBigUint64(data, 0)
  const count = readLittle(data, 8, 4)
  const entries: Entry[] = []
  let pos = 12
  for (let i = 0; i < count; i++) {
    const tag = byteAt(data, pos)
    const [keySize, keyStart] = readVarint(data, pos + 1)
    const key = text.decode(data.subarray(keyStart, keyStart + keySize))
    pos = keyStart + keySize
    let value = ''
    if (tag === 1) {
      const [valueSize, valueStart] = readVarint(data, pos)
      if (valueStart + valueSize > data.length) {
        throw new Error('a value runs past the end of its batch')
      }
      value = text.decode(data.subarray(valueStart, valueStart + valueSize))
      pos = valueStart + valueSize
    } else if (tag !== 0) {
      throw new Error(`a batch record has the unknown tag ${String(tag)}`)
    }
    entries.push({ key, value, seq: seq + BigInt(i), isDeleted: tag === 0 })
  }
  return entries
}

function joined(parts: readonly Readonly<Uint8Array>[]): Uint8Array {
  const whole = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  )
  let at = 0
  for (const part of parts) {
    whole.set(part, at)
    at += part.length
  }
  return whole
}

/** Reads a LevelDB `.log` file; a bad record costs only itself. */
export function readLog(file: Readonly<Uint8Array>): Read {
  const entries: Entry[] = []
  const problems: string[] = []
  const addBatch = (data: Readonly<Uint8Array>, at: number): void => {
    try {
      entries.push(...readBatch(data))
    } catch (error) {
      problems.push(`the batch at byte ${String(at)}: ${messageOf(error)}`)
    }
  }
  let parts: Uint8Array[] = []
  let pos = 0
  while (pos + LOG_HEADER <= file.length) {
    const left = LOG_BLOCK - (pos % LOG_BLOCK)
    if (left < LOG_HEADER) {
      pos += left
      continue
    }
    const size = readLittle(file, pos + 4, 2)
    const type = byteAt(file, pos + 6)
    const start = pos + LOG_HEADER
    if (type === 0) {
      break
    }
    if (start + size > file.length) {
      problems.push(
        `the record at byte ${String(pos)} is cut off at the end of the file`,
      )
      break
    }
    const data = file.subarray(start, start + size)
    if (type === 1) {
      addBatch(data, pos)
    } else if (type === 2) {
      parts = [data]
    } else if (type === 3) {
      parts.push(data)
    } else if (type === 4) {
      parts.push(data)
      addBatch(joined(parts), pos)
      parts = []
    } else {
      problems.push(
        `the record at byte ${String(pos)} has the unknown type ${String(type)}`,
      )
      break
    }
    pos = start + size
  }
  return { entries, problems }
}

function readBlock(
  file: Readonly<Uint8Array>,
  offset: number,
  size: number,
): Uint8Array {
  if (offset + size + 5 > file.length) {
    throw new Error(`the block at byte ${String(offset)} runs past the end`)
  }
  const raw = file.subarray(offset, offset + size)
  const type = byteAt(file, offset + size)
  if (type === 0) {
    return raw
  }
  if (type === 1) {
    const decoded = snappyDecompress(raw)
    if (!decoded.ok) {
      throw new Error(`the block at byte ${String(offset)}: ${decoded.error}`)
    }
    return decoded.value
  }
  throw new Error(
    `the block at byte ${String(offset)} has the unknown compression type ${String(type)}`,
  )
}

interface BlockEntry {
  readonly key: Readonly<Uint8Array>
  readonly value: Readonly<Uint8Array>
}

function blockEntries(block: Readonly<Uint8Array>): BlockEntry[] {
  const restarts = readLittle(block, block.length - 4, 4)
  const end = block.length - 4 - 4 * restarts
  if (end < 0) {
    throw new Error('a block has more restart points than bytes')
  }
  const entries: BlockEntry[] = []
  let key = new Uint8Array(0)
  let pos = 0
  while (pos < end) {
    const [shared, afterShared] = readVarint(block, pos)
    const [unshared, afterUnshared] = readVarint(block, afterShared)
    const [valueSize, start] = readVarint(block, afterUnshared)
    if (shared > key.length || start + unshared + valueSize > end) {
      throw new Error(`a block entry at byte ${String(pos)} is malformed`)
    }
    const next = new Uint8Array(shared + unshared)
    next.set(key.subarray(0, shared))
    next.set(block.subarray(start, start + unshared), shared)
    key = next
    const valueStart = start + unshared
    entries.push({
      key,
      value: block.subarray(valueStart, valueStart + valueSize),
    })
    pos = valueStart + valueSize
  }
  return entries
}

function tableIndex(file: Readonly<Uint8Array>): BlockEntry[] {
  if (file.length < FOOTER) {
    throw new Error('the file is too short to be a table')
  }
  const footer = file.subarray(file.length - FOOTER)
  MAGIC.forEach((byte, i) => {
    if (footer[40 + i] !== byte) {
      throw new Error('the file does not end with the table magic number')
    }
  })
  const [, afterMetaOffset] = readVarint(footer, 0)
  const [, indexStart] = readVarint(footer, afterMetaOffset)
  const [indexOffset, afterIndexOffset] = readVarint(footer, indexStart)
  const [indexSize] = readVarint(footer, afterIndexOffset)
  return blockEntries(readBlock(file, indexOffset, indexSize))
}

function tableEntry(entry: BlockEntry): Entry {
  const size = entry.key.length - 8
  if (size < 0) {
    throw new Error('a table key is shorter than its 8-byte trailer')
  }
  const trailer = readBigUint64(entry.key, size)
  return {
    key: text.decode(entry.key.subarray(0, size)),
    value: text.decode(entry.value),
    seq: trailer >> 8n,
    isDeleted: (trailer & 0xffn) === 0n,
  }
}

/** Reads a LevelDB `.ldb` table; a bad data block costs only itself. */
export function readTable(file: Readonly<Uint8Array>): Read {
  let index: BlockEntry[]
  try {
    index = tableIndex(file)
  } catch (error) {
    return { entries: [], problems: [messageOf(error)] }
  }
  const entries: Entry[] = []
  const problems: string[] = []
  for (const { value: handle } of index) {
    try {
      const [offset, next] = readVarint(handle, 0)
      const [size] = readVarint(handle, next)
      entries.push(
        ...blockEntries(readBlock(file, offset, size)).map(tableEntry),
      )
    } catch (error) {
      problems.push(messageOf(error))
    }
  }
  return { entries, problems }
}

/** The newest write of `key`, or undefined when it was never written or its newest write deleted it. */
export function newestValue(
  entries: readonly Entry[],
  key: string,
): { readonly value: string; readonly seq: bigint } | undefined {
  let newest: Entry | undefined
  for (const entry of entries) {
    if (entry.key === key && (newest === undefined || entry.seq > newest.seq)) {
      newest = entry
    }
  }
  if (newest === undefined || newest.isDeleted) {
    return undefined
  }
  return { value: newest.value, seq: newest.seq }
}

/** `$.fs.read`'s base64 as bytes, through `atob`, a global every mod has. */
export function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
