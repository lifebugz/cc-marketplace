export type ProfileCommand =
  | { readonly kind: 'usage' }
  | { readonly kind: 'name'; readonly label: string }
  | { readonly kind: 'machine'; readonly name: string }

export const USAGE = 'Usage: /chrome-profile [name <label> | machine <name>]'

const MAX_NAME = 60
// $.ui.ask takes at most 4 options.
const MAX_OPTIONS = 4

function cleanName(text: string): string {
  return text.replaceAll('"', '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME)
}

export function parseCommand(args: string): ProfileCommand {
  const match = /^\s*(name|machine)\s+(.+)$/s.exec(args)
  const name = cleanName(match?.[2] ?? '')
  if (match === null || name === '') {
    return { kind: 'usage' }
  }
  return match[1] === 'name'
    ? { kind: 'name', label: name }
    : { kind: 'machine', name }
}

export interface Chooser {
  readonly question: string
  readonly options: readonly string[]
}

/**
 * A question over `labels`. With more than 4, the question lists them all
 * numbered, the first 3 stay options, and the rest are picked by typing the
 * number under the dialog's free-text row.
 */
export function chooser(question: string, labels: readonly string[]): Chooser {
  if (labels.length <= MAX_OPTIONS) {
    return { question, options: labels }
  }
  const numbered = labels.map(
    (label, index) => `${String(index + 1)}. ${label}`,
  )
  return {
    question: `${question} Type its number if it is not listed below:\n${numbered.join('\n')}`,
    options: labels.slice(0, MAX_OPTIONS - 1),
  }
}

/** Which label an answer picked: the label itself, or its number typed as free text. */
export function pickedIndex(
  answer: string,
  labels: readonly string[],
): number | undefined {
  const exact = labels.indexOf(answer)
  if (exact !== -1) {
    return exact
  }
  const number = /^\s*(\d+)\s*\.?\s*$/.exec(answer)
  const index = number === null ? -1 : Number(number[1]) - 1
  return index >= 0 && index < labels.length ? index : undefined
}
