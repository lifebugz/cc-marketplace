import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Decision, HtlTask, SecretsMode, View } from '../types'
import {
  SUBAGENT_REFUSAL,
  TOOL,
  TOOL_NAME,
  answersTasks,
  assignedText,
  assignedToast,
  blockerLabel,
  cardHeader,
  contextLine,
  decisionLabel,
  decisionPrompt,
  decisionToast,
  gateDenial,
  inputSchema,
  notSentToast,
  parseRequest,
  refusalText,
  reminderLine,
  secretsMode,
  statusLine,
  toolDescription,
  validateRequest,
} from './tasks'

const PANE = 'htl'
const PANE_TITLE = 'HTL tasks'
const MAX_CLOSED = 100
const FIRST_CARD: View = { step: 'decide', taskId: null }

const tasks = atom({ plugin: 'htl', key: 'tasks' } as const, [])
const closed = atom({ plugin: 'htl', key: 'closed' } as const, [])
const nextId = atom({ plugin: 'htl', key: 'nextId' } as const, 1)
const view = atom({ plugin: 'htl', key: 'view' } as const, FIRST_CARD)

let queue: Promise<unknown> = Promise.resolve()
let gateLifts = 0

interface Committed {
  readonly task: HtlTask
  readonly armed: readonly number[]
  readonly lifts: number
}

async function serial<T>(work: () => Promise<T>): Promise<T> {
  const job = queue.then(work, work)
  queue = job.catch(() => undefined)
  return job
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function logError($: EngineInterface, what: string, error: unknown): void {
  $.ui.log(`htl: ${what}: ${messageOf(error)}`, { to: 'debug' })
}

async function isPanePlaced($: EngineInterface): Promise<boolean> {
  const panes = await $.ui.panes()
  return panes.some(pane => pane.id === PANE && pane.isPlaced)
}

function showStatus(
  $: EngineInterface,
  isPlaced: boolean,
  count: number,
): void {
  $.ui.status(isPlaced || count === 0 ? undefined : statusLine(count))
}

async function notify($: EngineInterface, task: HtlTask): Promise<void> {
  let isPlaced = false
  try {
    const opened = await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true })
    isPlaced = opened.isPlaced
  } catch (error) {
    logError($, 'the pane did not open', error)
  }
  try {
    $.ui.toast(assignedToast(task))
    showStatus($, isPlaced, (await read($, tasks)).length)
  } catch (error) {
    logError($, 'the notice failed', error)
  }
}

async function assign(
  $: EngineInterface,
  e: unknown,
  secrets: SecretsMode,
): Promise<string> {
  const parsed = parseRequest(e)
  if (parsed.problems !== undefined) {
    return refusalText(parsed.problems)
  }

  const refusal = validateRequest(parsed.request, {
    open: await read($, tasks),
    closed: await read($, closed),
    secrets,
  })
  if (refusal !== undefined) {
    return refusal
  }

  const id = (await update($, nextId, n => n + 1)) - 1
  const task: HtlTask = {
    ...parsed.request,
    id,
    isArmed: parsed.request.mode === 'now',
  }
  await update($, tasks, list => [...list, task])
  await notify($, task)
  return assignedText(task)
}

function lifted(task: HtlTask): HtlTask {
  return task.isArmed ? { ...task, isArmed: false } : task
}

// Writes even when nothing is armed: a rollback's re-arm racing this prompt
// then misses its version and re-reads gateLifts, instead of landing after it.
async function disarm($: EngineInterface): Promise<readonly HtlTask[]> {
  gateLifts += 1
  return update($, tasks, list => list.map(lifted))
}

async function commit(
  $: EngineInterface,
  taskId: number,
  decision: Decision,
): Promise<Committed | undefined> {
  const task = (await read($, tasks)).find(one => one.id === taskId)
  if (task === undefined) {
    return undefined
  }

  gateLifts += 1
  const lifts = gateLifts
  let armed: readonly number[] = []
  const remaining = await update($, tasks, list => {
    armed = list.filter(one => one.isArmed).map(one => one.id)
    return list.filter(one => one.id !== taskId).map(lifted)
  })
  await update($, closed, list =>
    [...list, { id: task.id, title: task.title, decision }].slice(-MAX_CLOSED),
  )
  await update($, view, () => FIRST_CARD)

  if (remaining.length > 0) {
    showStatus($, await isPanePlaced($), remaining.length)
  } else {
    $.ui.status(undefined)
    await $.ui.close({ id: PANE })
  }
  return { task, armed, lifts }
}

