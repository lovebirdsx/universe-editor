/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  lineDiff — minimal line-level diff for ACP inline previews. Uses a classic
 *  LCS DP; chat diffs are tiny so the O(m*n) memory cost is fine.
 *--------------------------------------------------------------------------------------------*/

export type DiffLineKind = 'add' | 'del' | 'ctx'

export interface DiffLine {
  readonly kind: DiffLineKind
  readonly text: string
}

function splitLines(s: string): string[] {
  if (s.length === 0) return []
  const lines = s.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function computeLineDiff(oldText: string, newText: string): readonly DiffLine[] {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  const m = a.length
  const n = b.length

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ kind: 'ctx', text: a[i]! })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: 'del', text: a[i]! })
      i++
    } else {
      out.push({ kind: 'add', text: b[j]! })
      j++
    }
  }
  while (i < m) out.push({ kind: 'del', text: a[i++]! })
  while (j < n) out.push({ kind: 'add', text: b[j++]! })
  return out
}
