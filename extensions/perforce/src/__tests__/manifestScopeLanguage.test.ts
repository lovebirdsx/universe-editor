import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { SCOPE_FILE_NAME } from '../scopeConfig.js'

/*
 * `.p4delta-scope` is strict JSON but carries no `.json` suffix, so its
 * language association lives in the manifest by filename. The two spellings
 * are asserted together rather than reviewed: a rename on either side would
 * silently drop syntax highlighting and the JSON file icon for the one file
 * users are told to hand-edit, and nothing else would fail.
 */

interface LanguageContribution {
  id?: string
  filenames?: string[]
}

const manifest = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8'),
) as { contributes: { languages?: LanguageContribution[] } }

describe('contributes.languages', () => {
  it('associates the scope file with JSON by filename', () => {
    expect(manifest.contributes.languages).toContainEqual({
      id: 'json',
      filenames: [SCOPE_FILE_NAME],
    })
  })
})
