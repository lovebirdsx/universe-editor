/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  classifyUnshelveFailure,
  mapDepotAcrossStreams,
  normalizeStreamSpec,
} from '../streamMapping.js'

describe('normalizeStreamSpec', () => {
  it('adds the leading // and strips trailing slashes', () => {
    expect(normalizeStreamSpec('depot/branch_x')).toBe('//depot/branch_x')
    expect(normalizeStreamSpec('//depot/branch_x/')).toBe('//depot/branch_x')
    expect(normalizeStreamSpec('  //depot/branch_x  ')).toBe('//depot/branch_x')
  })

  it('rejects empty and filespec-bearing values', () => {
    expect(normalizeStreamSpec(undefined)).toBeUndefined()
    expect(normalizeStreamSpec('')).toBeUndefined()
    expect(normalizeStreamSpec('   ')).toBeUndefined()
    expect(normalizeStreamSpec('//depot/dev@123')).toBeUndefined()
    expect(normalizeStreamSpec('//depot/dev#1')).toBeUndefined()
    expect(normalizeStreamSpec('//depot/...')).toBeUndefined()
  })
})

describe('mapDepotAcrossStreams', () => {
  it('rewrites the stream prefix and keeps the relative path', () => {
    expect(
      mapDepotAcrossStreams(
        '//depot/branch_a/src/editor/a.ts',
        '//depot/branch_a',
        '//depot/branch_b',
      ),
    ).toBe('//depot/branch_b/src/editor/a.ts')
    expect(mapDepotAcrossStreams('//depot/branch_a/x.ts', 'depot/branch_a', 'depot/branch_b')).toBe(
      '//depot/branch_b/x.ts',
    )
  })

  it('refuses files outside the review stream and equal streams', () => {
    expect(
      mapDepotAcrossStreams('//other/x.ts', '//depot/branch_a', '//depot/branch_b'),
    ).toBeUndefined()
    expect(
      mapDepotAcrossStreams('//depot/branch_a/x.ts', '//depot/branch_a', '//depot/branch_a'),
    ).toBeUndefined()
  })

  it('does not treat a sibling whose name shares the prefix as nested', () => {
    expect(
      mapDepotAcrossStreams('//depot/branch_ab/x.ts', '//depot/branch_a', '//depot/branch_b'),
    ).toBeUndefined()
  })
})

describe('classifyUnshelveFailure', () => {
  it('recognizes committed changes before stream errors', () => {
    expect(classifyUnshelveFailure('Change 900 is already committed.')).toBe('committed')
  })

  it('recognizes unsupported -S shapes', () => {
    expect(classifyUnshelveFailure('Unknown option: -S.')).toBe('stream-unsupported')
    expect(classifyUnshelveFailure('The -S option requires a stream client.')).toBe(
      'stream-unsupported',
    )
    expect(classifyUnshelveFailure('Streams are not enabled on this server.')).toBe(
      'stream-unsupported',
    )
  })

  it('distinguishes stream-relationship failures for logging and per-file retries', () => {
    expect(classifyUnshelveFailure('//depot/branch_a/x.ts - file(s) not in client view.')).toBe(
      'stream-relation',
    )
  })

  it('leaves ordinary refusals for per-file retries', () => {
    expect(classifyUnshelveFailure('already opened for edit')).toBe('other')
  })
})
