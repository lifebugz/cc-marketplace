import { describe, expect, test } from 'claude-code/testing'

import {
  applyChoice,
  buildRewriteRequest,
  decorationsFor,
  diffSplice,
  fixLetter,
  focusShortcut,
  hunspellDictionary,
  isDictionaryLanguage,
  isDraft,
  maskCode,
  mergeSpans,
  offeredSpan,
  parseIspell,
  parseMacResult,
  parseRewriteReply,
  shiftSpans,
  toIspellInput,
  tokenAt,
  typeaheadRows,
  type Span,
  type Token,
} from '../hooks/text'

const DRAFT = 'Create a mod that check teh typos'

const span = (
  text: string,
  word: string,
  kind: Span['kind'] = 'spelling',
): Span => {
  const start = text.indexOf(word)
  return {
    id: `${kind}:${String(start)}:${word}`,
    original: word,
    choices: ['the', 'tech', 'tea'],
    kind,
    start,
    end: start + word.length,
  }
}

describe('maskCode', () => {
  test('keeps every offset and blanks code, paths, links and names', () => {
    const text =
      'Fix teh `bun tset` in ./src/a.ts, see https://x.io/teh and ~/notes @alice JSON getUser snake_case v2 e.g. teh.'
    const masked = maskCode(text)

    expect(masked).toHaveLength(text.length)
    expect(masked.startsWith('Fix teh ')).toBe(true)
    expect(masked.endsWith(' teh.')).toBe(true)
    for (const hidden of [
      'tset',
      './src',
      'https',
      '~/notes',
      '@alice',
      'JSON',
      'getUser',
      'snake_case',
      'v2',
      'e.g',
    ]) {
      expect(masked.includes(hidden), hidden).toBe(false)
    }
  })

  test('blanks a fenced block, keeps its line breaks, and blanks an unclosed one to the end', () => {
    const text = 'Use this:\n```\nconst teh = 1\n```\nthen teh'
    const masked = maskCode(text)

    expect(masked.split('\n')).toHaveLength(text.split('\n').length)
    expect(masked.includes('const')).toBe(false)
    expect(masked.endsWith('then teh')).toBe(true)
    expect(maskCode('see ```\nteh')).toBe(
      `see ${' '.repeat(3)}\n${' '.repeat(3)}`,
    )
  })
})

describe('parseMacResult', () => {
  test('reads the script output against the draft, with the language guess', () => {
    const json = JSON.stringify({
      language: 'en',
      confidence: 0.51,
      issues: [
        {
          start: 24,
          end: 27,
          kind: 'spelling',
          choices: ['the', 'tech', 'tea', 'tee'],
        },
      ],
    })

    expect(parseMacResult(json, DRAFT)).toEqual({
      spans: [span(DRAFT, 'teh')],
      guess: { language: 'en', confidence: 0.51 },
    })
  })

  test('drops entries out of range or of an unknown kind, and duplicate or unchanged choices', () => {
    const json = JSON.stringify({
      issues: [
        { start: 30, end: 99, kind: 'spelling', choices: ['x'] },
        { start: 0, end: 6, kind: 'style', choices: ['x'] },
        { start: 2.5, end: 6, kind: 'spelling', choices: ['x'] },
        {
          start: 18,
          end: 23,
          kind: 'grammar',
          choices: ['checks', 'check', 'checks', 7],
        },
      ],
    })

    expect(parseMacResult(json, DRAFT)?.spans).toEqual([
      {
        id: 'grammar:18:check',
        original: 'check',
        choices: ['checks'],
        kind: 'grammar',
        start: 18,
        end: 23,
      },
    ])
  })

  test('keeps no guess when the language or the confidence is missing or malformed', () => {
    for (const guess of [
      {},
      { language: 'de' },
      { confidence: 0.99 },
      { language: '', confidence: 0.99 },
      { language: 'de', confidence: '0.99' },
      { language: 7, confidence: 0.99 },
    ]) {
      const checked = parseMacResult(
        JSON.stringify({ ...guess, issues: [] }),
        DRAFT,
      )
      expect(checked, JSON.stringify(guess)).toEqual({ spans: [] })
    }
  })

  const macSpans = (
    text: string,
    start: number,
    end: number,
    choices: readonly string[],
  ): unknown[] =>
    (
      parseMacResult(
        JSON.stringify({ issues: [{ start, end, kind: 'spelling', choices }] }),
        text,
      )?.spans ?? []
    ).map(s => [s.original, s.start, s.choices])

  test('takes in an apostrophe that belongs to the word, and keeps it on a plural fix', () => {
    expect(
      macSpans("stop talkin' and start", 5, 11, ['talking', 'takin']),
    ).toEqual([["talkin'", 5, ['talking', 'takin']]])
    expect(macSpans('I dont’ see the logs', 2, 6, ["don't", 'done'])).toEqual([
      ['dont’', 2, ["don't", 'done']],
    ])
    expect(
      macSpans('the freinds’ house is big', 4, 11, ['friends', "friend's"]),
    ).toEqual([['freinds’', 4, ['friends’', "friend's"]]])
  })

  test('keeps a word in a quote or a quoted phrase, and drops one after a quote that never closes', () => {
    expect(macSpans("the 'Save and clsoe' label", 14, 19, ['close'])).toEqual([
      ['clsoe', 14, ['close']],
    ])
    expect(macSpans("use the 'Sumbit'ボタン here", 9, 15, ['Submit'])).toEqual([
      ['Sumbit', 9, ['Submit']],
    ])
    expect(macSpans("please press the 'Sumbit", 18, 24, ['Submit'])).toEqual([])
  })

  test('keeps a word in a quote that starts with a symbol, such as a path or a mention', () => {
    expect(
      macSpans("the dialog says '@admin must aprove'", 29, 35, ['approve']),
    ).toEqual([['aprove', 29, ['approve']]])
    expect(
      macSpans("the log says '/tmp/cache is mising'", 28, 34, ['missing']),
    ).toEqual([['mising', 28, ['missing']]])
  })

  test('answers undefined for output with no list of issues', () => {
    expect(parseMacResult('oops', DRAFT)).toBeUndefined()
    expect(parseMacResult('[]', DRAFT)).toBeUndefined()
    expect(parseMacResult('{"language": "en"}', DRAFT)).toBeUndefined()
    expect(parseMacResult('{"issues": {}}', DRAFT)).toBeUndefined()
  })
})

