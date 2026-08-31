import { describe, expect, it } from 'vitest'
import {
  classifySyncLine,
  parseResolveOutput,
  parseSyncOutput,
  parseSyncPreview,
  parseSyncPreviewRecord,
  parseSyncPreviewTotal,
  parseSyncRefused,
  syncLineFile,
} from '../syncParser.js'

describe('parseSyncPreviewRecord', () => {
  it('maps a sync -n record', () => {
    const file = parseSyncPreviewRecord({
      depotFile: '//depot/branch_x/a.cpp',
      clientFile: 'X:/p4ws/main/a.cpp',
      action: 'updated',
      rev: '3',
    })
    expect(file).toEqual({
      depotFile: '//depot/branch_x/a.cpp',
      clientFile: 'X:/p4ws/main/a.cpp',
      action: 'updated',
      rev: '3',
    })
  })

  it('returns undefined for a record with no depot path', () => {
    expect(parseSyncPreviewRecord({ action: 'updated' })).toBeUndefined()
  })

  it('tolerates a missing clientFile', () => {
    const file = parseSyncPreviewRecord({
      depotFile: '//depot/branch_x/x.txt',
      action: 'added',
      rev: '1',
    })
    expect(file?.clientFile).toBeUndefined()
  })

  // Same client-syntax gotcha as `p4 opened` / `reconcile -n`: when sync -n
  // reports `clientFile` in client syntax it must become the local path.
  it('translates a client-syntax clientFile onto the client root', () => {
    const file = parseSyncPreviewRecord(
      {
        depotFile: '//depot/branch_x/Src/a.cpp',
        clientFile: '//ws/Src/a.cpp',
        action: 'updated',
        rev: '2',
      },
      'X:/p4ws/main',
    )
    expect(file?.clientFile).toBe('X:/p4ws/main/Src/a.cpp')
  })

  it('keeps an already-local clientFile verbatim even with a clientRoot', () => {
    const file = parseSyncPreviewRecord(
      {
        depotFile: '//depot/branch_x/a.cpp',
        clientFile: 'X:/p4ws/main/a.cpp',
        action: 'updated',
        rev: '3',
      },
      'X:/p4ws/main',
    )
    expect(file?.clientFile).toBe('X:/p4ws/main/a.cpp')
  })

  it('keeps the clientFile verbatim when no clientRoot is given', () => {
    const file = parseSyncPreviewRecord({
      depotFile: '//depot/branch_x/a.cpp',
      clientFile: '//ws/Src/a.cpp',
      action: 'updated',
      rev: '2',
    })
    expect(file?.clientFile).toBe('//ws/Src/a.cpp')
  })
})

describe('parseSyncPreview', () => {
  it('parses many records and drops non-file ones', () => {
    const files = parseSyncPreview([
      {
        depotFile: '//depot/branch_x/a.cpp',
        clientFile: 'X:/p4ws/main/a.cpp',
        action: 'updated',
        rev: '3',
      },
      { info: 'no such file(s).' },
      {
        depotFile: '//depot/branch_x/b.h',
        clientFile: 'X:/p4ws/main/b.h',
        action: 'added',
        rev: '7',
      },
    ])
    expect(files).toHaveLength(2)
    expect(files.map((f) => f.action)).toEqual(['updated', 'added'])
  })

  it('returns an empty list for empty output', () => {
    expect(parseSyncPreview([])).toEqual([])
  })
})

describe('parseSyncPreviewTotal', () => {
  // Measured on P4D 2024.2: `totalFileCount` rides in the FIRST file record as
  // one grand total across all filespecs, and survives `-m` truncation.
  it('reads the total from the first record', () => {
    const records = [
      {
        depotFile: '//depot/branch_x/a.cpp',
        clientFile: 'X:/p4ws/main/a.cpp',
        rev: '3',
        action: 'updated',
        totalFileSize: '37318816',
        totalFileCount: '1941',
        change: '8607110',
      },
      {
        depotFile: '//depot/branch_x/b.h',
        clientFile: 'X:/p4ws/main/b.h',
        rev: '2',
        action: 'updated',
      },
    ]
    expect(parseSyncPreviewTotal(records)).toBe(1941)
  })

  it('returns undefined when no record carries the key', () => {
    expect(
      parseSyncPreviewTotal([{ depotFile: '//depot/branch_x/a.cpp', action: 'updated', rev: '2' }]),
    ).toBeUndefined()
  })

  it('returns undefined for an empty output', () => {
    expect(parseSyncPreviewTotal([])).toBeUndefined()
  })

  it('ignores non-numeric values', () => {
    expect(parseSyncPreviewTotal([{ totalFileCount: 'many' }])).toBeUndefined()
  })

  it('takes the last value defensively when several records report one', () => {
    const records = [
      { depotFile: '//depot/branch_x/a.cpp', totalFileCount: '10' },
      { depotFile: '//depot/branch_x/b.h', totalFileCount: '30' },
    ]
    expect(parseSyncPreviewTotal(records)).toBe(30)
  })
})

