/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  extendVisualByTextObject,
  findVimTextObjectByKey,
  getVimTextObject,
} from '../vimTextObjects.js'
import type { VimTextObjectId } from '../vimTypes.js'
import type { VimVisualSelection } from '../vimVisual.js'

function reader(lines: string[]) {
  return {
    getLineCount: () => lines.length,
    getLineContent: (line: number) => lines[line - 1] ?? '',
  }
}

function pick(
  lines: string[],
  object: VimTextObjectId,
  at: [number, number],
  around = false,
  count = 1,
) {
  const range = getVimTextObject(object).resolve({
    lines: reader(lines),
    cursor: { line: at[0], column: at[1] },
    around,
    count,
  })
  if (range === null) return null
  return `${range.start.line}:${range.start.column}-${range.end.line}:${range.end.column}${range.linewise ? ' L' : ''}`
}

describe('vimTextObjects', () => {
  it('resolves keys and aliases through the registry', () => {
    expect(findVimTextObjectByKey('b')?.id).toBe('(')
    expect(findVimTextObjectByKey(')')?.id).toBe('(')
    expect(findVimTextObjectByKey('B')?.id).toBe('{')
    expect(findVimTextObjectByKey('>')?.id).toBe('<')
    expect(findVimTextObjectByKey('x')).toBeUndefined()
  })

  it('iw / aw', () => {
    expect(pick(['foo bar baz'], 'w', [1, 5])).toBe('1:5-1:8')
    expect(pick(['foo bar baz'], 'w', [1, 5], true)).toBe('1:5-1:9')
    expect(pick(['foo bar'], 'w', [1, 5], true)).toBe('1:4-1:8')
    expect(pick(['foo  bar'], 'w', [1, 4])).toBe('1:4-1:6')
    expect(pick(['foo bar baz'], 'w', [1, 1], false, 3)).toBe('1:1-1:8')
    expect(pick([''], 'w', [1, 1])).toBeNull()
  })

  it('iW / aW treat punctuation as part of the word', () => {
    expect(pick(['a.b c'], 'W', [1, 2])).toBe('1:1-1:4')
    expect(pick(['a.b c'], 'W', [1, 2], true)).toBe('1:1-1:5')
  })

  it('quotes: inside, around, and the first pair after the cursor', () => {
    const line = ['x "ab" y']
    expect(pick(line, '"', [1, 4])).toBe('1:4-1:6')
    expect(pick(line, '"', [1, 4], true)).toBe('1:3-1:8')
    expect(pick(line, '"', [1, 1])).toBe('1:4-1:6')
    expect(pick(['"a\\"b"'], '"', [1, 2])).toBe('1:2-1:6')
    expect(pick(['no quotes'], '"', [1, 1])).toBeNull()
  })

  it('brackets: nesting, counts, multi-line and linewise blocks', () => {
    expect(pick(['f(a, (b), c)'], '(', [1, 7])).toBe('1:7-1:8')
    expect(pick(['f(a, (b), c)'], '(', [1, 7], false, 2)).toBe('1:3-1:12')
    expect(pick(['f(a, (b), c)'], '(', [1, 7], true)).toBe('1:6-1:9')
    expect(pick(['{', '  a', '}'], '{', [2, 3])).toBe('2:1-2:1 L')
    expect(pick(['x = [1, 2]'], '[', [1, 6])).toBe('1:6-1:10')
    expect(pick(['a < b >'], '<', [1, 5])).toBe('1:4-1:7')
    expect(pick(['no brackets'], '(', [1, 3])).toBeNull()
  })

  it('paragraphs', () => {
    expect(pick(['a', 'b', '', 'c'], 'p', [1, 1])).toBe('1:1-2:1 L')
    expect(pick(['a', 'b', '', 'c'], 'p', [1, 1], true)).toBe('1:1-3:1 L')
    expect(pick(['a', '', 'b'], 'p', [3, 1], true)).toBe('2:1-3:1 L')
  })

  it('tags', () => {
    expect(pick(['<div><b>x</b></div>'], 't', [1, 9])).toBe('1:9-1:10')
    expect(pick(['<div><b>x</b></div>'], 't', [1, 9], true)).toBe('1:6-1:14')
    expect(pick(['<div><b>x</b></div>'], 't', [1, 9], false, 2)).toBe('1:6-1:14')
    expect(pick(['<br><a>x</a>'], 't', [1, 8])).toBe('1:8-1:9')
    expect(pick(['plain'], 't', [1, 2])).toBeNull()
  })
})

