/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/glob/glob.ts — the single glob → RegExp
 *  engine shared by `compileGlobMatcher` (extension-surface semantics) and
 *  `makeGlobMatcher`/`makeExcludeMatcher` (settings/association semantics).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  compileGlobMatcher,
  makeExcludeMatcher,
  makeGlobMatcher,
  normalizeExtensionGlobPattern,
} from '../../glob/glob.js'

describe('compileGlobMatcher', () => {
  it('matches a literal relative path exactly', () => {
    const m = compileGlobMatcher('src/index.ts')
    expect(m('src/index.ts')).toBe(true)
    expect(m('src/other.ts')).toBe(false)
    expect(m('lib/src/index.ts')).toBe(false)
  })

  it('`*` stays within one path segment', () => {
    const m = compileGlobMatcher('src/*.ts')
    expect(m('src/a.ts')).toBe(true)
    expect(m('src/deep/a.ts')).toBe(false)
  })

  it('a slashless pattern matches the basename at any depth', () => {
    const m = compileGlobMatcher('*.ts')
    expect(m('a.ts')).toBe(true)
    expect(m('src/deep/a.ts')).toBe(true)
    expect(m('a.tsx')).toBe(false)
  })

  it('`**` crosses directory levels', () => {
    const m = compileGlobMatcher('**/test/**/a.css')
    expect(m('test/a.css')).toBe(true) // both `**/` optionals match zero segments
    expect(m('test/x/a.css')).toBe(true)
    expect(m('a/b/test/x/y/a.css')).toBe(true)
    expect(m('a/b/test/x/y/a.css2')).toBe(false)
  })

  it('`src/**` matches everything below src', () => {
    const m = compileGlobMatcher('src/**')
    expect(m('src/a/b/c.ts')).toBe(true)
    expect(m('lib/a.ts')).toBe(false)
  })

  it('`**/*.ts` also matches at the root (zero segments)', () => {
    const m = compileGlobMatcher('**/*.ts')
    expect(m('a.ts')).toBe(true)
    expect(m('src/a.ts')).toBe(true)
  })

  it('`?` matches exactly one non-separator character', () => {
    const m = compileGlobMatcher('foo?.js')
    expect(m('foo1.js')).toBe(true)
    expect(m('foo12.js')).toBe(false)
    expect(m('foo/1.js')).toBe(false)
  })

  it('`{a,b}` alternates', () => {
    const m = compileGlobMatcher('**/*.{ts,tsx}')
    expect(m('a.ts')).toBe(true)
    expect(m('src/b.tsx')).toBe(true)
    expect(m('c.css')).toBe(false)
  })

  it('brace alternatives compile as glob fragments', () => {
    const m = compileGlobMatcher('{src/*,test}/a.ts')
    expect(m('src/x/a.ts')).toBe(true)
    expect(m('test/a.ts')).toBe(true)
    expect(m('src/x/y/a.ts')).toBe(false)
  })

  it('`[...]` character classes with ranges and negation', () => {
    expect(compileGlobMatcher('[a-z].ts')('m.ts')).toBe(true)
    expect(compileGlobMatcher('[a-z].ts')('M.ts')).toBe(false)
    expect(compileGlobMatcher('[!a-z].ts')('M.ts')).toBe(true)
    expect(compileGlobMatcher('[^a-z].ts')('M.ts')).toBe(true)
    expect(compileGlobMatcher('[!a-z].ts')('m.ts')).toBe(false)
  })

  it('normalizes Windows backslashes in both pattern and input', () => {
    const m = compileGlobMatcher('src\\**\\*.ts')
    expect(m('src\\deep\\a.ts')).toBe(true)
    expect(m('src/deep/a.ts')).toBe(true)
  })

  it('strips leading slashes on the matched value', () => {
    expect(compileGlobMatcher('src/a.ts')('/src/a.ts')).toBe(true)
  })

  it('escapes regex metacharacters in literals', () => {
    const m = compileGlobMatcher('a+b(c).ts')
    expect(m('a+b(c).ts')).toBe(true)
    expect(m('a+bc.ts')).toBe(false)
  })

  it('an unclosed `{` or `[` is a literal character', () => {
    expect(compileGlobMatcher('a{b.ts')('a{b.ts')).toBe(true)
    expect(compileGlobMatcher('a[b.ts')('a[b.ts')).toBe(true)
  })

  it('matching is case-sensitive', () => {
    expect(compileGlobMatcher('*.ts')('A.TS')).toBe(false)
  })
})

