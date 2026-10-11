import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Decision, HtlTask, SecretsMode, View } from '../types'
import {
  SUBAGENT_REFUSAL,
  TOOL,
  TOOL_NAME,
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

async function disarm($: EngineInterface): Promise<readonly HtlTask[]> {
  const open = await read($, tasks)
  if (!open.some(task => task.isArmed)) {
    return open
  }
  return update($, tasks, list =>
    list.map(task => (task.isArmed ? { ...task, isArmed: false } : task)),
  )
}

async function decide(
  $: EngineInterface,
  taskId: number,
  decision: Decision,
  message: string,
): Promise<void> {
  const open = await read($, tasks)
  const task = open.find(one => one.id === taskId)
  if (task === undefined) {
    return
  }

  const remaining = await update($, tasks, list =>
    list
      .filter(one => one.id !== taskId)
      .map(one => (one.isArmed ? { ...one, isArmed: false } : one)),
  )
  await update($, closed, list =>
    [...list, { id: task.id, title: task.title, decision }].slice(-MAX_CLOSED),
  )
  await update($, view, () => FIRST_CARD)

  $.prompt
    .submit({ text: decisionPrompt(task, decision, message), asUser: true })
    .catch((error: unknown) => {
      logError($, 'the answer was not sent', error)
    })
  $.ui.toast(decisionToast(task, decision))

  if (remaining.length > 0) {
    const panes = await $.ui.panes()
    const isPlaced = panes.some(pane => pane.id === PANE && pane.isPlaced)
    showStatus($, isPlaced, remaining.length)
    return
  }
  $.ui.status(undefined)
  await $.ui.close({ id: PANE })
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
      const panes = await $.ui.panes()
      showStatus(
        $,
        panes.some(pane => pane.id === PANE && pane.isPlaced),
        open.length,
      )
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
    if (e.tool === TOOL || e.agentId !== undefined) {
      return next(e)
    }
    const armed = (await read($, tasks)).find(task => task.isArmed)
    if (armed === undefined) {
      return next(e)
    }
    return { deny: gateDenial(armed) }
  }).catch(async (_$, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const open = await disarm($)
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
        <Text bold>{task.title}</Text>
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
        run($, 'the decision failed', async () =>
          decide($, task.id, decision, value),
        )
      }
      return (
        <Box flexDirection="column" rowGap={1}>
          {card}
          <Text bold>
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