describe('parseSyncOutput', () => {
  const MIXED = [
    '//depot/branch_x/a.cpp#3 - updated as X:/p4ws/main/a.cpp',
    '//depot/branch_x/b.h#7 - added as X:/p4ws/main/b.h',
    '//depot/branch_x/c.txt#2 - deleted as X:/p4ws/main/c.txt',
    '//depot/branch_x/d.cs#5 - refreshing X:/p4ws/main/d.cs',
    "//depot/branch_x/e.ini - is opened and can't be replaced.",
    '//depot/branch_x/f.cpp - must resolve #4 before submitting',
  ].join('\n')

  it('counts applied / keptOpen / mustResolve lines in a mixed run', () => {
    expect(parseSyncOutput(MIXED, '')).toEqual({
      applied: 4,
      keptOpen: 1,
      mustResolve: 1,
      refusedModified: 0,
      upToDate: false,
      unrecognized: false,
    })
  })

  it('flags up-to-date reported on stderr with exit 0', () => {
    expect(parseSyncOutput('', 'X:/p4ws/main/... - file(s) up-to-date.')).toEqual({
      applied: 0,
      keptOpen: 0,
      mustResolve: 0,
      refusedModified: 0,
      upToDate: true,
      unrecognized: false,
    })
  })

  it('treats empty stdout + stderr as nothing happened, not unrecognized', () => {
    expect(parseSyncOutput('', '')).toEqual({
      applied: 0,
      keptOpen: 0,
      mustResolve: 0,
      refusedModified: 0,
      upToDate: false,
      unrecognized: false,
    })
  })

  it('flags unrecognized when stdout has content but nothing was counted', () => {
    const summary = parseSyncOutput('something unexpected\n//depot/branch_x/a.cpp - huh\n', '')
    expect(summary).toEqual({
      applied: 0,
      keptOpen: 0,
      mustResolve: 0,
      refusedModified: 0,
      upToDate: false,
      unrecognized: true,
    })
  })

  it('is not unrecognized when at least one line was counted', () => {
    const summary = parseSyncOutput(
      "//depot/branch_x/e.ini - is opened and can't be replaced.\ngarbage\n",
      '',
    )
    expect(summary.keptOpen).toBe(1)
    expect(summary.unrecognized).toBe(false)
  })

  it('tolerates CRLF and surrounding whitespace', () => {
    const out = [
      '  //depot/branch_x/a.cpp#3 - updated as X:/p4ws/main/a.cpp  ',
      '\t//depot/branch_x/b.h#7 - added as X:/p4ws/main/b.h',
    ].join('\r\n')
    expect(parseSyncOutput(out, '').applied).toBe(2)
  })

  it('counts refreshed / updating variants as applied', () => {
    const out = [
      '//depot/branch_x/a.cpp#3 - refreshed X:/p4ws/main/a.cpp',
      '//depot/branch_x/b.h#7 - updating X:/p4ws/main/b.h',
      '//depot/branch_x/c.txt - is opened and not being changed',
    ].join('\n')
    const summary = parseSyncOutput(out, '')
    expect(summary.applied).toBe(2)
    expect(summary.keptOpen).toBe(1)
  })

  // An `allwrite noclobber` client refuses a locally-modified file per file, on
  // stdout, with exit 0. Left uncounted this reads as "nothing to do" and the
  // caller tells the user the file is already current — the bug this guards.
  it('counts an allwrite-noclobber refusal and does not call it unrecognized', () => {
    const out = "//depot/branch_x/a.json#69 - can't update modified file X:/p4ws/main/a.json"
    expect(parseSyncOutput(out, '')).toEqual({
      applied: 0,
      keptOpen: 0,
      mustResolve: 0,
      refusedModified: 1,
      upToDate: false,
      unrecognized: false,
    })
  })

  it('counts refusals alongside applied lines in one run', () => {
    const out = [
      '//depot/branch_x/a.cpp#3 - updated as X:/p4ws/main/a.cpp',
      "//depot/branch_x/b.json#69 - can't update modified file X:/p4ws/main/b.json",
    ].join('\n')
    const summary = parseSyncOutput(out, '')
    expect(summary.applied).toBe(1)
    expect(summary.refusedModified).toBe(1)
    expect(summary.unrecognized).toBe(false)
  })

  it('does not mistake a refusal line for an applied one', () => {
    // ` - ` is followed by `can't`, not by `update`, so APPLIED_LINE must miss it.
    const summary = parseSyncOutput(
      "//depot/branch_x/a.json#69 - can't update modified file X:/p4ws/main/a.json",
      '',
    )
    expect(summary.applied).toBe(0)
  })
})

