// osascript -l JavaScript hands every NSUInteger over as a string ("25"),
// measured on macOS with typeof; convert with Number() before arithmetic.
type JxaInteger = string

interface NSObject {
  isNil(): boolean
}

interface NSRange {
  readonly location: JxaInteger
  readonly length: JxaInteger
}

interface NSString extends NSObject {
  readonly length: JxaInteger
  readonly js: string
}

type NSData = NSObject

interface NSArray<Item> extends NSObject {
  readonly count: JxaInteger
  objectAtIndex(index: number): Item
}

interface NSRangeValue extends NSObject {
  readonly rangeValue: NSRange
}

interface GrammarDetail {
  objectForKey(key: 'NSGrammarRange'): NSRangeValue
  objectForKey(key: 'NSGrammarCorrections'): NSArray<NSString>
}

interface NSTextCheckingResult {
  readonly resultType: JxaInteger
  readonly range: NSRange
  readonly grammarDetails: NSArray<GrammarDetail>
}

interface NSSpellChecker {
  automaticallyIdentifiesLanguages: boolean
  setLanguage(language: string): boolean
  checkStringRangeTypesOptionsInSpellDocumentWithTagOrthographyWordCount(
    text: NSString,
    range: NSRange,
    types: number,
    options: NSObject,
    tag: number,
    orthography: null,
    wordCount: null,
  ): NSArray<NSTextCheckingResult>
  guessesForWordRangeInStringLanguageInSpellDocumentWithTag(
    range: NSRange,
    text: NSString,
    language: NSString,
    tag: number,
  ): NSArray<NSString>
}

interface ObjCBridge {
  (text?: string): NSString
  readonly NSSpellChecker: { readonly sharedSpellChecker: NSSpellChecker }
  readonly NSFileHandle: {
    readonly fileHandleWithStandardInput: {
      readonly readDataToEndOfFile: NSData
    }
  }
  readonly NSString: {
    readonly alloc: {
      initWithDataEncoding(data: NSData, encoding: JxaInteger): NSString
    }
  }
  readonly NSUTF8StringEncoding: JxaInteger
  NSMakeRange(location: number, length: number): NSRange
}

declare const $: ObjCBridge

declare const ObjC: {
  import(framework: string): void
  deepUnwrap(value: NSObject): unknown
}

declare const console: {
  log(...values: unknown[]): void
}