describe('makeGlobMatcher', () => {
  it('returns null for an empty pattern list', () => {
    expect(makeGlobMatcher([])).toBeNull()
  })

  it('matches a literal path', () => {
    const m = makeGlobMatcher(['src/index.ts'])!
    expect(m('src/index.ts')).toBe(true)
    expect(m('src/index.tsx')).toBe(false)
  })

  it('single-* does not cross path separators', () => {
    const m = makeGlobMatcher(['src/*.ts'])!
    expect(m('src/index.ts')).toBe(true)
    expect(m('src/sub/index.ts')).toBe(false)
  })

  it('double-** matches across path segments', () => {
    const m = makeGlobMatcher(['**/*.ts'])!
    expect(m('a.ts')).toBe(true)
    expect(m('src/index.ts')).toBe(true)
    expect(m('src/deep/nested/file.ts')).toBe(true)
    expect(m('readme.md')).toBe(false)
  })

  it('? matches a single non-separator character', () => {
    const m = makeGlobMatcher(['file.?s'])!
    expect(m('file.ts')).toBe(true)
    expect(m('file.js')).toBe(true)
    expect(m('file.tsx')).toBe(false)
  })

  it('multiple patterns OR together', () => {
    const m = makeGlobMatcher(['**/*.ts', '**/*.tsx'])!
    expect(m('a.ts')).toBe(true)
    expect(m('a.tsx')).toBe(true)
    expect(m('a.js')).toBe(false)
  })

  it('supports brace alternation', () => {
    const m = makeGlobMatcher(['**/*.{ts,tsx}'])!
    expect(m('a.ts')).toBe(true)
    expect(m('src/a.tsx')).toBe(true)
    expect(m('a.js')).toBe(false)
  })

  it('supports brace alternation on path segments', () => {
    const m = makeGlobMatcher(['{src,test}/**'])!
    expect(m('src/a.ts')).toBe(true)
    expect(m('test/deep/b.ts')).toBe(true)
    expect(m('lib/c.ts')).toBe(false)
  })

  it('brace alternatives compile as glob fragments, not literals', () => {
    const m = makeGlobMatcher(['{src/*,test}/a.ts'])!
    expect(m('src/x/a.ts')).toBe(true)
    expect(m('test/a.ts')).toBe(true)
    expect(m('src/x/y/a.ts')).toBe(false)
    expect(m('{src/*,test}/a.ts')).toBe(false)
  })

  it('treats an unclosed brace as a literal', () => {
    const m = makeGlobMatcher(['a{b'])!
    expect(m('a{b')).toBe(true)
    expect(m('ab')).toBe(false)
  })

  it('matches a bare directory segment', () => {
    const m = makeGlobMatcher(['**/node_modules'])!
    expect(m('node_modules')).toBe(true)
    expect(m('packages/x/node_modules')).toBe(true)
    expect(m('node_modules/x/y.js')).toBe(false)
  })

  it('matches directory descendants with /** suffix', () => {
    const m = makeGlobMatcher(['**/node_modules/**'])!
    expect(m('node_modules/x/y.js')).toBe(true)
    expect(m('packages/a/node_modules/x.js')).toBe(true)
  })

  it('normalises backslashes and strips leading slash', () => {
    const m = makeGlobMatcher(['src/index.ts'])!
    expect(m('src\\index.ts')).toBe(true)
    expect(m('/src/index.ts')).toBe(true)
  })

  it('compiles `[...]` as a character class with ranges and negation', () => {
    expect(makeGlobMatcher(['[a-z].ts'])!('m.ts')).toBe(true)
    expect(makeGlobMatcher(['[a-z].ts'])!('M.ts')).toBe(false)
    expect(makeGlobMatcher(['[!a-z].ts'])!('M.ts')).toBe(true)
    expect(makeGlobMatcher(['[!a-z].ts'])!('m.ts')).toBe(false)
  })

  it('a slashless pattern matches at the root only (no basename expansion)', () => {
    const m = makeGlobMatcher(['*.ts'])!
    expect(m('a.ts')).toBe(true)
    expect(m('src/a.ts')).toBe(false)
  })
})

