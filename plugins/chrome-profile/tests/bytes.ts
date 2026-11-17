const encoder = new TextEncoder()

export function utf8(text: string): Uint8Array {
  return encoder.encode(text)
}

export function concat(...parts: readonly (readonly number[])[]): Uint8Array {
  return Uint8Array.from(parts.flat())
}

export function varint(value: number): number[] {
  const out: number[] = []
  let rest = value
  while (rest >= 0x80) {
    out.push((rest % 0x80) | 0x80)
    rest = Math.floor(rest / 0x80)
  }
  out.push(rest)
  return out
}

function le(value: number, size: number): number[] {
  const out: number[] = []
  let rest = value
  for (let i = 0; i < size; i++) {
    out.push(rest % 256)
    rest = Math.floor(rest / 256)
  }
  return out
}

function le64(value: bigint): number[] {
  const out: number[] = []
  let rest = value
  for (let i = 0; i < 8; i++) {
    out.push(Number(rest & 0xffn))
    rest >>= 8n
  }
  return out
}

/** A Snappy block made of literal runs only, which every decoder must accept. */
export function snappyLiterals(data: Readonly<Uint8Array>): Uint8Array {
  const out = varint(data.length)
  for (let at = 0; at < data.length; at += 60) {
    const run = [...data.subarray(at, at + 60)]
    out.push((run.length - 1) << 2, ...run)
  }
  return Uint8Array.from(out)
}

export interface Put {
  readonly key: string
  readonly value?: string
}

/** A LevelDB write batch: a `value` of undefined is a deletion. */
export function batch(seq: bigint, puts: readonly Put[]): number[] {
  const out = [...le64(seq), ...le(puts.length, 4)]
  for (const put of puts) {
    const key = [...utf8(put.key)]
    if (put.value === undefined) {
      out.push(0, ...varint(key.length), ...key)
    } else {
      const value = [...utf8(put.value)]
      out.push(
        1,
        ...varint(key.length),
        ...key,
        ...varint(value.length),
        ...value,
      )
    }
  }
  return out
}

const LOG_BLOCK = 32768
const LOG_HEADER = 7

/** A LevelDB `.log` file holding the batches, split across 32 KiB blocks as LevelDB writes them. */
export function logFile(batches: readonly (readonly number[])[]): Uint8Array {
  const out: number[] = []
  for (const data of batches) {
    let at = 0
    let first = true
    do {
      const left = LOG_BLOCK - (out.length % LOG_BLOCK)
      if (left < LOG_HEADER) {
        out.push(...new Array<number>(left).fill(0))
        continue
      }
      const size = Math.min(data.length - at, left - LOG_HEADER)
      const last = at + size === data.length
      let type = 3
      if (first && last) {
        type = 1
      } else if (first) {
        type = 2
      } else if (last) {
        type = 4
      }
      out.push(0, 0, 0, 0, ...le(size, 2), type, ...data.slice(at, at + size))
      at += size
      first = false
    } while (at < data.length)
  }
  return Uint8Array.from(out)
}

function internalKey(key: string, seq: bigint, isDeleted: boolean): number[] {
  return [...utf8(key), ...le64((seq << 8n) | (isDeleted ? 0n : 1n))]
}

function block(
  entries: readonly (readonly [readonly number[], readonly number[]])[],
): number[] {
  const out: number[] = []
  for (const [key, value] of entries) {
    out.push(
      0,
      ...varint(key.length),
      ...varint(value.length),
      ...key,
      ...value,
    )
  }
  out.push(...le(0, 4), ...le(1, 4))
  return out
}

export interface TableEntry {
  readonly key: string
  readonly seq: bigint
  readonly value?: string
}

export interface TableOptions {
  readonly compression?: 'none' | 'snappy' | 'unknown'
}

/** A LevelDB `.ldb` table with one data block, an empty metaindex block, an index block and a footer. */
export function tableFile(
  entries: readonly TableEntry[],
  options: TableOptions = {},
): Uint8Array {
  const out: number[] = []
  const handles: number[][] = []
  const compression = options.compression ?? 'none'
  const blocks = [
    block(
      entries.map(entry => [
        internalKey(entry.key, entry.seq, entry.value === undefined),
        [...utf8(entry.value ?? '')],
      ]),
    ),
    block([]),
  ]
  blocks.forEach((raw, index) => {
    const isData = index === 0
    let stored = raw
    let type = 0
    if (isData && compression === 'snappy') {
      stored = [...snappyLiterals(Uint8Array.from(raw))]
      type = 1
    } else if (isData && compression === 'unknown') {
      type = 7
    }
    handles.push([...varint(out.length), ...varint(stored.length)])
    out.push(...stored, type, 0, 0, 0, 0)
  })
  const [dataHandle = [], metaHandle = []] = handles
  const index = block([[[...utf8('~')], dataHandle]])
  const indexHandle = [...varint(out.length), ...varint(index.length)]
  out.push(...index, 0, 0, 0, 0, 0)
  const footer = [...metaHandle, ...indexHandle]
  footer.push(...new Array<number>(40 - footer.length).fill(0))
  footer.push(0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb)
  out.push(...footer)
  return Uint8Array.from(out)
}
