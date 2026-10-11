import type {
  Blocker,
  ClosedTask,
  Decision,
  HtlRequest,
  HtlTask,
  Mode,
  SecretsMode,
} from '../types'

export const TOOL = 'mcp__htl__assign_task'
export const TOOL_NAME = 'assign_task'
export const MAX_OPEN = 3
const NOT_ASSIGNED = 'Not assigned.'

export const BLOCKERS: readonly Blocker[] = [
  'secret',
  'login',
  'physical',
  'payment_or_legal',
  'no_access',
]
export const MODES: readonly Mode[] = ['now', 'parallel']

const REQUIRED = ['title', 'steps', 'blocker', 'why', 'tried', 'mode'] as const
const FIELDS: ReadonlySet<string> = new Set([...REQUIRED, 'check'])
const ENVELOPE: ReadonlySet<string> = new Set([
  'tool',
  'tool_use_id',
  'agentId',
  'requestMeta',
  'consent',
])
const ONE_PASSWORD_EVIDENCE = /\bop\b|op:\/\/|1password/i
const OP_REFERENCE = /op:\/\/[^/\n]+\/[^/\n]+\/[^/\n]+/

export type Parsed =
  | { request: HtlRequest; problems?: undefined }
  | { request?: undefined; problems: readonly string[] }

export interface SessionTasks {
  readonly open: readonly HtlTask[]
  readonly closed: readonly ClosedTask[]
  readonly secrets: SecretsMode
}

type Field<T> =
  | { readonly value: T; readonly problem?: undefined }
  | { readonly value?: undefined; readonly problem: string }

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOneOf<T extends string>(
  options: readonly T[],
  value: unknown,
): value is T {
  return options.some(option => option === value)
}

function textField(
  input: Readonly<Record<string, unknown>>,
  name: string,
): Field<string> {
  const value = input[name]
  if (value === undefined) {
    return { problem: `${name} is missing` }
  }
  if (typeof value !== 'string') {
    return { problem: `${name} must be a string` }
  }
  if (value.trim() === '') {
    return { problem: `${name} is empty` }
  }
  return { value: value.trim() }
}

function choiceField<T extends string>(
  input: Readonly<Record<string, unknown>>,
  name: string,
  options: readonly T[],
): Field<T> {
  const value = input[name]
  if (value === undefined) {
    return { problem: `${name} is missing` }
  }
  if (!isOneOf(options, value)) {
    return { problem: `${name} must be one of: ${options.join(', ')}` }
  }
  return { value }
}

function checkField(value: unknown): Field<string | undefined> {
  if (value === undefined) {
    return { value: undefined }
  }
  if (typeof value !== 'string') {
    return { problem: 'check must be a string' }
  }
  return { value: value.trim() === '' ? undefined : value.trim() }
}

export function parseRequest(e: unknown): Parsed {
  if (!isRecord(e)) {
    return { problems: ['the input must be an object'] }
  }
  const title = textField(e, 'title')
  const steps = textField(e, 'steps')
  const blocker = choiceField(e, 'blocker', BLOCKERS)
  const why = textField(e, 'why')
  const tried = textField(e, 'tried')
  const mode = choiceField(e, 'mode', MODES)
  const check = checkField(e['check'])

  const extra = Object.keys(e).filter(
    key => !FIELDS.has(key) && !ENVELOPE.has(key),
  )
  const problems = [
    ...[title, steps, blocker, why, tried, mode, check].flatMap(field =>
      field.problem === undefined ? [] : [field.problem],
    ),
    ...(extra.length > 0 ? [`unknown fields: ${extra.join(', ')}`] : []),
  ]

  if (
    problems.length > 0 ||
    title.value === undefined ||
    steps.value === undefined ||
    blocker.value === undefined ||
    why.value === undefined ||
    tried.value === undefined ||
    mode.value === undefined
  ) {
    return { problems }
  }
  const request: HtlRequest = {
    title: title.value,
    steps: steps.value,
    blocker: blocker.value,
    why: why.value,
    tried: tried.value,
    mode: mode.value,
  }
  return {
    request:
      check.value === undefined ? request : { ...request, check: check.value },
  }
}

export function sameTitle(a: string, b: string): boolean {
  return normalizeTitle(a) === normalizeTitle(b)
}

function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase()
}

export function validateRequest(
  request: HtlRequest,
  session: SessionTasks,
): string | undefined {
  const refusal = refusalOf(request, session)
  return refusal === undefined ? undefined : `${NOT_ASSIGNED} ${refusal}`
}