describe('vimTextObjects: quotes (Vim current_quote)', () => {
  it('between two strings the text between the quotes is the object, as in Vim', () => {
    // The nearest quote before the cursor opens the string, whatever its parity.
    expect(pick(['"a" b "c"'], '"', [1, 5])).toBe('1:4-1:7')
    expect(pick(['"a" b "c"'], '"', [1, 5], true)).toBe('1:3-1:8')
  })

  it('before the first quote it takes the first pair after the cursor', () => {
    expect(pick(['x "a" y "b"'], '"', [1, 1])).toBe('1:4-1:5')
  })

  it('on a quote, parity from the start of the line says which end it is', () => {
    expect(pick(['"a" "b"'], '"', [1, 1])).toBe('1:2-1:3')
    expect(pick(['"a" "b"'], '"', [1, 3])).toBe('1:2-1:3')
    expect(pick(['"a" "b"'], '"', [1, 5])).toBe('1:6-1:7')
    expect(pick(['"a" "b"'], '"', [1, 7])).toBe('1:6-1:7')
  })

  it('fails when the pair is not closed', () => {
    expect(pick(['"a" b "c'], '"', [1, 8])).toBeNull()
    expect(pick(['x "a'], '"', [1, 3])).toBeNull()
  })

  it('a count of 2 takes the quotes along, and around takes surrounding blanks', () => {
    expect(pick(['x "ab" y'], '"', [1, 4], false, 2)).toBe('1:3-1:7')
    expect(pick(['x "ab" y'], '"', [1, 4], true)).toBe('1:3-1:8')
    expect(pick(['x "ab"'], '"', [1, 4], true)).toBe('1:2-1:7')
  })

  it('an empty string is an empty range', () => {
    expect(pick(['x ""'], '"', [1, 3])).toBe('1:4-1:4')
    expect(pick(["''"], "'", [1, 1])).toBe('1:2-1:2')
  })
})

describe('vimTextObjects: brackets', () => {
  it('an empty pair gives an empty range', () => {
    expect(pick(['f()'], '(', [1, 3])).toBe('1:3-1:3')
    expect(pick(['f()'], '(', [1, 2])).toBe('1:3-1:3')
    expect(pick(['x = []'], '[', [1, 6])).toBe('1:6-1:6')
  })

  it('braces on adjacent lines hold nothing: an empty range after the opening brace', () => {
    expect(pick(['{', '}'], '{', [1, 1])).toBe('1:2-1:2')
  })

  it('works with the cursor on either delimiter', () => {
    expect(pick(['f(ab)'], '(', [1, 2])).toBe('1:3-1:5')
    expect(pick(['f(ab)'], '(', [1, 5])).toBe('1:3-1:5')
    expect(pick(['f(ab)'], '(', [1, 5], true)).toBe('1:2-1:6')
  })

  it('spans lines: inline content stays charwise, braces on their own lines go linewise', () => {
    expect(pick(['f(a,', '  b)'], '(', [2, 3])).toBe('1:3-2:4')
    expect(pick(['f(a,', '  b)'], '(', [1, 3], true)).toBe('1:2-2:5')
    expect(pick(['if (x) {', '  a', '  b', '}'], '{', [3, 3])).toBe('2:1-3:1 L')
  })

  it('does not match brackets that are unbalanced or only after the cursor', () => {
    expect(pick(['a (b'], '(', [1, 3])).toBeNull()
    expect(pick(['a (b) c'], '(', [1, 7])).toBeNull()
  })

  it('a count beyond the nesting depth fails', () => {
    expect(pick(['(a)'], '(', [1, 2], false, 2)).toBeNull()
  })
})

describe('vimTextObjects: words and paragraphs with counts', () => {
  it('counts aw: each extra word brings its blanks', () => {
    expect(pick(['a b c d'], 'w', [1, 1], true, 2)).toBe('1:1-1:5')
    expect(pick(['a b c d'], 'w', [1, 1], true, 3)).toBe('1:1-1:7')
  })

  it('counts ip and ap', () => {
    const lines = ['a', '', 'b', '', 'c']
    expect(pick(lines, 'p', [1, 1], false, 2)).toBe('1:1-2:1 L')
    expect(pick(lines, 'p', [1, 1], false, 3)).toBe('1:1-3:1 L')
    expect(pick(lines, 'p', [1, 1], true, 2)).toBe('1:1-4:1 L')
  })

  it('ip on a blank line selects the blank run', () => {
    expect(pick(['a', '', '', 'b'], 'p', [2, 1])).toBe('2:1-3:1 L')
  })
})

describe('vimTextObjects: tags', () => {
  it('multi-line tag blocks', () => {
    const lines = ['<div>', '  <p>x</p>', '</div>']
    expect(pick(lines, 't', [2, 6])).toBe('2:6-2:7')
    expect(pick(lines, 't', [2, 6], false, 2)).toBe('1:6-3:1')
    expect(pick(lines, 't', [2, 6], true, 2)).toBe('1:1-3:7')
  })

  it('a `>` inside a quoted attribute or an arrow does not end the tag', () => {
    expect(pick(['<a title="a>b">x</a>'], 't', [1, 16])).toBe('1:16-1:17')
    expect(pick(['<Foo cb={() => go()}>x</Foo>'], 't', [1, 22])).toBe('1:22-1:23')
  })

  it('self-closing and void tags do not open a block', () => {
    expect(pick(['<div><img src="a.png"/>x<br></div>'], 't', [1, 25])).toBe('1:6-1:29')
  })

  it('fails outside any pair and for an unclosed tag', () => {
    expect(pick(['x <b>y</b> z'], 't', [1, 1])).toBeNull()
    expect(pick(['<div>text'], 't', [1, 7])).toBeNull()
  })

  it('counts enclosing pairs, innermost first', () => {
    expect(pick(['<a><b><c>x</c></b></a>'], 't', [1, 10], false, 3)).toBe('1:4-1:19')
  })

  it('only scans around the cursor so a huge buffer stays cheap', () => {
    let reads = 0
    const lines = {
      getLineCount: () => 50_000,
      getLineContent: (line: number) => {
        reads++
        return line === 25_000 ? '<b>x</b>' : 'plain text'
      },
    }
    const range = getVimTextObject('t').resolve({
      lines,
      cursor: { line: 25_000, column: 4 },
      around: false,
      count: 1,
    })
    expect(range?.start).toEqual({ line: 25_000, column: 4 })
    expect(reads).toBeLessThan(7000)
  })
})

