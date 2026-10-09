/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Release-notes link policy — the renderer half of the shared contract. The case table
 *  in fixtures/linkHrefCases.json is asserted by the build-time compiler too
 *  (scripts/release/__tests__/release-notes-source.test.mjs); a divergence between the two
 *  classifiers would let the compiler bless a link the app refuses (or worse, the reverse).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  RELEASE_NOTES_LINK_POLICY,
  classifyReleaseNoteHref,
  isValidReleaseNoteDocId,
  releaseNoteDocUrl,
  releaseNoteHrefSchemes,
} from '../linkPolicy.js'
import fixture from './fixtures/linkHrefCases.json' with { type: 'json' }

describe('linkPolicy — shared case table', () => {
  it('classifies every shared case exactly as the compiler does', () => {
    for (const testCase of fixture.cases) {
      expect(classifyReleaseNoteHref(testCase.href), testCase.href).toEqual(testCase.expect)
    }
  })
})

describe('linkPolicy — policy shape', () => {
  it('declares a public repo base that forks cannot alter at build time', () => {
    expect(RELEASE_NOTES_LINK_POLICY.publicRepoBase).toBe(
      'https://github.com/lovebirdsx/universe-editor',
    )
    expect(RELEASE_NOTES_LINK_POLICY.publicRepoBase).not.toMatch(/\.git$|\/$/)
  })

  it('exposes exactly the two controlled schemes to the parser', () => {
    expect(releaseNoteHrefSchemes()).toEqual(['doc', 'command'])
  })

  it('builds the online doc URL from the note version, never from the running app', () => {
    expect(releaseNoteDocUrl('0.12.0', 'getting-started/interface-tour')).toBe(
      'https://github.com/lovebirdsx/universe-editor/blob/v0.12.0/docs/user/zh-CN/getting-started/interface-tour.md',
    )
  })

  it('keeps the command allowlist free of side effects', () => {
    expect(RELEASE_NOTES_LINK_POLICY.allowedCommandIds.length).toBeGreaterThan(0)
    for (const id of RELEASE_NOTES_LINK_POLICY.allowedCommandIds) {
      // Navigation/settings entry points only — nothing that mutates the workspace.
      expect(id).toMatch(
        /^workbench\.action\.(openSettings|openSettingsJson|openGlobalKeybindings|openKeybindingsJson|openWorkspaceSettings|selectTheme|configureDisplayLanguage)$/,
      )
    }
  })

  it('rejects docIds that could escape the docs root', () => {
    for (const bad of ['../x', 'a/../../b', '/abs', 'a/./b', '_priv', 'a//b', 'a\\b', '']) {
      expect(isValidReleaseNoteDocId(bad), bad).toBe(false)
    }
    expect(isValidReleaseNoteDocId('ai/agent/overview')).toBe(true)
  })
})
