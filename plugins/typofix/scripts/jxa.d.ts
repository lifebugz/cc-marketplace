// osascript -l JavaScript hands every NSUInteger over as a string ("25"),
// measured on macOS with typeof; convert with Number() before arithmetic.
type JxaInteger = string

interface NSObject {
  readonly isNil: () => boolean
}

interface NSRange {
  readonly location: JxaInteger
  readonly length: JxaInteger
}

interface NSString extends NSObject {
  readonly length: JxaInteger
  readonly js: string
  readonly dataUsingEncoding: (encoding: JxaInteger) => NSData
}

type NSData = NSObject

interface NSArray<Item> extends NSObject {
  readonly count: JxaInteger
  readonly objectAtIndex: (index: number) => Item
}

interface NSRangeValue extends NSObject {
  readonly rangeValue: NSRange
}

interface GrammarDetail {
  readonly objectForKey: ((key: 'NSGrammarRange') => NSRangeValue) &
    ((key: 'NSGrammarCorrections') => NSArray<NSString>)
}

interface NSTextCheckingResult {
  readonly resultType: JxaInteger
  readonly range: NSRange
  readonly grammarDetails: NSArray<GrammarDetail>
}

interface NSSpellChecker {
  automaticallyIdentifiesLanguages: boolean
  readonly setLanguage: (language: string) => boolean
  readonly checkStringRangeTypesOptionsInSpellDocumentWithTagOrthographyWordCount: (
    text: NSString,
    range: NSRange,
    types: number,
    options: NSObject,
    tag: number,
    orthography: null,
    wordCount: null,
  ) => NSArray<NSTextCheckingResult>
  readonly guessesForWordRangeInStringLanguageInSpellDocumentWithTag: (
    range: NSRange,
    text: NSString,
    language: NSString,
    tag: number,
  ) => NSArray<NSString>
}

interface ObjCBridge {
  (text?: string): NSString
  readonly NSSpellChecker: { readonly sharedSpellChecker: NSSpellChecker }
  readonly NSFileHandle: {
    readonly fileHandleWithStandardInput: {
      readonly readDataToEndOfFile: NSData
    }
    readonly fileHandleWithStandardError: {
      readonly writeData: (data: NSData) => void
    }
  }
  readonly NSString: {
    readonly alloc: {
      readonly initWithDataEncoding: (
        data: NSData,
        encoding: JxaInteger,
      ) => NSString
    }
  }
  readonly NSUTF8StringEncoding: JxaInteger
  readonly NSMakeRange: (location: number, length: number) => NSRange
}

declare const $: ObjCBridge

declare const ObjC: {
  readonly import: (framework: string) => void
  readonly deepUnwrap: (value: NSObject) => unknown
}

/** osascript calls the script's run(argv) and prints what it returns. */
declare function run(argv: readonly string[]): string