describe('extendVisualByTextObject', () => {
  const extend = (
    lines: string[],
    anchor: [number, number],
    cursor: [number, number],
    object: VimTextObjectId,
    around = false,
    count = 1,
    mode: VimVisualSelection['mode'] = 'visual',
  ) => {
    const result = extendVisualByTextObject({
      lines: reader(lines),
      selection: {
        mode,
        anchor: { line: anchor[0], column: anchor[1] },
        cursor: { line: cursor[0], column: cursor[1] },
      },
      object,
      around,
      count,
    })
    if (result === null) return null
    return `${result.mode} ${result.anchor.line}:${result.anchor.column}->${result.cursor.line}:${result.cursor.column}`
  }

  it('selects the object when nothing is selected yet', () => {
    expect(extend(['foo bar'], [1, 2], [1, 2], 'w')).toBe('visual 1:1->1:3')
    expect(extend(['f(ab)'], [1, 3], [1, 3], '(')).toBe('visual 1:3->1:4')
  })

  it('repeating iw extends forward to the next word or blank run', () => {
    expect(extend(['foo bar baz'], [1, 1], [1, 3], 'w')).toBe('visual 1:1->1:4')
    expect(extend(['foo bar baz'], [1, 1], [1, 4], 'w')).toBe('visual 1:1->1:7')
  })

  it('a backward selection extends at the cursor end, not past the anchor', () => {
    // anchor on the `o` of foo (7), cursor on its `f` (5): grows backward over the blank.
    expect(extend(['bar foo baz'], [1, 7], [1, 5], 'w')).toBe('visual 1:7->1:4')
    expect(extend(['bar foo baz'], [1, 7], [1, 4], 'w')).toBe('visual 1:7->1:1')
  })

  it('a backward selection at the buffer start has nothing to extend', () => {
    expect(extend(['foo bar'], [1, 3], [1, 1], 'w')).toBeNull()
  })

  it('repeating ip extends over the next paragraph, either way', () => {
    const lines = ['a', '', 'b', '', 'c']
    expect(extend(lines, [1, 1], [1, 1], 'p')).toBe('visual-line 1:1->1:1')
    expect(extend(lines, [1, 1], [1, 1], 'p', false, 1, 'visual-line')).toBe('visual-line 1:1->1:1')
    expect(extend(lines, [1, 1], [2, 1], 'p', false, 1, 'visual-line')).toBe('visual-line 1:1->3:1')
    expect(extend(lines, [3, 1], [2, 1], 'p', false, 1, 'visual-line')).toBe('visual-line 3:1->1:1')
  })

  it('repeating i( / a( climbs to the enclosing pair once the current one is covered', () => {
    const lines = ['f(a, (bc), d)']
    // `vi(` on the inner pair selects `bc`; the next `i(` takes the inside of the outer pair.
    expect(extend(lines, [1, 7], [1, 7], '(')).toBe('visual 1:7->1:8')
    expect(extend(lines, [1, 7], [1, 8], '(')).toBe('visual 1:3->1:12')
    // `va(` covers `(bc)`; the next `a(` takes the outer parentheses.
    expect(extend(lines, [1, 7], [1, 8], '(', true)).toBe('visual 1:6->1:9')
    expect(extend(lines, [1, 6], [1, 9], '(', true)).toBe('visual 1:2->1:13')
  })

  it('fails when there is no larger enclosing object', () => {
    expect(extend(['(ab)'], [1, 2], [1, 3], '(')).toBeNull()
  })

  it('repeating i" climbs to the quotes themselves', () => {
    expect(extend(['x "ab" y'], [1, 4], [1, 5], '"')).toBe('visual 1:3->1:6')
  })

  it('turns V and Ctrl+V into plain Visual for a characterwise object', () => {
    expect(extend(['foo bar'], [1, 2], [1, 2], 'w', false, 1, 'visual-line')).toMatch(/^visual /)
    expect(extend(['foo bar'], [1, 2], [1, 2], 'w', false, 1, 'visual-block')).toMatch(/^visual /)
  })

  it('an empty object leaves the selection alone', () => {
    expect(extend(['f()'], [1, 3], [1, 3], '(')).toBeNull()
  })
})
