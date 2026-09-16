/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for computeBinaryVersionActions / deriveBinaryActionState — the shared
 *  button-visibility and button-state derivation used by the claude/codex binary
 *  panels.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { computeBinaryVersionActions, deriveBinaryActionState } from '../binaryVersionActions.js'

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

describe('deriveBinaryActionState', () => {
  // Built by a function, not an inline literal: the helper only reads `version`,
  // so the full download shape still has to type-check as a wider value.
  function inFlight(version: string, background = false) {
    return { version, received: 1, total: 2, background }
  }

  const info = {
    downloadedVersions: ['1.0.0'],
    downloads: [inFlight('2.0.0')],
  }

  it('marks the version being downloaded right now', () => {
    expect(deriveBinaryActionState('2.0.0', info)).toEqual({
      version: '2.0.0',
      downloading: true,
      onDisk: false,
    })
  })

  it('marks a version already extracted on disk', () => {
    expect(deriveBinaryActionState('1.0.0', info)).toEqual({
      version: '1.0.0',
      downloading: false,
      onDisk: true,
    })
  })

  it('marks a background download as in flight too', () => {
    expect(
      deriveBinaryActionState('5.0.0', {
        downloadedVersions: [],
        downloads: [inFlight('5.0.0', true)],
      }).downloading,
    ).toBe(true)
  })

  it('reports an untouched version as plain', () => {
    expect(deriveBinaryActionState('3.0.0', info)).toEqual({
      version: '3.0.0',
      downloading: false,
      onDisk: false,
    })
  })
})