describe('normalizeExtensionGlobPattern', () => {
  it('prefixes a slashless pattern with `**/`', () => {
    expect(normalizeExtensionGlobPattern('*.ts')).toBe('**/*.ts')
    expect(normalizeExtensionGlobPattern('node_modules')).toBe('**/node_modules')
  })

  it('leaves anchored patterns untouched', () => {
    expect(normalizeExtensionGlobPattern('src/*.ts')).toBe('src/*.ts')
    expect(normalizeExtensionGlobPattern('**/*.ts')).toBe('**/*.ts')
  })

  it('normalizes backslashes and leading/trailing slashes', () => {
    expect(normalizeExtensionGlobPattern('src\\*.ts')).toBe('src/*.ts')
    expect(normalizeExtensionGlobPattern('/src/*.ts')).toBe('src/*.ts')
  })

  it('the slashless check runs after normalization', () => {
    // `src/` strips to the slashless `src` and picks up the basename prefix.
    expect(normalizeExtensionGlobPattern('src/')).toBe('**/src')
    // After backslash normalization every pattern containing one is anchored.
    expect(normalizeExtensionGlobPattern('*\\**\\*.ts')).toBe('*/**/*.ts')
  })

  it('passes `**` and the empty pattern through untouched', () => {
    expect(normalizeExtensionGlobPattern('**')).toBe('**')
    expect(normalizeExtensionGlobPattern('')).toBe('')
  })
})

describe('cross-entry consistency', () => {
  // The unification invariant: `compileGlobMatcher(p)` is exactly the settings
  // entry (`makeGlobMatcher`) fed the normalized form of `p` — same fragment
  // compiler on both sides, the difference lives in the normalization helper.
  const patterns = [
    '**/*.ts',
    'src/*.ts',
    'foo?.js',
    '**/*.{ts,tsx}',
    '{src/*,test}/a.ts',
    '[a-z].ts',
    '[!a-z].ts',
    '*.ts', // slashless basename
    'node_modules',
    './src/*.ts', // leading `./` stays literal in both entries
    '**/node_modules/**',
    'src\\**\\*.log', // backslashes normalize away on the extension side
  ]
  const paths = [
    'a.ts',
    'A.TS',
    'src/a.ts',
    'src/deep/a.ts',
    'src/index.tsx',
    'foo1.js',
    'foo/1.js',
    'src/x/a.ts',
    'test/a.ts',
    'm.ts',
    'M.ts',
    'node_modules',
    'node_modules/x/y.js',
    'packages/x/node_modules/y.js',
    './src/a.ts',
    'src/deep/a.log',
    '\\src\\a.ts',
  ]

  it.each(patterns.map((p) => ({ p })))(
    'compileGlobMatcher($p) === makeGlobMatcher([normalize($p)])',
    ({ p }) => {
      const ext = compileGlobMatcher(p)
      const settings = makeGlobMatcher([normalizeExtensionGlobPattern(p)])!
      for (const path of paths) {
        expect(settings(path), `path ${JSON.stringify(path)}`).toBe(ext(path))
      }
    },
  )

  it('matching is case-sensitive in both entries', () => {
    for (const path of paths) {
      expect(compileGlobMatcher('*.ts')(path)).toBe(makeGlobMatcher(['**/*.ts'])!(path))
      if (path === 'A.TS') {
        expect(compileGlobMatcher('*.ts')(path)).toBe(false)
        expect(makeGlobMatcher(['**/*.ts'])!(path)).toBe(false)
        expect(makeGlobMatcher(['*.ts'])!(path)).toBe(false)
      }
    }
  })

  it('the slashless basename difference between entries is deliberate and bounded', () => {
    // Extension surface: basename at any depth. Settings surface: root only.
    expect(compileGlobMatcher('*.ts')('src/a.ts')).toBe(true)
    expect(makeGlobMatcher(['*.ts'])!('src/a.ts')).toBe(false)
    expect(makeGlobMatcher(['*.ts'])!('a.ts')).toBe(true)
  })
})

describe('makeExcludeMatcher', () => {
  it('returns null for an empty object', () => {
    expect(makeExcludeMatcher({})).toBeNull()
  })

  it('returns null when every entry is false', () => {
    expect(makeExcludeMatcher({ '**/node_modules': false })).toBeNull()
  })

  it('only includes entries whose value is exactly true', () => {
    const m = makeExcludeMatcher({
      '**/node_modules': true,
      '**/dist': false,
      '**/.git': true,
    })!
    expect(m('node_modules')).toBe(true)
    expect(m('node_modules/x/y.js')).toBe(true)
    expect(m('packages/x/node_modules/pkg.js')).toBe(true)
    expect(m('.git')).toBe(true)
    expect(m('src/.git/config')).toBe(true)
    expect(m('dist')).toBe(false)
  })

  it('treats /** exclude patterns as excluding the directory itself too', () => {
    const m = makeExcludeMatcher({ '**/dist/**': true })!
    expect(m('dist')).toBe(true)
    expect(m('dist/bundle.js')).toBe(true)
    expect(m('packages/a/dist')).toBe(true)
    expect(m('packages/a/dist/bundle.js')).toBe(true)
  })
})
