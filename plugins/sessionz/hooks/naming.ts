export const MIN_PROMPT_LENGTH = 15
export const MAX_NAME_LENGTH = 60
const MAX_PROMPT_SENT = 2000
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** The prompt origins (`prompt.submit`) that mean the person typed it. */
export const TYPED_ORIGINS: readonly string[] = ['composer', 'bridge']

export interface NameCheck {
  isTyped: boolean
  prompt: string
  sessionTitle: string | undefined
}

export interface NameRequest {
  system: string
  prompt: string
}

/**
 * `source` on the UserPromptSubmit input says who sent the prompt, but
 * payloads may omit it while the field rolls out (seen absent on 2.1.296);
 * then the text must have come through `prompt.submit` from the person.
 */
export function isTypedPrompt(
  source: string | undefined,
  prompt: string,
  typed: readonly string[],
): boolean {
  return source === undefined ? typed.includes(prompt) : source === 'user'
}

/**
 * Only a real request the person typed in a session nobody named: not a
 * slash command, a /loop or schedule wakeup, the SDK, or a short greeting.
 */
export function wantsName(check: NameCheck): boolean {
  const text = check.prompt.trim()
  return (
    check.isTyped &&
    (check.sessionTitle ?? '') === '' &&
    !text.startsWith('/') &&
    text.length >= MIN_PROMPT_LENGTH
  )
}

export function buildNameRequest(prompt: string, folder: string): NameRequest {
  return {
    system: [
      'You name coding sessions so a person can find them among many terminal tabs.',
      'Reply with one title of 2 to 5 English words in lowercase kebab-case,',
      'for example fix-login-timeout or add-billing-export.',
      'Name what the person asks for. Use only a-z, 0-9 and hyphens.',
      'Reply with the title alone: no quotes, no punctuation, no other words.',
    ].join(' '),
    prompt: `Folder: ${folder}\n\nThe person's first request:\n${prompt.trim().slice(0, MAX_PROMPT_SENT)}`,
  }
}

export function parseName(reply: string): string | undefined {
  const name = reply
    .trim()
    .replace(/^["'`]+|["'`.]+$/g, '')
    .trim()
    .toLowerCase()
  return name.length <= MAX_NAME_LENGTH && NAME.test(name) ? name : undefined
}
