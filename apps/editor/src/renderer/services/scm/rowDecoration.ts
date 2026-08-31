/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Merges the three signals an Explorer row can carry a colour from — the SCM
 *  model's own decoration, "this path is ignored", and the on-demand working-tree
 *  hint — into the flat set of props the row component takes. Kept out of the view
 *  so the precedence between them is one testable table rather than a chain of
 *  `??` in JSX.
 *--------------------------------------------------------------------------------------------*/

import type { IScmDecoration } from './ScmDecorationsService.js'
import { IGNORED_RESOURCE_FOREGROUND } from './ScmIgnoredResourcesService.js'
import type { IWorkingTreeHint } from './ScmWorkingTreeHintService.js'

export interface IRowDecoration {
  readonly color?: string
  readonly letter?: string
  readonly strikeThrough?: boolean
  readonly tooltip?: string
}

const NONE: IRowDecoration = {}

export function resolveRowDecoration(
  deco: IScmDecoration | undefined,
  ignored: boolean,
  hint: IWorkingTreeHint | undefined,
): IRowDecoration {
  // Authoritative state wins outright. Once a file is in the SCM model its group
  // decoration is the truth; the hint only exists to fill the window before the
  // provider has discovered the file at all, and must never disagree with it.
  if (deco !== undefined) {
    return {
      color: deco.color,
      ...(deco.letter !== undefined ? { letter: deco.letter } : {}),
      ...(deco.strikeThrough ? { strikeThrough: true } : {}),
      ...(deco.tooltip !== undefined ? { tooltip: deco.tooltip } : {}),
    }
  }
  // Ignored is a decided answer too, and dimming ignored rows is long-standing
  // behaviour that a soft on-demand signal shouldn't be able to override.
  if (ignored) return { color: IGNORED_RESOURCE_FOREGROUND }
  if (hint === undefined) return NONE
  return {
    color: hint.color,
    letter: hint.letter,
    ...(hint.strikeThrough ? { strikeThrough: true } : {}),
    ...(hint.tooltip !== undefined ? { tooltip: hint.tooltip } : {}),
  }
}