describe('isDictionaryLanguage', () => {
  test('the language option decides when it is set', () => {
    const sure = { language: 'en', confidence: 0.99 }
    expect(isDictionaryLanguage('en_US', 'de', sure)).toBe(false)
    expect(isDictionaryLanguage('en_US', 'en', undefined)).toBe(true)
    expect(isDictionaryLanguage('en_US', 'en_GB', undefined)).toBe(true)
  })

  test('without the option, only a sure guess in another language skips the dictionary', () => {
    expect(
      isDictionaryLanguage('en_US', '', { language: 'de', confidence: 0.99 }),
    ).toBe(false)
    expect(
      isDictionaryLanguage('en_US', '', { language: 'en', confidence: 0.99 }),
    ).toBe(true)
    expect(
      isDictionaryLanguage('en_US', '', { language: 'id', confidence: 0.51 }),
    ).toBe(true)
    expect(
      isDictionaryLanguage('en_US', '', { language: 'de', confidence: 0.9 }),
    ).toBe(false)
  })

  test('an unknown language keeps the dictionary', () => {
    expect(isDictionaryLanguage('en_US', '', undefined)).toBe(true)
  })

  test('compares base codes, so en_GB, en-GB and en match', () => {
    expect(
      isDictionaryLanguage('en_GB', '', { language: 'en', confidence: 0.99 }),
    ).toBe(true)
    expect(isDictionaryLanguage('en-GB', 'EN_us', undefined)).toBe(true)
    expect(
      isDictionaryLanguage('de_DE', '', { language: 'en', confidence: 0.99 }),
    ).toBe(false)
  })
})