function refusalOf(
  request: HtlRequest,
  session: SessionTasks,
): string | undefined {
  if (session.open.length >= MAX_OPEN) {
    return `The user already has ${String(MAX_OPEN)} open tasks. Wait for them.`
  }

  const open = session.open.find(task => sameTitle(task.title, request.title))
  if (open !== undefined) {
    return `Task #${String(open.id)} "${open.title}" is already open. Don't assign it twice; wait for the user.`
  }

  const answered = session.closed.find(
    task => task.decision !== 'accept' && sameTitle(task.title, request.title),
  )
  if (answered !== undefined) {
    return repeatRefusal(answered)
  }

  if (session.secrets !== '1password' || request.blocker !== 'secret') {
    return undefined
  }
  if (!ONE_PASSWORD_EVIDENCE.test(request.tried)) {
    return 'Your secrets are in 1Password. Reference the secret as `op://…` and run the command with `op run` or `op inject`. Assign a task only if the item is missing: check with `op item get "<item>" --vault "<vault>" > /dev/null`, and say in `tried` what you found.'
  }
  if (!OP_REFERENCE.test(request.steps)) {
    return `Your secrets are in 1Password. In \`steps\`, name the exact reference the user should save the new secret under, as \`op://<vault>/<item>/<field>\`, then call ${TOOL} again.`
  }
  return undefined
}

function repeatRefusal(task: ClosedTask): string {
  const label = `task #${String(task.id)} "${task.title}"`
  switch (task.decision) {
    case 'reject':
      return `The user already rejected ${label}. Don't assign it again. Find another way, or tell the user what stays blocked.`
    case 'handback':
      return `The user already said you can do ${label} yourself. Do it with your own tools; don't assign it again.`
    case 'accept':
      return `The user already did ${label}.`
    default:
      return unreachable(task.decision)
  }
}

export function unreachable(value: never): never {
  throw new Error(`htl: unexpected value ${String(value)}`)
}

export function secretsMode(value: unknown): SecretsMode {
  return value === '1password' ? '1password' : 'none'
}

const GENERAL_RULES = `Assign a job to the user that you truly cannot do yourself: a 2FA, browser or CAPTCHA login, a secret that does not exist yet, a physical action, a payment or a legal signature, or a system your tools cannot reach. The user sees it in a pane with Accept, Reject and "You can do this", and can add a message. Their answer arrives later as a user message.

Rules:
- This is a last resort. First try the job yourself, with your own tools.
- Never use it for work your tools can do: edit or create files, run commands, install packages, commit, generate a random secret, or write a placeholder in .env.example.
- For a question or a choice, use AskUserQuestion. If facts are missing, ask in plain text. Neither is a task.
- If the user already said they will do it, don't assign it.
- Never feed a password into sudo or a login prompt, even from a password manager. Assign the command to the user as a no_access task.
- Put related steps in one task, and never assign the same job twice.
- Pick mode "now" when your next step needs the result, else "parallel".`

const ONE_PASSWORD_RULES = `

Secrets live in 1Password:
- Never ask the user for a secret value, and never print one.
- Use a secret through an op://<vault>/<item>/<field> reference: run the command with \`op run --env-file=<file> -- <cmd>\`, or render a config with \`op inject -i <template> -o <file>\`. A resolved file must be gitignored and deleted when you are done.
- Never let a value reach your output: don't run \`op read\`, \`--reveal\` or \`--no-masking\` in your own shell. To check that an item exists, discard the output: \`op item get "<item>" --vault "<vault>" > /dev/null\`.
- A 1Password Touch ID or unlock prompt is not a task: the user answers it. If \`op\` fails because 1Password is locked, not signed in, or its CLI integration is off, that is not a task either: finish the wiring and say so in one line.
- A "secret" task is only for a secret that is missing from 1Password: "tried" says what you checked in 1Password, and the steps name the exact op:// reference to save it under, the one you will use next.`

export function toolDescription(secrets: SecretsMode): string {
  switch (secrets) {
    case '1password':
      return GENERAL_RULES + ONE_PASSWORD_RULES
    case 'none':
      return GENERAL_RULES
    default:
      return unreachable(secrets)
  }
}

const STEPS =
  'Exact Markdown steps for the user. A shell command they should run gets a ! prefix, so they can paste it into Claude Code: `! gh auth login`.'
const STEPS_FOR_SECRETS =
  ' For a secret task, the steps name the exact 1Password reference to save it under: `op://<vault>/<item>/<field>`.'

export function inputSchema(
  secrets: SecretsMode,
): Readonly<Record<string, unknown>> {
  return {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description:
          'The job as a short instruction, e.g. "Log in to the GitHub CLI".',
      },
      steps: {
        type: 'string',
        description:
          secrets === '1password' ? STEPS + STEPS_FOR_SECRETS : STEPS,
      },
      blocker: {
        type: 'string',
        enum: BLOCKERS,
        description:
          'secret: an API key, token or password that does not exist yet. login: a 2FA, browser or CAPTCHA login, or a sign-up. physical: something only hands can do: plug in a device or cable, touch a security key, press a button. payment_or_legal: a payment, a plan change, a signature or an agreement. no_access: a machine, network or app your tools cannot reach: another computer, a VPN, a GUI-only setting, a sudo password prompt.',
      },
      why: {
        type: 'string',
        description: 'Why no tool you have can do it, in 1-2 sentences.',
      },
      tried: {
        type: 'string',
        description: 'What you already tried or checked, and what happened.',
      },
      mode: {
        type: 'string',
        enum: MODES,
        description:
          'now: your next step needs the result, so you stop and wait. parallel: you keep doing only work that does not depend on it.',
      },
      check: {
        type: 'string',
        description:
          'How you will confirm it is done, e.g. `gh auth status`. Optional.',
      },
    },
    required: REQUIRED,
    additionalProperties: false,
  }
}

