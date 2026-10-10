import { describe, expect, test } from 'claude-code/testing'

import type { ClosedTask, HtlRequest, HtlTask } from '../types'
import {
  MAX_OPEN,
  assignedText,
  cardHeader,
  contextLine,
  decisionPrompt,
  gateDenial,
  inputSchema,
  parseRequest,
  refusalText,
  reminderLine,
  sameTitle,
  secretsMode,
  statusLine,
  toolDescription,
  validateRequest,
} from '../hooks/tasks'

const LOGIN: HtlRequest = {
  title: 'Log in to the GitHub CLI',
  steps: 'Run `! gh auth login` and finish the browser login.',
  blocker: 'login',
  why: 'The login needs a browser and a 2FA code.',
  tried: 'Ran `gh auth status`: not logged in.',
  mode: 'now',
}

const SECRET: HtlRequest = {
  title: 'Create the Twilio auth token',
  steps:
    'Create a token in the Twilio console and save it in 1Password as `op://Private/Twilio/auth token`.',
  blocker: 'secret',
  why: 'The token does not exist yet.',
  tried:
    'Ran `op item get "Twilio" --vault "Private" > /dev/null`: no such item.',
  mode: 'now',
}

const task = (id: number, request: HtlRequest = LOGIN): HtlTask => ({
  ...request,
  id,
  isArmed: request.mode === 'now',
})

const EMPTY = { open: [], closed: [], secrets: '1password' } as const

const without = (field: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(LOGIN).filter(([key]) => key !== field))

describe('parseRequest', () => {
  test('a full request parses, trimmed, with and without check', () => {
    expect(parseRequest({ ...LOGIN, title: '  Log in  ' })).toEqual({
      request: { ...LOGIN, title: 'Log in' },
    })
    expect(parseRequest({ ...LOGIN, check: ' gh auth status ' })).toEqual({
      request: { ...LOGIN, check: 'gh auth status' },
    })
  })

  test('the tool.call envelope fields are not extra fields', () => {
    expect(
      parseRequest({
        ...LOGIN,
        tool: 'mcp__htl__assign_task',
        tool_use_id: 'toolu_1',
        agentId: 'a1',
        requestMeta: {},
        consent: 'yes',
      }),
    ).toEqual({ request: LOGIN })
  })

  for (const field of ['title', 'steps', 'why', 'tried'] as const) {
    test(`${field}: missing, blank and not a string are refused`, () => {
      expect(parseRequest(without(field)).problems).toEqual([
        `${field} is missing`,
      ])
      expect(parseRequest({ ...LOGIN, [field]: '   ' }).problems).toEqual([
        `${field} is empty`,
      ])
      expect(parseRequest({ ...LOGIN, [field]: 7 }).problems).toEqual([
        `${field} must be a string`,
      ])
    })
  }

  test('blocker and mode take only their listed values', () => {
    expect(parseRequest({ ...LOGIN, blocker: 'hard' }).problems).toEqual([
      'blocker must be one of: secret, login, physical, payment_or_legal, no_access',
    ])
    expect(parseRequest({ ...LOGIN, mode: 'later' }).problems).toEqual([
      'mode must be one of: now, parallel',
    ])
    expect(parseRequest(without('mode')).problems).toEqual(['mode is missing'])
  })

  test('check must be a string; a blank check is left out', () => {
    expect(parseRequest({ ...LOGIN, check: 3 }).problems).toEqual([
      'check must be a string',
    ])
    expect(parseRequest({ ...LOGIN, check: '  ' })).toEqual({
      request: LOGIN,
    })
  })

  test('extra fields are refused, and every problem is listed', () => {
    expect(parseRequest({ ...LOGIN, urgency: 'high' }).problems).toEqual([
      'unknown fields: urgency',
    ])
    expect(parseRequest({ title: '', mode: 'soon', x: 1 }).problems).toEqual([
      'title is empty',
      'steps is missing',
      'blocker is missing',
      'why is missing',
      'tried is missing',
      'mode must be one of: now, parallel',
      'unknown fields: x',
    ])
  })

  test('an input that is not an object is refused', () => {
    expect(parseRequest(null).problems).toEqual(['the input must be an object'])
    expect(parseRequest(['x']).problems).toEqual([
      'the input must be an object',
    ])
  })
})