describe('ispell fallback', () => {
  const text = 'café über teh\n\nsecond line wiht a typo'
  const hunspell = [
    '@(#) International Ispell Version 3.2.06 (but really Hunspell 1.7.5)',
    '& café 2 1: cafe, caff',
    '& über 1 7: beer',
    '& teh 10 13: the, eh, tech, tee, tea, ten, tel, ted, meh, t eh',
    '',
    '',
    '*',
    '*',
    '& wiht 6 13: whit, with, wit, wight, wist, wilt',
    '*',
    '*',
    '',
    '',
  ].join('\n')

  test('prefixes every line so no line reads as a command', () => {
    expect(toIspellInput('a\n*b')).toBe('^a\n^*b\n')
  })

  test('turns byte offsets that count the ^ prefix into string indexes', () => {
    const spans = parseIspell(hunspell, text)

    expect(spans.map(s => [s.original, s.start])).toEqual([
      ['café', text.indexOf('café')],
      ['über', text.indexOf('über')],
      ['teh', text.indexOf('teh')],
      ['wiht', text.indexOf('wiht')],
    ])
    expect(spans[2]?.choices).toEqual(['the', 'eh', 'tech'])
  })

  test('finds the word near a character offset too', () => {
    const spans = parseIspell(
      '@(#) enchant\n& teh 1 11: the\n# zzq 15\n',
      'café über teh zzq',
    )

    expect(spans.map(s => [s.original, s.start, s.choices])).toEqual([
      ['teh', 10, ['the']],
      ['zzq', 14, []],
    ])
  })

  const read = (output: string, line: string): unknown[] =>
    parseIspell(`@(#) Hunspell\n${output}\n\n`, line).map(s => [
      s.original,
      s.start,
      s.choices,
    ])
  const fixFirst = (output: string, line: string): string | undefined => {
    const [found] = parseIspell(`@(#) Hunspell\n${output}\n\n`, line)
    const choice = found?.choices[0]
    return found === undefined || choice === undefined
      ? undefined
      : applyChoice(line, found, choice)?.text
  }

  test('finds a word in quotes, and trims a quote hunspell keeps on the word', () => {
    expect(
      read(
        '& Sumbit 4 18: Submit, Summit',
        "the button says 'Sumbit' and the form",
      ),
    ).toEqual([['Sumbit', 17, ['Submit', 'Summit']]])
    expect(
      read('& Sumbit’ 1 20: Summit', 'the button says ‘Sumbit’ and the form'),
    ).toEqual([['Sumbit', 17, ['Summit']]])
    expect(read("& ’Sumbit’ 1 5: habit's", 'the ’Sumbit’ button')).toEqual([
      ['Sumbit', 5, ["habit's"]],
    ])
    expect(
      read("& Sumbit's 4 9: Summit's, Suit's", "look at Sumbit's label"),
    ).toEqual([["Sumbit's", 8, ["Summit's", "Suit's"]]])
  })

  test('drops a word whose only fault is the quote hunspell keeps on it', () => {
    expect(
      read('& Cancel’ 2 8: Cancel, Cancels', 'the ‘Cancel’ button'),
    ).toEqual([])
    expect(
      read("& users’ 3 12: user's, users, user", 'it’s the users’ files'),
    ).toEqual([])
    expect(
      read("& don’t’ 2 12: don't, doesn't", 'he said ‘don’t’ there'),
    ).toEqual([])
  })

  test('keeps an apostrophe that belongs to the word, so a fix leaves none behind', () => {
    expect(fixFirst('& goin’ 1 7: going', 'I was goin’ home')).toBe(
      'I was going home',
    )
    expect(fixFirst("& freinds’ 1 5: friend's", 'the freinds’ house')).toBe(
      "the friend's house",
    )
    expect(
      fixFirst("& ’tis 4 5: it's, ti's, Otis, isn't", 'get ’tis done'),
    ).toBe("get it's done")
  })

  test('reads a typo at the end of a quoted phrase, and keeps the quote', () => {
    expect(read('& clsoe 1 15: close', "the 'Save and clsoe' label")).toEqual([
      ['clsoe', 14, ['close']],
    ])
    expect(read('& clsoe’ 1 17: close', 'the ‘Save and clsoe’ label')).toEqual([
      ['clsoe', 14, ['close']],
    ])
  })

  test('skips a one-letter word, and a word hunspell glued to another script', () => {
    expect(read("& ’n’ 1 6: don't", 'rock ’n’ roll is fun')).toEqual([])
    expect(
      read("& Submit'ボタン 1 10: Submitting", "use the 'Submit'ボタン here"),
    ).toEqual([])
    expect(
      read('& button日本 1 5: button', 'the button日本 is broken'),
    ).toEqual([])
  })

  test('skips a word hunspell read without an apostrophe that belongs to it', () => {
    expect(
      read('& goin 11 1: goon, gin, groin, going', "goin' home now"),
    ).toEqual([])
    expect(read('& tis 1 2: tees', "'tis the season")).toEqual([])
  })
})