function quoted(task: { readonly id: number; readonly title: string }): string {
  return `#${String(task.id)} "${task.title}"`
}

export function assignedText(task: HtlTask): string {
  const id = String(task.id)
  switch (task.mode) {
    case 'now':
      return `Assigned as task #${id} (now). End your turn now with one short line saying what you are waiting for. Other tool calls are refused until the user answers; the answer arrives as the next user message.`
    case 'parallel':
      return `Assigned as task #${id} (parallel). Keep working only on what does not depend on it. Don't do it yourself, don't assume it's done. When that work is done, end your turn and say you are waiting for task #${id}.`
    default:
      return unreachable(task.mode)
  }
}

export const SUBAGENT_REFUSAL =
  'Only the main conversation can assign tasks; put the blocker in your final report.'

export function refusalText(problems: readonly string[]): string {
  return `The task was not assigned: ${problems.join('; ')}. Fix these fields and call ${TOOL} again.`
}

export function gateDenial(task: HtlTask): string {
  return `Waiting for the user to finish HTL task ${quoted(task)}. End your turn now.`
}

export function contextLine(tasks: readonly HtlTask[]): string {
  const listed = tasks.map(task => `${quoted(task)} (${task.mode})`).join(', ')
  return `Open HTL tasks waiting for the user: ${listed}. Don't assume they are done.`
}

function taskList(tasks: readonly HtlTask[]): string {
  const ids = tasks.map(task => `#${String(task.id)}`).join(', ')
  return `${tasks.length === 1 ? 'task' : 'tasks'} ${ids}`
}

export function reminderLine(tasks: readonly HtlTask[]): string {
  return `⏳ htl: waiting for you on ${taskList(tasks)} · /htl`
}

export function statusLine(count: number): string {
  return `${String(count)} ${count === 1 ? 'task' : 'tasks'} waiting for you · /htl`
}

export function assignedToast(task: HtlTask): string {
  return `htl: Claude needs you for task ${quoted(task)}`
}

export function decisionToast(task: HtlTask, decision: Decision): string {
  return `htl: task #${String(task.id)} ${decisionPast(decision)}`
}

function decisionPast(decision: Decision): string {
  switch (decision) {
    case 'accept':
      return 'accepted'
    case 'reject':
      return 'rejected'
    case 'handback':
      return 'handed back to Claude'
    default:
      return unreachable(decision)
  }
}

export function decisionLabel(decision: Decision): string {
  switch (decision) {
    case 'accept':
      return 'Accept'
    case 'reject':
      return 'Reject'
    case 'handback':
      return 'You can do this'
    default:
      return unreachable(decision)
  }
}

export function decisionPrompt(
  task: HtlTask,
  decision: Decision,
  message: string,
): string {
  const head = `HTL task ${quoted(task)}`
  const note = message.trim() === '' ? [] : [`My message: ${message.trim()}`]
  switch (decision) {
    case 'accept': {
      const how =
        task.check === undefined
          ? 're-run what failed'
          : `run \`${task.check}\` or re-run what failed`
      return [
        `${head}: accepted, I did it.`,
        ...note,
        `Check it worked (${how}), then continue.`,
      ].join('\n')
    }
    case 'reject':
      return [
        `${head}: rejected, I won't do it.`,
        ...note,
        "Don't assume it's done. Find another way, or tell me what stays blocked.",
      ].join('\n')
    case 'handback':
      return [
        `${head}: you can do this yourself.`,
        ...note,
        "Do it with your own tools. Don't assign it to me again.",
      ].join('\n')
    default:
      return unreachable(decision)
  }
}

export function cardHeader(
  task: HtlTask,
  position: number,
  total: number,
  isFocused: boolean,
): string {
  const parts = [
    `#${String(task.id)}`,
    task.mode.toUpperCase(),
    `${String(position)} of ${String(total)}`,
  ]
  if (!isFocused) {
    parts.push('ctrl+x tab to use')
  }
  return parts.join(' · ')
}

export function blockerLabel(blocker: Blocker): string {
  switch (blocker) {
    case 'secret':
      return 'secret'
    case 'login':
      return 'login'
    case 'physical':
      return 'physical'
    case 'payment_or_legal':
      return 'payment or legal'
    case 'no_access':
      return 'no access'
    default:
      return unreachable(blocker)
  }
}