describe('validateRequest', () => {
  test('a fourth open task is refused', () => {
    const open = [task(1), task(2), task(3)].map((one, i) => ({
      ...one,
      title: `job ${String(i)}`,
    }))
    expect(open.length).toBe(MAX_OPEN)
    expect(validateRequest(LOGIN, { ...EMPTY, open })).toBe(
      'Not assigned. The user already has 3 open tasks. Wait for them.',
    )
    expect(
      validateRequest(LOGIN, { ...EMPTY, open: open.slice(0, 2) }),
    ).toBeUndefined()
  })

  test('the same title as an open task is refused', () => {
    expect(
      validateRequest(
        { ...LOGIN, title: '  log IN to the   github cli ' },
        { ...EMPTY, open: [task(4)] },
      ),
    ).toBe(
      'Not assigned. Task #4 "Log in to the GitHub CLI" is already open. Don\'t assign it twice; wait for the user.',
    )
  })

  test('a rejected or handed-back title is refused, whatever its case and spacing', () => {
    const rejected: ClosedTask = {
      id: 2,
      title: LOGIN.title,
      decision: 'reject',
    }
    const handed: ClosedTask = { ...rejected, decision: 'handback' }
    const retry = { ...LOGIN, title: ' LOG IN to the GitHub  CLI' }

    expect(validateRequest(retry, { ...EMPTY, closed: [rejected] })).toBe(
      'Not assigned. The user already rejected task #2 "Log in to the GitHub CLI". Don\'t assign it again. Find another way, or tell the user what stays blocked.',
    )
    expect(validateRequest(retry, { ...EMPTY, closed: [handed] })).toBe(
      'Not assigned. The user already said you can do task #2 "Log in to the GitHub CLI" yourself. Do it with your own tools; don\'t assign it again.',
    )
  })

  test('an accepted title may be assigned again (the login can expire)', () => {
    const accepted: ClosedTask = {
      id: 2,
      title: LOGIN.title,
      decision: 'accept',
    }
    expect(
      validateRequest(LOGIN, { ...EMPTY, closed: [accepted] }),
    ).toBeUndefined()
  })

  test('sameTitle trims, lowercases and folds spaces', () => {
    expect(sameTitle('  Log  In ', 'log in')).toBe(true)
    expect(sameTitle('Log in', 'Log out')).toBe(false)
  })

  describe('1Password', () => {
    const NO_EVIDENCE =
      'Not assigned. Your secrets are in 1Password. Reference the secret as `op://…` and run the command with `op run` or `op inject`. Assign a task only if the item is missing: check with `op item get "<item>" --vault "<vault>" > /dev/null`, and say in `tried` what you found.'
    const NO_REFERENCE =
      'Not assigned. Your secrets are in 1Password. In `steps`, name the exact reference the user should save the new secret under, as `op://<vault>/<item>/<field>`, then call mcp__htl__assign_task again.'

    test('a secret task that names 1Password and an op:// reference is allowed', () => {
      expect(validateRequest(SECRET, EMPTY)).toBeUndefined()
      expect(
        validateRequest(
          { ...SECRET, tried: 'Searched 1Password: none.' },
          EMPTY,
        ),
      ).toBeUndefined()
    })

    test('a secret task with no 1Password evidence in tried is refused', () => {
      expect(
        validateRequest({ ...SECRET, tried: 'Looked in .env: empty.' }, EMPTY),
      ).toBe(NO_EVIDENCE)
    })

    test('a secret task whose steps name no op:// reference is refused', () => {
      expect(
        validateRequest(
          { ...SECRET, steps: 'Create the token and paste it into .env.' },
          EMPTY,
        ),
      ).toBe(NO_REFERENCE)
      expect(
        validateRequest(
          { ...SECRET, steps: 'Save it in 1Password under op://Private.' },
          EMPTY,
        ),
      ).toBe(NO_REFERENCE)
    })

    test('vault, item and field names may hold spaces', () => {
      expect(
        validateRequest(
          {
            ...SECRET,
            steps: 'Save it as `op://Team Vault/GitHub PAT/credential`.',
          },
          EMPTY,
        ),
      ).toBeUndefined()
    })

    test('under none, a secret task needs no 1Password evidence', () => {
      expect(
        validateRequest(
          { ...SECRET, tried: 'Looked in .env.', steps: 'Paste it in .env.' },
          { ...EMPTY, secrets: 'none' },
        ),
      ).toBeUndefined()
    })

    test('other blockers need no 1Password evidence', () => {
      expect(validateRequest(LOGIN, EMPTY)).toBeUndefined()
    })
  })
})

describe('secretsMode', () => {
  test('1password stays 1password; anything else counts as none', () => {
    expect(secretsMode('1password')).toBe('1password')
    expect(secretsMode('none')).toBe('none')
    expect(secretsMode(undefined)).toBe('none')
  })
})

