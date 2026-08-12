/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for computeBinaryVersionActions — the shared button-visibility
 *  derivation used by the claude/codex binary panels.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { computeBinaryVersionActions } from '../binaryVersionActions.js'

describe('computeBinaryVersionActions', () => {
  it('offers download + latest when nothing is installed', () => {
    expect(
      computeBinaryVersionActions({
        bundledVersion: '1.0.0',
        installedVersion: null,
        latestVersion: '2.0.0',
      }),
    ).toEqual({ showDownloadBundled: true, showRevertToBundled: false, showLatest: true })
  })

  it('hides latest when nothing is installed and latest equals bundled', () => {
    expect(
      computeBinaryVersionActions({
        bundledVersion: '1.0.0',
        installedVersion: null,
        latestVersion: '1.0.0',
      }),
    ).toEqual({ showDownloadBundled: true, showRevertToBundled: false, showLatest: false })
  })

  it('hides latest when the latest version is unavailable (network error)', () => {
    expect(
      computeBinaryVersionActions({
        bundledVersion: '1.0.0',
        installedVersion: null,
        latestVersion: null,
      }),
    ).toEqual({ showDownloadBundled: true, showRevertToBundled: false, showLatest: false })
  })

  it('offers only latest when the bundled version is installed and a newer one exists', () => {
    expect(
      computeBinaryVersionActions({
        bundledVersion: '1.0.0',
        installedVersion: '1.0.0',
        latestVersion: '2.0.0',
      }),
    ).toEqual({ showDownloadBundled: false, showRevertToBundled: false, showLatest: true })
  })

  it('offers only revert after upgrading to latest', () => {
    expect(
      computeBinaryVersionActions({
        bundledVersion: '1.0.0',
        installedVersion: '2.0.0',
        latestVersion: '2.0.0',
      }),
    ).toEqual({ showDownloadBundled: false, showRevertToBundled: true, showLatest: false })
  })

  it('offers revert + latest when all three versions differ', () => {
    expect(
      computeBinaryVersionActions({
        bundledVersion: '1.0.0',
        installedVersion: '1.5.0',
        latestVersion: '2.0.0',
      }),
    ).toEqual({ showDownloadBundled: false, showRevertToBundled: true, showLatest: true })
  })

  it('offers nothing when bundled, installed and latest all match', () => {
    expect(
      computeBinaryVersionActions({
        bundledVersion: '1.0.0',
        installedVersion: '1.0.0',
        latestVersion: '1.0.0',
      }),
    ).toEqual({ showDownloadBundled: false, showRevertToBundled: false, showLatest: false })
  })
})
