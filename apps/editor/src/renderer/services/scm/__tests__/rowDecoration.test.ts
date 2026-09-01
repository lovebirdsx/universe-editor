/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for resolveRowDecoration — the precedence table merging the SCM model's
 *  own decoration, the ignored flag, and the on-demand working-tree hint into a
 *  flat row-decoration prop set.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { IScmDecoration } from '../ScmDecorationsService.js'
import { IGNORED_RESOURCE_FOREGROUND } from '../ScmIgnoredResourcesService.js'
import type { IWorkingTreeFolderHint, IWorkingTreeHint } from '../ScmWorkingTreeHintService.js'
import { resolveRowDecoration } from '../rowDecoration.js'

describe('resolveRowDecoration', () => {
  it('prefers the SCM decoration outright, ignoring ignored and hint', () => {
    const deco: IScmDecoration = {
      color: '#c74e39',
      letter: 'D',
      strikeThrough: true,
      tooltip: 'Deleted',
    }
    const hint: IWorkingTreeHint = {
      color: '#111111',
      letter: 'A',
      strikeThrough: false,
      tooltip: 'on-disk change',
    }
    expect(resolveRowDecoration(deco, true, hint)).toStrictEqual({
      color: '#c74e39',
      letter: 'D',
      strikeThrough: true,
      tooltip: 'Deleted',
    })
  })

  it('keeps the decoration branch minimal: optional fields it lacks stay absent', () => {
    const deco: IScmDecoration = { color: '#e2c08d' }
    const hint: IWorkingTreeHint = {
      color: '#111111',
      letter: 'A',
      strikeThrough: true,
      tooltip: 'on-disk change',
    }
    // No letter / tooltip / strikeThrough leak in even though the hint has them.
    expect(resolveRowDecoration(deco, false, hint)).toStrictEqual({ color: '#e2c08d' })
  })

  it('dims an ignored resource and ignores a present hint', () => {
    const hint: IWorkingTreeHint = {
      color: '#111111',
      letter: 'A',
      strikeThrough: true,
      tooltip: 'on-disk change',
    }
    expect(resolveRowDecoration(undefined, true, hint)).toStrictEqual({
      color: IGNORED_RESOURCE_FOREGROUND,
    })
  })

  it('uses the hint when there is no decoration and the path is not ignored', () => {
    const hint: IWorkingTreeHint = {
      color: '#73c991',
      letter: 'A',
      strikeThrough: true,
      tooltip: 'opened elsewhere',
    }
    expect(resolveRowDecoration(undefined, false, hint)).toStrictEqual(hint)
  })

  it('omits optional hint fields that are absent (or falsy strikeThrough)', () => {
    const hint: IWorkingTreeHint = { color: '#73c991', letter: 'A' }
    expect(resolveRowDecoration(undefined, false, hint)).toStrictEqual({
      color: '#73c991',
      letter: 'A',
    })
  })

  it('shows only the colour for a folder hint — no letter badge', () => {
    const hint: IWorkingTreeFolderHint = { color: '#73c991' }
    expect(resolveRowDecoration(undefined, false, hint)).toStrictEqual({ color: '#73c991' })
  })

  it('returns an empty object (no keys) when there is nothing to show', () => {
    expect(resolveRowDecoration(undefined, false, undefined)).toStrictEqual({})
  })
})
