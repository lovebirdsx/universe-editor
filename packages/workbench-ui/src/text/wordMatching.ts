/*---------------------------------------------------------------------------------------------
 *  Word-matching primitives ported from VSCode's src/vs/base/common/filters.ts
 *  (MIT, Microsoft). Omitted on purpose: diacritic normalization
 *  (tryNormalizeToBase) and Korean dubeolsik alt-char matching — the rest of
 *  the algorithm is kept semantically identical.
 *--------------------------------------------------------------------------------------------*/

export interface IMatch {
  start: number
  end: number
}

export interface IFilter {
  (word: string, wordToMatchAgainst: string): IMatch[] | null
}

/** First filter that matches wins. */
export function orMatch(...filters: readonly IFilter[]): IFilter {
  return (word, wordToMatchAgainst) => {
    for (const filter of filters) {
      const match = filter(word, wordToMatchAgainst)
      if (match) return match
    }
    return null
  }
}

export function matchesContiguousSubString(
  word: string,
  wordToMatchAgainst: string,
): IMatch[] | null {
  if (word.length > wordToMatchAgainst.length) return null

  const index = wordToMatchAgainst.toLowerCase().indexOf(word.toLowerCase())
  if (index === -1) return null

  return [{ start: index, end: index + word.length }]
}

const enum CharCode {
  Space = 32,
  Tab = 9,
  LineFeed = 10,
  CarriageReturn = 13,
  Digit0 = 48,
  Digit9 = 57,
  UpperA = 65,
  UpperZ = 90,
  LowerA = 97,
  LowerZ = 122,
}

function isLower(code: number): boolean {
  return CharCode.LowerA <= code && code <= CharCode.LowerZ
}

function isUpper(code: number): boolean {
  return CharCode.UpperA <= code && code <= CharCode.UpperZ
}

function isNumber(code: number): boolean {
  return CharCode.Digit0 <= code && code <= CharCode.Digit9
}

function isWhitespace(code: number): boolean {
  return (
    code === CharCode.Space ||
    code === CharCode.Tab ||
    code === CharCode.LineFeed ||
    code === CharCode.CarriageReturn
  )
}

// Natural word separators in written text; subset of monaco's word separators.
const wordSeparators = new Set<number>()
for (const s of '()[]{}<>`\'"-/;:,.?!') {
  wordSeparators.add(s.charCodeAt(0))
}

function isWordSeparator(code: number): boolean {
  return isWhitespace(code) || wordSeparators.has(code)
}

function charactersMatch(codeA: number, codeB: number): boolean {
  return codeA === codeB || (isWordSeparator(codeA) && isWordSeparator(codeB))
}

function isAlphanumeric(code: number): boolean {
  return isLower(code) || isUpper(code) || isNumber(code)
}

function join(head: IMatch, tail: IMatch[]): IMatch[] {
  const first = tail[0]
  if (!first) {
    return [head]
  } else if (head.end === first.start) {
    first.start = head.start
  } else {
    tail.unshift(head)
  }
  return tail
}

// A camelCase anchor: uppercase letter, digit, or any character after a non-alphanumeric one.
function nextAnchor(camelCaseWord: string, start: number): number {
  for (let i = start; i < camelCaseWord.length; i++) {
    const c = camelCaseWord.charCodeAt(i)
    if (isUpper(c) || isNumber(c) || (i > 0 && !isAlphanumeric(camelCaseWord.charCodeAt(i - 1)))) {
      return i
    }
  }
  return camelCaseWord.length
}

function _matchesCamelCase(
  word: string,
  camelCaseWord: string,
  i: number,
  j: number,
): IMatch[] | null {
  if (i === word.length) {
    return []
  } else if (j === camelCaseWord.length) {
    return null
  } else if (word[i] !== camelCaseWord[j]?.toLowerCase()) {
    return null
  } else {
    let result: IMatch[] | null = null
    let nextUpperIndex = j + 1
    result = _matchesCamelCase(word, camelCaseWord, i + 1, j + 1)
    while (
      !result &&
      (nextUpperIndex = nextAnchor(camelCaseWord, nextUpperIndex)) < camelCaseWord.length
    ) {
      result = _matchesCamelCase(word, camelCaseWord, i + 1, nextUpperIndex)
      nextUpperIndex++
    }
    return result === null ? null : join({ start: j, end: j + 1 }, result)
  }
}

interface ICamelCaseAnalysis {
  upperPercent: number
  lowerPercent: number
  alphaPercent: number
  numericPercent: number
}

// Heuristic to avoid computing camel case matcher for words that don't
// look like camelCaseWords.
function analyzeCamelCaseWord(word: string): ICamelCaseAnalysis {
  let upper = 0,
    lower = 0,
    alpha = 0,
    numeric = 0

  for (let i = 0; i < word.length; i++) {
    const code = word.charCodeAt(i)
    if (isUpper(code)) upper++
    if (isLower(code)) lower++
    if (isAlphanumeric(code)) alpha++
    if (isNumber(code)) numeric++
  }

  return {
    upperPercent: upper / word.length,
    lowerPercent: lower / word.length,
    alphaPercent: alpha / word.length,
    numericPercent: numeric / word.length,
  }
}

function isUpperCaseWord(analysis: ICamelCaseAnalysis): boolean {
  const { upperPercent, lowerPercent } = analysis
  return lowerPercent === 0 && upperPercent > 0.6
}

function isCamelCaseWord(analysis: ICamelCaseAnalysis): boolean {
  const { upperPercent, lowerPercent, alphaPercent, numericPercent } = analysis
  return lowerPercent > 0.2 && upperPercent < 0.8 && alphaPercent > 0.6 && numericPercent < 0.2
}