async function deliver(
  $: EngineInterface,
  text: string,
): Promise<string | undefined> {
  try {
    const entered = await $.prompt.submit({ text, asUser: true })
    return entered.drop
  } catch (error) {
    return messageOf(error)
  }
}

async function rollback(
  $: EngineInterface,
  { task, armed, lifts }: Committed,
): Promise<void> {
  const open = await update($, tasks, list => {
    const back = list.some(one => one.id === task.id)
      ? list
      : [
          ...list.filter(one => one.id < task.id),
          { ...task, isArmed: false },
          ...list.filter(one => one.id > task.id),
        ]
    if (gateLifts !== lifts) {
      return back
    }
    return back.map(one =>
      armed.includes(one.id) ? { ...one, isArmed: true } : one,
    )
  })
  await update($, closed, list => list.filter(one => one.id !== task.id))
  await update($, view, (current): View =>
    current.step === 'decide' && current.taskId === null
      ? { step: 'decide', taskId: task.id }
      : current,
  )
  showStatus($, await isPanePlaced($), open.length)
  $.ui.toast(notSentToast(task))
}

// Not one serial job: $.prompt.submit resolves only once the answer's turn
// starts, and an assign_task hook waiting on the queue meanwhile would spend
// its own 10 s budget.
async function decide(
  $: EngineInterface,
  taskId: number,
  decision: Decision,
  message: string,
): Promise<void> {
  const committed = await serial(async () => commit($, taskId, decision))
  if (committed === undefined) {
    return
  }
  const { task } = committed
  const failure = await deliver($, decisionPrompt(task, decision, message))
  if (failure === undefined) {
    $.ui.toast(decisionToast(task, decision))
    return
  }
  logError($, `the answer to task #${String(task.id)} was not sent`, failure)
  await serial(async () => rollback($, committed))
}

async function pickDecision(
  $: EngineInterface,
  taskId: number,
  decision: Decision,
): Promise<unknown> {
  return update($, view, (): View => ({ step: 'message', taskId, decision }))
}

async function showNext(
  $: EngineInterface,
  open: readonly HtlTask[],
  taskId: number,
): Promise<unknown> {
  const at = open.findIndex(task => task.id === taskId)
  const following = open[(at + 1) % open.length] ?? open[0]
  return update($, view, (): View => ({
    step: 'decide',
    taskId: following?.id ?? null,
  }))
}

async function backToCard(
  $: EngineInterface,
  taskId: number,
): Promise<unknown> {
  return update($, view, (): View => ({ step: 'decide', taskId }))
}

function run(
  $: EngineInterface,
  what: string,
  work: () => Promise<unknown>,
): void {
  serial(work).catch((error: unknown) => {
    logError($, what, error)
  })
}

