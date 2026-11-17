import { expect, test } from 'claude-code/testing'

test('/chrome-profile answers with its usage line', async $ => {
  const answer = await $.command.run({
    command: 'chrome-profile',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })

  expect(answer.text).toBe(
    'Usage: /chrome-profile [name <label> | machine <name>]',
  )
})
