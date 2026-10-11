ObjC.import('AppKit')

const SPELLING = 2
const GRAMMAR = 4
const MAX_CHOICES = 3

/** @typedef {{ start: number, end: number, kind: 'spelling' | 'grammar', choices: string[] }} Issue */

/** @returns {NSString} */
function readStdin() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile
  return $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)
}

/**
 * @param {string} text
 * @returns {void}
 */
function warn(text) {
  $.NSFileHandle.fileHandleWithStandardError.writeData(
    $(`${text}\n`).dataUsingEncoding($.NSUTF8StringEncoding),
  )
}

/**
 * @param {NSSpellChecker} checker
 * @param {string} language
 * @returns {NSString}
 */
function useLanguage(checker, language) {
  if (language === '') {
    return $()
  }
  checker.automaticallyIdentifiesLanguages = false
  if (checker.setLanguage(language)) {
    return $(language)
  }
  warn(
    `typofix: macOS has no spelling dictionary for "${language}", so it detects the language instead`,
  )
  checker.automaticallyIdentifiesLanguages = true
  return $()
}

/**
 * @param {NSArray<NSString>} list
 * @returns {string[]}
 */
function strings(list) {
  const values = ObjC.deepUnwrap(list)
  return Array.isArray(values)
    ? values.filter(v => typeof v === 'string').slice(0, MAX_CHOICES)
    : []
}

/**
 * @param {NSTextCheckingResult} result
 * @returns {Issue[]}
 */
function grammarIssues(result) {
  const details = result.grammarDetails
  if (details.isNil()) {
    return []
  }
  /** @type {Issue[]} */
  const issues = []
  for (let i = 0; i < Number(details.count); i++) {
    const detail = details.objectAtIndex(i)
    const inner = detail.objectForKey('NSGrammarRange')
    if (inner.isNil()) {
      continue
    }
    const start =
      Number(result.range.location) + Number(inner.rangeValue.location)
    const end = start + Number(inner.rangeValue.length)
    if (end <= start) {
      continue
    }
    issues.push({
      start,
      end,
      kind: 'grammar',
      choices: strings(detail.objectForKey('NSGrammarCorrections')),
    })
  }
  return issues
}

/**
 * @param {readonly string[]} argv
 * @returns {string}
 */
globalThis.run = function (argv) {
  const checker = $.NSSpellChecker.sharedSpellChecker
  const language = useLanguage(checker, argv[0] ?? '')
  const text = readStdin()
  const results =
    checker.checkStringRangeTypesOptionsInSpellDocumentWithTagOrthographyWordCount(
      text,
      $.NSMakeRange(0, Number(text.length)),
      SPELLING | GRAMMAR,
      $(),
      0,
      null,
      null,
    )

  /** @type {Issue[]} */
  const issues = []
  for (let i = 0; i < Number(results.count); i++) {
    const result = results.objectAtIndex(i)
    const type = Number(result.resultType)
    if (type === GRAMMAR) {
      issues.push(...grammarIssues(result))
      continue
    }
    if (type !== SPELLING) {
      continue
    }
    const start = Number(result.range.location)
    const end = start + Number(result.range.length)
    const guesses =
      checker.guessesForWordRangeInStringLanguageInSpellDocumentWithTag(
        result.range,
        text,
        language,
        0,
      )
    issues.push({ start, end, kind: 'spelling', choices: strings(guesses) })
  }
  return JSON.stringify(issues)
}