describe('shiftSpans', () => {
  const teh = span(DRAFT, 'teh')

  test('moves a span when text goes in before it', () => {
    const text = `Please ${DRAFT}`
    const [moved] = shiftSpans(
      [teh],
      { start: 0, end: 0, inputText: 'Please ' },
      text,
    )

    expect(moved?.start).toBe(text.indexOf('teh'))
  })

  test('keeps a span when a space follows it, and drops it when a letter does', () => {
    const at = teh.end
    expect(
      shiftSpans(
        [teh],
        { start: at, end: at, inputText: ' ' },
        `${DRAFT.slice(0, at)}  ${DRAFT.slice(at + 1)}`,
      ),
    ).toHaveLength(1)
    expect(
      shiftSpans(
        [teh],
        { start: at, end: at, inputText: 'n' },
        `${DRAFT.slice(0, at)}n${DRAFT.slice(at)}`,
      ),
    ).toHaveLength(0)
  })

  test('drops a span the edit touches, or that a deletion joins to the next word', () => {
    expect(
      shiftSpans(
        [teh],
        { start: teh.start + 1, end: teh.start + 2, inputText: '' },
        'x',
      ),
    ).toHaveLength(0)
    const joined = DRAFT.slice(0, teh.end) + DRAFT.slice(teh.end + 1)
    expect(
      shiftSpans(
        [teh],
        { start: teh.end, end: teh.end + 1, inputText: '' },
        joined,
      ),
    ).toHaveLength(0)
  })

  const kept = (text: string, word: string): number =>
    shiftSpans(
      [span(text, word)],
      { start: text.length, end: text.length, inputText: ' ok' },
      `${text} ok`,
    ).length

  test('keeps a word in quotes, or between Chinese or Japanese letters', () => {
    expect(kept("the button says 'Sumbit' and the form", 'Sumbit')).toBe(1)
    expect(kept('the button says ‘Sumbit’ and the form', 'Sumbit')).toBe(1)
    expect(kept('我想recieve这个文件 and more', 'recieve')).toBe(1)
    expect(kept('この関数はrecieveを呼ぶ and more', 'recieve')).toBe(1)
    const accented = `recieve${String.fromCodePoint(0x301)}`
    expect(kept(`我想${accented}这个文件 and more`, accented)).toBe(1)
  })

  test('keeps a quoted word when the closing quote touches Japanese letters, and drops a word an unclosed quote starts', () => {
    expect(kept("use the 'Sumbit'ボタン here", 'Sumbit')).toBe(1)
    expect(kept("please press the 'Sumbit", 'Sumbit')).toBe(0)
  })

  test('drops a part of a word that a digit or an underscore joins to', () => {
    expect(kept('call recieve2 now', 'recieve')).toBe(0)
    expect(kept('my_recieve here', 'recieve')).toBe(0)
  })

  test('drops a part of a word that an apostrophe joins to more letters', () => {
    expect(kept("look at Sumbit's label", 'Sumbit')).toBe(0)
    expect(kept("je pense que l'adrresse est", 'adrresse')).toBe(0)
    expect(kept('je pense que l’adrresse est', 'adrresse')).toBe(0)
  })
})

describe('diffSplice', () => {
  test('finds the one changed run between two drafts', () => {
    expect(diffSplice('fix teh typo', 'fix tech typo')).toEqual({
      start: 6,
      end: 6,
      inputText: 'c',
    })
    expect(diffSplice('', 'new draft')).toEqual({
      start: 0,
      end: 0,
      inputText: 'new draft',
    })
    expect(diffSplice('aaa', 'aa')).toEqual({ start: 2, end: 3, inputText: '' })
  })

  test('feeds shiftSpans so a fix taken from the typeahead drops its span only', () => {
    const text = 'fix teh bug wiht tests'
    const before = [span(text, 'teh'), span(text, 'wiht')]
    const after = 'fix the bug wiht tests'
    const kept = shiftSpans(before, diffSplice(text, after), after)

    expect(kept.map(s => [s.original, s.start])).toEqual([
      ['wiht', after.indexOf('wiht')],
    ])
  })
})