describe('classifySyncLine', () => {
  it('classifies the four sync line kinds', () => {
    expect(classifySyncLine('//depot/branch_x/a.cpp#3 - updated as X:/p4ws/main/a.cpp')).toBe(
      'applied',
    )
    expect(classifySyncLine("//depot/branch_x/e.ini - is opened and can't be replaced.")).toBe(
      'keptOpen',
    )
    expect(classifySyncLine('//depot/branch_x/f.cpp - must resolve #4 before submitting')).toBe(
      'mustResolve',
    )
    expect(
      classifySyncLine(
        "//depot/branch_x/a.json#69 - can't update modified file X:/p4ws/main/a.json",
      ),
    ).toBe('refused')
  })

  it('returns undefined for an unrecognized line', () => {
    expect(classifySyncLine('garbage output')).toBeUndefined()
  })

  it('returns undefined for an empty line', () => {
    expect(classifySyncLine('')).toBeUndefined()
    expect(classifySyncLine('   ')).toBeUndefined()
  })

  it('trims surrounding whitespace before classifying', () => {
    expect(classifySyncLine('  //depot/branch_x/a.cpp#3 - added as X:/p4ws/main/a.cpp  ')).toBe(
      'applied',
    )
    expect(classifySyncLine('\t//depot/branch_x/b.h - must resolve #2 before submitting')).toBe(
      'mustResolve',
    )
  })

  it('does not mistake a refusal line for an applied one', () => {
    expect(
      classifySyncLine(
        "//depot/branch_x/a.json#69 - can't update modified file X:/p4ws/main/a.json",
      ),
    ).toBe('refused')
  })
})

describe('syncLineFile', () => {
  it('returns the last depot segment across the six line shapes', () => {
    expect(syncLineFile('//depot/branch_x/a.cpp#3 - updated as X:/p4ws/main/a.cpp')).toBe('a.cpp')
    expect(syncLineFile('//depot/branch_x/a.cpp#3 - added as X:/p4ws/main/a.cpp')).toBe('a.cpp')
    expect(syncLineFile('//depot/branch_x/a.cpp#3 - refreshing X:/p4ws/main/a.cpp')).toBe('a.cpp')
    expect(
      syncLineFile("//depot/branch_x/a.cpp#3 - can't update modified file X:/p4ws/main/a.cpp"),
    ).toBe('a.cpp')
    expect(syncLineFile('//depot/branch_x/a.cpp#3 - is opened and not being changed')).toBe('a.cpp')
    expect(syncLineFile('... //depot/branch_x/a.cpp - must resolve #3 before submitting')).toBe(
      'a.cpp',
    )
  })

  it('returns a chinese-named file verbatim', () => {
    expect(
      syncLineFile('//depot/branch_x/中文/文件.cpp#2 - updated as X:/p4ws/main/中文/文件.cpp'),
    ).toBe('文件.cpp')
  })

  it('returns undefined for a line without a depot path', () => {
    expect(syncLineFile('X:/p4ws/main/... - file(s) up-to-date.')).toBeUndefined()
    expect(syncLineFile('garbage')).toBeUndefined()
    expect(syncLineFile('')).toBeUndefined()
  })
})

describe('parseSyncRefused', () => {
  const LINE = "//depot/branch_x/a.json#69 - can't update modified file X:/p4ws/main/a.json"

  it('extracts the depot path, revision and local path', () => {
    expect(parseSyncRefused(LINE)).toEqual([
      {
        depotFile: '//depot/branch_x/a.json',
        clientFile: 'X:/p4ws/main/a.json',
        action: 'not updated',
        rev: '69',
      },
    ])
  })

  it('returns an empty list when nothing was refused', () => {
    expect(parseSyncRefused('//depot/branch_x/a.cpp#3 - updated as X:/p4ws/main/a.cpp')).toEqual([])
    expect(parseSyncRefused('')).toEqual([])
    expect(parseSyncRefused('X:/p4ws/main/... - file(s) up-to-date.')).toEqual([])
  })

  it('tolerates CRLF and surrounding whitespace, and collects every refusal', () => {
    const out = [
      `  ${LINE}  `,
      "\t//depot/branch_x/b.ini#4 - can't update modified file X:/p4ws/main/b.ini",
    ].join('\r\n')
    const files = parseSyncRefused(out)
    expect(files.map((f) => f.rev)).toEqual(['69', '4'])
  })

  it('keeps a windows local path verbatim when no client root is given', () => {
    const files = parseSyncRefused(
      "//depot/branch_x/a.json#69 - can't update modified file X:\\p4ws\\main\\a.json",
    )
    expect(files[0]?.clientFile).toBe('X:\\p4ws\\main\\a.json')
  })
})

