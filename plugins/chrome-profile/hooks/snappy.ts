export type Decoded<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string }

export function byteAt(bytes: Readonly<Uint8Array>, at: number): number {
  const byte = bytes[at]
  if (byte === undefined) {
    throw new Error(`byte ${String(at)} is past the end`)
  }
  return byte
}

export function readVarint(
  bytes: Readonly<Uint8Array>,
  start: number,
): readonly [value: number, next: number] {
  let value = 0
  let scale = 1
  for (let at = start; at < start + 5; at++) {
    const byte = byteAt(bytes, at)
    value += (byte & 0x7f) * scale
    if ((byte & 0x80) === 0) {
      return [value, at + 1]
    }
    scale *= 0x80
  }
  throw new Error(`the number at byte ${String(start)} is longer than 5 bytes`)
}

export function readLittle(
  bytes: Readonly<Uint8Array>,
  start: number,
  width: number,
): number {
  let value = 0
  for (let i = width - 1; i >= 0; i--) {
    value = value * 256 + byteAt(bytes, start + i)
  }
  return value
}

function decompress(src: Readonly<Uint8Array>): Uint8Array {
  const [length, start] = readVarint(src, 0)
  const out = new Uint8Array(length)
  let at = 0
  let pos = start
  while (pos < src.length) {
    const tag = byteAt(src, pos)
    pos += 1
    let size: number
    if ((tag & 3) === 0) {
      size = tag >> 2
      if (size >= 60) {
        const width = size - 59
        size = readLittle(src, pos, width)
        pos += width
      }
      size += 1
      if (pos + size > src.length) {
        throw new Error('a literal runs past the end of the block')
      }
      if (at + size > length) {
        throw new Error('the block holds more than its header says')
      }
      out.set(src.subarray(pos, pos + size), at)
      pos += size
      at += size
      continue
    }
    let offset: number
    if ((tag & 3) === 1) {
      size = ((tag >> 2) & 7) + 4
      offset = (tag >> 5) * 256 + byteAt(src, pos)
      pos += 1
    } else {
      const width = (tag & 3) === 2 ? 2 : 4
      size = (tag >> 2) + 1
      offset = readLittle(src, pos, width)
      pos += width
    }
    if (offset === 0 || offset > at) {
      throw new Error(
        `a copy at byte ${String(pos)} reaches outside the output`,
      )
    }
    if (at + size > length) {
      throw new Error('the block holds more than its header says')
    }
    // Byte by byte, because a copy may overlap the bytes it is writing.
    for (let i = 0; i < size; i++) {
      out[at + i] = byteAt(out, at - offset + i)
    }
    at += size
  }
  if (at !== length) {
    throw new Error(
      `the block holds ${String(at)} bytes, but its header says ${String(length)}`,
    )
  }
  return out
}

/** Decodes one Snappy block; bad input is an `ok: false` result, never a throw. */
export function snappyDecompress(
  src: Readonly<Uint8Array>,
): Decoded<Uint8Array> {
  try {
    return { ok: true, value: decompress(src) }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