describe('typeaheadRows', () => {
  const text = 'fix teh, then go'
  const teh = span(text, 'teh')
  const token = (word: string, start: number): Token => ({
    token: word,
    start,
    cursor: start + word.length,
  })

  test('offers the fixes for the word that ends at the cursor', () => {
    expect(typeaheadRows([teh], token('teh', 4))).toEqual([
      { text: 'the', label: 'the', description: 'fixes teh' },
      { text: 'tech', label: 'tech', description: 'fixes teh' },
      { text: 'tea', label: 'tea', description: 'fixes teh' },
    ])
  })

  test('keeps punctuation the token holds around the word', () => {
    expect(typeaheadRows([teh], token('teh,', 4)).map(r => r.text)).toEqual([
      'the,',
      'tech,',
      'tea,',
    ])
  })

  test('offers nothing for a word with no known mistake or one the cursor is not after', () => {
    expect(typeaheadRows([teh], token('then', 9))).toEqual([])
    expect(typeaheadRows([teh], { token: 'te', start: 4, cursor: 6 })).toEqual(
      [],
    )
  })

  test('offers the fixes after a closing quote, and none after more letters', () => {
    const quoted = "says 'Sumbit' now"
    const sumbit = span(quoted, 'Sumbit')
    expect(
      typeaheadRows([sumbit], token("'Sumbit'", 5)).map(r => r.text),
    ).toEqual(["'the'", "'tech'", "'tea'"])
    expect(
      typeaheadRows([sumbit], token('‘Sumbit’', 5)).map(r => r.text),
    ).toEqual(['‘the’', '‘tech’', '‘tea’'])
    expect(typeaheadRows([sumbit], token("'Sumbit's", 5))).toEqual([])
  })

  test('replaces an apostrophe that belongs to the word', () => {
    const talkin = span("stop talkin' now", "talkin'")
    expect(
      typeaheadRows([talkin], token("talkin'", 5)).map(r => r.text),
    ).toEqual(['the', 'tech', 'tea'])
  })
})

describe('tokenAt', () => {
  test('is the run of non-space text that ends at the cursor', () => {
    expect(tokenAt('fix teh, now', 8)).toEqual({
      token: 'teh,',
      start: 4,
      cursor: 8,
    })
    expect(tokenAt('fix teh ', 8)).toEqual({ token: '', start: 8, cursor: 8 })
    expect(tokenAt('teh', 3)).toEqual({ token: 'teh', start: 0, cursor: 3 })
  })

  test('stays fast with a long run of text with no spaces before the cursor', () => {
    const run = 'x'.repeat(100_000)
    const text = `${run} fix teh`
    const startedAt = Date.now()
    const after = tokenAt(text, text.length)
    const inside = tokenAt(run, run.length)
    const elapsedMs = Date.now() - startedAt

    expect(after).toEqual({
      token: 'teh',
      start: text.length - 3,
      cursor: text.length,
    })
    expect(inside).toEqual({ token: run, start: 0, cursor: run.length })
    expect(elapsedMs).toBeLessThan(50)
  })
})

describe('hunspellDictionary', () => {
  test('takes a plain dictionary name from the option', () => {
    expect(hunspellDictionary('en_US')).toBe('en_US')
    expect(hunspellDictionary(' en_GB ')).toBe('en_GB')
  })

  test('is off for an empty option, a path, or a value that is not a string', () => {
    expect(hunspellDictionary('')).toBeUndefined()
    expect(hunspellDictionary('../../etc/passwd')).toBeUndefined()
    expect(hunspellDictionary(true)).toBeUndefined()
    expect(hunspellDictionary(undefined)).toBeUndefined()
  })
})

describe('mergeSpans', () => {
  const text = 'whaat do youu say λάθοςς'

  test('adds Latin words the first checker missed, sorted by position', () => {
    const merged = mergeSpans(
      [span(text, 'youu')],
      [span(text, 'whaat'), span(text, 'youu')],
    )
    expect(merged.map(s => s.original)).toEqual(['whaat', 'youu'])
  })

  test('never adds a word in another script', () => {
    expect(mergeSpans([], [span(text, 'λάθοςς')])).toEqual([])
  })
})

describe('focusShortcut', () => {
  const file = (context: string, key: string, action: string): string =>
    JSON.stringify({ bindings: [{ context, bindings: { [key]: action } }] })

  test('finds the key bound to the band focus action', () => {
    expect(focusShortcut(file('Chat', 'ctrl+space', 'abovePrompt:focus'))).toBe(
      'ctrl+space',
    )
    expect(focusShortcut(file('Global', 'alt+k', 'abovePrompt:focus'))).toBe(
      'alt+k',
    )
  })

  test('falls back to ctrl+x tab', () => {
    expect(focusShortcut(undefined)).toBe('ctrl+x tab')
    expect(focusShortcut('not json')).toBe('ctrl+x tab')
    expect(focusShortcut(file('Chat', 'ctrl+t', 'app:toggleTodos'))).toBe(
      'ctrl+x tab',
    )
    expect(focusShortcut(file('Pane', 'ctrl+space', 'abovePrompt:focus'))).toBe(
      'ctrl+x tab',
    )
  })
})

