export type Fields = Readonly<Record<string, unknown>>

export function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function stringOf(fields: Fields, key: string): string | undefined {
  const value = fields[key]
  return typeof value === 'string' ? value : undefined
}

export function numberOf(fields: Fields, key: string): number | undefined {
  const value = fields[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function booleanOf(fields: Fields, key: string): boolean | undefined {
  const value = fields[key]
  return typeof value === 'boolean' ? value : undefined
}

export function isStringRecord(
  value: unknown,
): value is Readonly<Record<string, string>> {
  return (
    isRecord(value) &&
    Object.values(value).every(entry => typeof entry === 'string')
  )
}