export const register: Register = (on, options) => {
  const secrets = secretsMode(options['secrets'])

  on('session.start', async ($, e, next) => {
    const isEval = (await $.env.get('EVAL_HTL')) === '1'
    if (e.isInteractive || isEval) {
      try {
        await $.tool.register({
          name: TOOL_NAME,
          description: toolDescription(secrets),
          inputSchema: inputSchema(secrets),
          isDeferred: false,
        })
      } catch (error) {
        logError($, 'the tool was not registered', error)
      }
    }

    const open = await read($, tasks)
    if (open.length > 0) {
      showStatus($, await isPanePlaced($), open.length)
    }

    try {
      await $.command.register({
        name: 'htl',
        description: 'Show the tasks Claude assigned to you',
        immediate: true,
      })
    } catch (error) {
      logError($, '/htl was not registered', error)
    }
    return next(e)
  })

  on('tool.call', { tool: 'mcp__htl__assign_task' }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { result: SUBAGENT_REFUSAL }
    }
    return { result: await serial(async () => assign($, e, secrets)) }
  }).catch((_$, _e, next) => ({
    result: `htl failed: ${next.error.message ?? next.error.kind}`,
  }))

  on('tool.call', async ($, e, next) => {
    if (
      e.tool === TOOL ||
      e.agentId !== undefined ||
      next.origin.plugin !== 'engine'
    ) {
      return next(e)
    }
    const armed = (await read($, tasks)).find(task => task.isArmed)
    if (armed === undefined) {
      return next(e)
    }
    return { deny: gateDenial(armed) }
  }).catch(async (_$, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const open = answersTasks(e.origin.kind)
      ? await disarm($)
      : await read($, tasks)
    if (open.length === 0) {
      return next(e)
    }
    return next({ ...e, context: [...(e.context ?? []), contextLine(open)] })
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) {
      return result
    }
    const open = await read($, tasks)
    return open.length === 0 ? result : { ...result, text: reminderLine(open) }
  })

  on('command.run', { command: 'htl' }, async $ => {
    const open = await read($, tasks)
    if (open.length === 0) {
      return { text: 'No open HTL tasks.' }
    }
    try {
      const opened = await $.ui.open({
        id: PANE,
        title: PANE_TITLE,
        focus: true,
        closeOnEscape: true,
      })
      showStatus($, opened.isPlaced, open.length)
    } catch (error) {
      return { text: `htl: the pane did not open: ${messageOf(error)}` }
    }
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [open, current] = await Promise.all([read($, tasks), read($, view)])
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const { surface } = e
    const Input =
      surface === 'mobile'
        ? undefined
        : $.ui.resolve({ surface, component: e.component }).Input

    const at = Math.max(
      0,
      open.findIndex(task => task.id === current.taskId),
    )
    const task = open[at]
    if (task === undefined) {
      return <Text dimColor>No open HTL tasks.</Text>
    }

    const card = (
      <Box flexDirection="column">
        <Text dimColor>
          {cardHeader(task, at + 1, open.length, e.props.isFocused)}
        </Text>
        <Text weight="semibold">{task.title}</Text>
        <Text>
          <Text color="warning">{blockerLabel(task.blocker)}:</Text> {task.why}
        </Text>
        <Text dimColor>Claude tried: {task.tried}</Text>
        <Markdown text={task.steps} />
        {task.check !== undefined && (
          <Text dimColor>Claude will check: {task.check}</Text>
        )}
      </Box>
    )

    if (current.step === 'message' && current.taskId === task.id) {
      const { decision } = current
      const send = (value: string): void => {
        decide($, task.id, decision, value).catch((error: unknown) => {
          logError($, 'the decision failed', error)
        })
      }
      return (
        <Box flexDirection="column" rowGap={1}>
          {card}
          <Text weight="semibold">
            {decisionLabel(decision)} #{String(task.id)}. Message to Claude
            (optional)
          </Text>
          {Input === undefined ? (
            <Button
              key="send"
              plain
              onPress={() => {
                send('')
              }}
            >
              Send without a message
            </Button>
          ) : (
            <Input
              key="message"
              autoFocus
              placeholder="Enter sends; leave it empty for no message"
              submitLabel="send"
              onSubmit={send}
            />
          )}
          <Button
            key="back"
            plain
            dimColor
            onPress={() => {
              run($, 'back failed', async () => backToCard($, task.id))
            }}
          >
            Back
          </Button>
        </Box>
      )
    }

    const choose = (decision: Decision) => (): void => {
      run($, 'the choice failed', async () =>
        pickDecision($, task.id, decision),
      )
    }
    return (
      <Box flexDirection="column" rowGap={1}>
        {card}
        <Box columnGap={2} flexWrap="wrap">
          <Button key="accept" hotkey="a" plain onPress={choose('accept')}>
            Accept
          </Button>
          <Button key="reject" hotkey="r" plain onPress={choose('reject')}>
            Reject
          </Button>
          <Button key="handback" hotkey="y" plain onPress={choose('handback')}>
            You can do this
          </Button>
          {open.length > 1 && (
            <Button
              key="next"
              hotkey="n"
              plain
              onPress={() => {
                run($, 'next failed', async () => showNext($, open, task.id))
              }}
            >
              Next
            </Button>
          )}
        </Box>
      </Box>
    )
  })
}