describe('the tool description', () => {
  test('holds the 1Password rules only under 1password', () => {
    expect(toolDescription('1password')).toContain('op run --env-file=')
    expect(toolDescription('1password')).toContain('op inject -i')
    expect(toolDescription('none')).not.toContain('1Password')
    expect(toolDescription('none')).not.toContain('op://')
  })

  test('both versions fit the 4096 characters the model is sent', () => {
    expect(toolDescription('1password').length).toBeLessThanOrEqual(4096)
    expect(toolDescription('none').length).toBeLessThanOrEqual(4096)
  })

  test('the steps ask for the op:// reference only under 1password', () => {
    const stepsOf = (schema: Readonly<Record<string, unknown>>): unknown =>
      JSON.stringify(schema['properties'])
    expect(stepsOf(inputSchema('1password'))).toContain(
      'the exact 1Password reference to save it under',
    )
    expect(stepsOf(inputSchema('none'))).not.toContain('1Password')
  })

  test('the schema requires every field but check, and nothing else', () => {
    const schema = inputSchema('1password')
    expect(schema['required']).toEqual([
      'title',
      'steps',
      'blocker',
      'why',
      'tried',
      'mode',
    ])
    expect(schema['additionalProperties']).toBe(false)
  })
})

describe('texts Claude reads', () => {
  test('the now and parallel results', () => {
    expect(assignedText(task(1))).toBe(
      'Assigned as task #1 (now). End your turn now with one short line saying what you are waiting for. Other tool calls are refused until the user answers; the answer arrives as the next user message.',
    )
    expect(assignedText(task(2, { ...LOGIN, mode: 'parallel' }))).toBe(
      "Assigned as task #2 (parallel). Keep working only on what does not depend on it. Don't do it yourself, don't assume it's done. When that work is done, end your turn and say you are waiting for task #2.",
    )
  })

  test('the gate, context and refusal lines', () => {
    expect(gateDenial(task(1))).toBe(
      'Waiting for the user to finish HTL task #1 "Log in to the GitHub CLI". End your turn now.',
    )
    expect(
      contextLine([task(1), task(2, { ...SECRET, mode: 'parallel' })]),
    ).toBe(
      'Open HTL tasks waiting for the user: #1 "Log in to the GitHub CLI" (now), #2 "Create the Twilio auth token" (parallel). Don\'t assume they are done.',
    )
    expect(refusalText(['title is missing', 'mode is missing'])).toBe(
      'The task was not assigned: title is missing; mode is missing. Fix these fields and call mcp__htl__assign_task again.',
    )
  })

  describe('decisionPrompt', () => {
    const checked = task(1, { ...LOGIN, check: 'gh auth status' })

    test('accept, with a check and a message', () => {
      expect(decisionPrompt(checked, 'accept', '  used my work account ')).toBe(
        'HTL task #1 "Log in to the GitHub CLI": accepted, I did it.\nMy message: used my work account\nCheck it worked (run `gh auth status` or re-run what failed), then continue.',
      )
    })

    test('accept, with no check and no message', () => {
      expect(decisionPrompt(task(1), 'accept', '   ')).toBe(
        'HTL task #1 "Log in to the GitHub CLI": accepted, I did it.\nCheck it worked (re-run what failed), then continue.',
      )
    })

    test('reject, with and without a message', () => {
      expect(decisionPrompt(checked, 'reject', 'not today')).toBe(
        "HTL task #1 \"Log in to the GitHub CLI\": rejected, I won't do it.\nMy message: not today\nDon't assume it's done. Find another way, or tell me what stays blocked.",
      )
      expect(decisionPrompt(checked, 'reject', '')).toBe(
        "HTL task #1 \"Log in to the GitHub CLI\": rejected, I won't do it.\nDon't assume it's done. Find another way, or tell me what stays blocked.",
      )
    })

    test('you can do this, with and without a message', () => {
      expect(decisionPrompt(checked, 'handback', 'use the token in CI')).toBe(
        'HTL task #1 "Log in to the GitHub CLI": you can do this yourself.\nMy message: use the token in CI\nDo it with your own tools. Don\'t assign it to me again.',
      )
      expect(decisionPrompt(checked, 'handback', '')).toBe(
        'HTL task #1 "Log in to the GitHub CLI": you can do this yourself.\nDo it with your own tools. Don\'t assign it to me again.',
      )
    })
  })
})

describe('texts the user reads', () => {
  test('the reminder and status lines count tasks', () => {
    expect(reminderLine([task(1)])).toBe(
      '⏳ htl: waiting for you on task #1 · /htl',
    )
    expect(reminderLine([task(1), task(3)])).toBe(
      '⏳ htl: waiting for you on tasks #1, #3 · /htl',
    )
    expect(statusLine(1)).toBe('1 task waiting for you · /htl')
    expect(statusLine(2)).toBe('2 tasks waiting for you · /htl')
  })

  test('the card header shows the focus hint until the pane has the keys', () => {
    expect(cardHeader(task(1), 1, 2, false)).toBe(
      '#1 · NOW · 1 of 2 · ctrl+x tab to use',
    )
    expect(
      cardHeader(task(4, { ...LOGIN, mode: 'parallel' }), 2, 2, true),
    ).toBe('#4 · PARALLEL · 2 of 2')
  })
})