// Heuristic to avoid computing camel case matcher for words that don't
// look like camel case patterns.
function isCamelCasePattern(word: string): boolean {
  let upper = 0,
    lower = 0,
    whitespace = 0

  for (let i = 0; i < word.length; i++) {
    const code = word.charCodeAt(i)
    if (isUpper(code)) upper++
    if (isLower(code)) lower++
    if (isWhitespace(code)) whitespace++
  }

  if ((upper === 0 || lower === 0) && whitespace === 0) {
    return word.length <= 30
  } else {
    return upper <= 5
  }
}

export function matchesCamelCase(word: string, camelCaseWord: string): IMatch[] | null {
  if (!camelCaseWord) return null

  camelCaseWord = camelCaseWord.trim()
  if (camelCaseWord.length === 0) return null

  if (!isCamelCasePattern(word)) return null

  // TODO: Consider removing this check
  if (camelCaseWord.length > 60) {
    camelCaseWord = camelCaseWord.substring(0, 60)
  }

  const analysis = analyzeCamelCaseWord(camelCaseWord)

  if (!isCamelCaseWord(analysis)) {
    if (!isUpperCaseWord(analysis)) return null

    camelCaseWord = camelCaseWord.toLowerCase()
  }

  let result: IMatch[] | null = null
  let i = 0

  word = word.toLowerCase()
  while (
    i < camelCaseWord.length &&
    (result = _matchesCamelCase(word, camelCaseWord, 0, i)) === null
  ) {
    i = nextAnchor(camelCaseWord, i + 1)
  }

  return result
}

// Matches beginning of words in the target. With `contiguous` the query must
// consume target words from their start ('pul' matches 'Git: Pull'); without it
// word hops are allowed ('gp' / 'g p' match 'Git: Pull').
export function matchesWords(
  word: string,
  target: string,
  contiguous: boolean = false,
): IMatch[] | null {
  if (!target || target.length === 0) return null

  let result: IMatch[] | null = null
  let targetIndex = 0

  // VSCode lowercases via tryNormalizeToBase (which also strips accents); we
  // keep only the lowercasing to stay dependency-free.
  word = word.toLowerCase()
  target = target.toLowerCase()

  // Separators form an equivalence class in `charactersMatch`, so the recursion
  // in `_matchesWords` can explode exponentially for inputs like `editor.action`
  // against targets with many separators; memoize within one invocation.
  const memo = new Map<number, IMatch[] | null>()
  while (targetIndex < target.length) {
    result = _matchesWords(word, target, 0, targetIndex, contiguous, memo)
    if (result !== null) break
    targetIndex = nextWord(target, targetIndex + 1)
  }

  return result
}

function cloneMatches(matches: IMatch[] | null): IMatch[] | null {
  if (matches === null) return null
  return matches.map((m) => ({ start: m.start, end: m.end }))
}

function _matchesWords(
  word: string,
  target: string,
  wordIndex: number,
  targetIndex: number,
  contiguous: boolean,
  memo: Map<number, IMatch[] | null>,
): IMatch[] | null {
  if (wordIndex === word.length) {
    return []
  } else if (targetIndex === target.length) {
    return null
  }

  const memoKey = wordIndex * (target.length + 1) + targetIndex
  const cached = memo.get(memoKey)
  if (cached !== undefined) {
    // Caller (`join`) mutates the returned array, so always return a clone.
    return cloneMatches(cached)
  }

  const computed = _matchesWordsCompute(word, target, wordIndex, targetIndex, contiguous, memo)
  memo.set(memoKey, cloneMatches(computed))
  return computed
}

function _matchesWordsCompute(
  word: string,
  target: string,
  wordIndex: number,
  targetIndex: number,
  contiguous: boolean,
  memo: Map<number, IMatch[] | null>,
): IMatch[] | null {
  if (!charactersMatch(word.charCodeAt(wordIndex), target.charCodeAt(targetIndex))) {
    return null
  }

  let result: IMatch[] | null = null
  let nextWordIndex = targetIndex + 1
  result = _matchesWords(word, target, wordIndex + 1, nextWordIndex, contiguous, memo)
  if (!contiguous) {
    while (!result && (nextWordIndex = nextWord(target, nextWordIndex)) < target.length) {
      result = _matchesWords(word, target, wordIndex + 1, nextWordIndex, contiguous, memo)
      nextWordIndex++
    }
  }

  if (!result) return null

  // On an inexact charactersMatch the target char is a word separator; consume
  // it without highlighting it.
  if (word.charCodeAt(wordIndex) !== target.charCodeAt(targetIndex)) {
    return result
  }

  return join({ start: targetIndex, end: targetIndex + 1 }, result)
}

function nextWord(word: string, start: number): number {
  for (let i = start; i < word.length; i++) {
    if (isWordSeparator(word.charCodeAt(i)) || (i > 0 && isWordSeparator(word.charCodeAt(i - 1)))) {
      return i
    }
  }
  return word.length
}

/**
 * Deduplicate matches, drop any interval fully contained in another one, and
 * sort by start. Mirrors `filterAndSort` in VSCode's keybindingsEditorModel,
 * used to merge the per-word highlight spans of one field.
 */
export function filterAndSortMatches(matches: readonly IMatch[]): IMatch[] {
  const seen = new Set<string>()
  const distinct: IMatch[] = []
  for (const match of matches) {
    const key = match.start + '.' + match.end
    if (!seen.has(key)) {
      seen.add(key)
      distinct.push(match)
    }
  }
  return distinct
    .filter(
      (match) =>
        !distinct.some(
          (m) =>
            !(m.start === match.start && m.end === match.end) &&
            m.start <= match.start &&
            m.end >= match.end,
        ),
    )
    .sort((a, b) => a.start - b.start)
}