test('fix letters are 22 distinct letters that never use i, r, s or x', () => {
  const letters = Array.from({ length: 30 }, (_, i) => fixLetter(i))
  const used = letters.filter(letter => letter !== undefined)

  expect(used).toHaveLength(22)
  expect(new Set(used).size).toBe(22)
  for (const reserved of ['i', 'r', 's', 'x']) {
    expect(used).not.toContain(reserved)
  }
})

describe('applyChoice', () => {
  test('replaces the word where it stands', () => {
    const applied = applyChoice(DRAFT, span(DRAFT, 'teh'), 'the')

    expect(applied?.text).toBe('Create a mod that check the typos')
    expect(applied?.splice).toEqual({ start: 24, end: 27, inputText: 'the' })
  })

  test('finds a word that moved, and gives up when it is gone', () => {
    const moved = `Now: ${DRAFT}`
    expect(applyChoice(moved, span(DRAFT, 'teh'), 'tea')?.text).toBe(
      'Now: Create a mod that check tea typos',
    )
    expect(
      applyChoice('Create a mod', span(DRAFT, 'teh'), 'the'),
    ).toBeUndefined()
  })

  test('keeps the quotes or the letters around the word it fixes', () => {
    const fix = (text: string, word: string, choice: string): unknown =>
      applyChoice(text, span(text, word), choice)?.text

    expect(fix("says 'Sumbit' now", 'Sumbit', 'Submit')).toBe(
      "says 'Submit' now",
    )
    expect(fix('says ‘Sumbit’ now', 'Sumbit', 'Submit')).toBe(
      'says ‘Submit’ now',
    )
    expect(fix('我想recieve这个文件', 'recieve', 'receive')).toBe(
      '我想receive这个文件',
    )
  })
})

describe('rewrites', () => {
  test('sends the draft inside tags', () => {
    expect(buildRewriteRequest('He go').prompt).toBe('<draft>\nHe go\n</draft>')
  })

  test('reads three rewrites, also from a fenced reply', () => {
    const reply =
      '```json\n{"rewrites": [" He goes. ", "He is going.", "He goes."]}\n```'
    expect(parseRewriteReply(reply)).toEqual([
      'He goes.',
      'He is going.',
      'He goes.',
    ])
  })

  test('refuses a reply with the wrong count, an empty rewrite, or no JSON', () => {
    expect(parseRewriteReply('{"rewrites": ["a", "b"]}')).toBeUndefined()
    expect(parseRewriteReply('{"rewrites": ["a", " ", "c"]}')).toBeUndefined()
    expect(parseRewriteReply('Sure! Here you go.')).toBeUndefined()
  })
})

test('decorations underline spelling in the error color and grammar in the warning color', () => {
  expect(
    decorationsFor([span(DRAFT, 'teh'), span(DRAFT, 'check', 'grammar')]),
  ).toEqual([
    { start: 24, end: 27, underline: true, color: 'error' },
    { start: 18, end: 23, underline: true, color: 'warning' },
  ])
})

test('the word whose fixes are offered is also bold', () => {
  const teh = span(DRAFT, 'teh')
  expect(decorationsFor([span(DRAFT, 'check', 'grammar'), teh], teh)).toEqual([
    { start: 18, end: 23, underline: true, color: 'warning' },
    { start: 24, end: 27, underline: true, color: 'error', bold: true },
  ])
})

test('the offered word is the one that ends at the cursor and has fixes', () => {
  const text = 'fix teh wiht'
  const teh = span(text, 'teh')
  const wiht = { ...span(text, 'wiht'), choices: [] }

  expect(offeredSpan([teh, wiht], tokenAt(text, 7))).toBe(teh)
  expect(offeredSpan([teh, wiht], tokenAt(text, 12))).toBeUndefined()
  expect(offeredSpan([teh, wiht], tokenAt(text, 3))).toBeUndefined()
})

test('a draft is three words or more and not a slash command', () => {
  expect(isDraft('He go store')).toBe(true)
  expect(isDraft('He go')).toBe(false)
  expect(isDraft('/rephrase He go store')).toBe(false)
})
