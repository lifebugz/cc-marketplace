import { describe, expect, test } from 'claude-code/testing'

import {
  buildNameRequest,
  isTypedPrompt,
  MAX_NAME_LENGTH,
  parseName,
  TYPED_ORIGINS,
  wantsName,
} from '../hooks/naming'

const REQUEST = 'Add a CSV export to the billing page'

describe('when a session gets a name', () => {
  const typed = { isTyped: true, sessionTitle: undefined }

  test('a real request typed into an unnamed session', () => {
    expect(wantsName({ ...typed, prompt: REQUEST })).toBe(true)
  })

  test('never when the session already has a title', () => {
    expect(
      wantsName({ ...typed, prompt: REQUEST, sessionTitle: 'billing' }),
    ).toBe(false)
  })

  test('never for a slash command or a short prompt', () => {
    expect(wantsName({ ...typed, prompt: '/tabs' })).toBe(false)
    expect(wantsName({ ...typed, prompt: '  /help me with this one  ' })).toBe(
      false,
    )
    expect(wantsName({ ...typed, prompt: 'hi there' })).toBe(false)
  })

  test('never for a prompt the person did not type', () => {
    expect(wantsName({ ...typed, isTyped: false, prompt: REQUEST })).toBe(false)
  })
})

describe('who typed the prompt', () => {
  test('source, when the payload has it, decides', () => {
    expect(isTypedPrompt('user', REQUEST, [])).toBe(true)
    for (const source of ['sdk', 'loop_wakeup', 'schedule_wakeup', 'system']) {
      expect(isTypedPrompt(source, REQUEST, [REQUEST]), source).toBe(false)
    }
  })

  test('without source, the text must have come from the composer', () => {
    expect(isTypedPrompt(undefined, REQUEST, ['older one', REQUEST])).toBe(true)
    expect(isTypedPrompt(undefined, REQUEST, ['older one'])).toBe(false)
  })

  test('the composer and Remote Control count as the person', () => {
    expect(TYPED_ORIGINS).toEqual(['composer', 'bridge'])
  })
})

describe("Haiku's reply", () => {
  test('a kebab-case title is kept', () => {
    expect(parseName('add-billing-csv-export')).toBe('add-billing-csv-export')
  })

  test('quotes, a final period and capitals are cleaned off', () => {
    expect(parseName('"Add-Billing-Export".\n')).toBe('add-billing-export')
    expect(parseName('`fix-login`')).toBe('fix-login')
  })

  test('anything else is dropped', () => {
    expect(parseName('Sure! Here is a title: add-export')).toBeUndefined()
    expect(parseName('add billing export')).toBeUndefined()
    expect(parseName('')).toBeUndefined()
    expect(parseName('a'.repeat(MAX_NAME_LENGTH + 1))).toBeUndefined()
  })
})

describe('the request', () => {
  test('names the folder and sends at most 2000 characters of the prompt', () => {
    const request = buildNameRequest('x'.repeat(5000), 'shop')
    expect(request.prompt).toStartWith('Folder: shop\n')
    expect(request.prompt.length).toBeLessThan(2100)
    expect(request.system).toContain('kebab-case')
  })
})