describe('parseResolveOutput', () => {
  const MIXED = [
    'X:/p4ws/main/a.cpp - merging //depot/branch_x/a.cpp#4',
    'Diff chunks: 2 yours + 3 theirs + 0 both + 0 conflicting',
    '//depot/branch_x/a.cpp - copy from //depot/branch_x/a.cpp',
    'X:/p4ws/main/b.cpp - merging //depot/branch_x/b.cpp#7',
    'Diff chunks: 0 yours + 0 theirs + 0 both + 2 conflicting',
    '//depot/branch_x/b.cpp - resolve skipped.',
  ].join('\n')

  it('splits landed from skipped in a partially successful -am run', () => {
    expect(parseResolveOutput(MIXED)).toEqual({ merged: 1, remaining: 1, unrecognized: false })
  })

  it('counts - merged lines as landed', () => {
    const out = [
      'X:/p4ws/main/a.cpp - merging //depot/branch_x/a.cpp#4',
      'Diff chunks: 1 yours + 0 theirs + 0 both + 0 conflicting',
      '//depot/branch_x/a.cpp - merged //depot/branch_x/a.cpp#4',
    ].join('\n')
    expect(parseResolveOutput(out)).toEqual({ merged: 1, remaining: 0, unrecognized: false })
  })

  it('counts every skipped file as remaining', () => {
    const out = [
      '//depot/branch_x/b.cpp - resolve skipped.',
      '//depot/branch_x/c.cpp - resolve skipped.',
    ].join('\r\n')
    expect(parseResolveOutput(out)).toEqual({ merged: 0, remaining: 2, unrecognized: false })
  })

  it('treats empty output as nothing happened', () => {
    expect(parseResolveOutput('')).toEqual({ merged: 0, remaining: 0, unrecognized: false })
  })

  it('flags unrecognized when output has content but nothing matched', () => {
    expect(parseResolveOutput('weird output line\n').unrecognized).toBe(true)
  })

  // PROBE-FINDINGS §11.4: real P4D 2024.2 transcripts — the four line shapes
  // the parser must recognize so a successful -am is never reported as
  // "unrecognized, nothing merged".

  it('counts a real mergeable -am transcript (`- merge from`) as landed', () => {
    const out = [
      'X:/p4ws/main/a.cpp - merging //depot/branch_x/a.cpp#2',
      'Diff chunks: 1 yours + 1 theirs + 0 both + 0 conflicting',
      '//depot/branch_x/a.cpp - merge from //depot/branch_x/a.cpp',
    ].join('\n')
    expect(parseResolveOutput(out)).toEqual({ merged: 1, remaining: 0, unrecognized: false })
  })

  it('counts a both-chunk-landed transcript (`- ignored`) as landed', () => {
    const out = [
      'X:/p4ws/main/a.cpp - merging //depot/branch_x/a.cpp#2',
      'Diff chunks: 1 yours + 0 theirs + 1 both + 0 conflicting',
      '//depot/branch_x/a.cpp - ignored //depot/branch_x/a.cpp',
    ].join('\n')
    expect(parseResolveOutput(out)).toEqual({ merged: 1, remaining: 0, unrecognized: false })
  })

  it('counts every - ignored line as landed', () => {
    const out = [
      '//depot/branch_x/b.cpp - ignored //depot/branch_x/b.cpp',
      '//depot/branch_x/c.cpp - ignored //depot/branch_x/c.cpp',
    ].join('\r\n')
    expect(parseResolveOutput(out)).toEqual({ merged: 2, remaining: 0, unrecognized: false })
  })

  it('recognizes the merging header and Diff chunks lines as noise, not unrecognized', () => {
    const out = [
      'X:/p4ws/main/a.cpp - merging //depot/branch_x/a.cpp#2',
      'Diff chunks: 0 yours + 0 theirs + 0 both + 1 conflicting',
    ].join('\n')
    expect(parseResolveOutput(out)).toEqual({ merged: 0, remaining: 0, unrecognized: false })
  })

  it('still flags genuinely unknown lines as unrecognized (never silent)', () => {
    // `- vs` belongs to `resolve -ay/-at` transcripts, which this parser never
    // consumes — an -am transcript containing it is genuinely unaccounted for.
    expect(
      parseResolveOutput('X:/p4ws/main/a.cpp - vs //depot/branch_x/a.cpp#2\n').unrecognized,
    ).toBe(true)
  })
})
