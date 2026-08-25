/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure helpers for the `[1m]` (1M-context lane) suffix on Claude model ids.
 *  Shared by the model / sub-agent model picks in the Authentication panel and by
 *  the session-level model candidate injection: the persisted pick stays bare
 *  while the composed id written to settings.json appends `[1m]` when the lane is
 *  enabled.
 *--------------------------------------------------------------------------------------------*/

/** Whether the model id already carries the 1M-context lane suffix (`claude-opus-5[1m]`). */
export function hasOneM(model: string): boolean {
  return /\[1m\]$/i.test(model.trim())
}

/** The effective id written to disk: append `[1m]` when enabled. Idempotent —
 *  an id that already carries the suffix is returned unchanged. Free-text input
 *  is trimmed before the suffix goes on, so `foo ` cannot become `foo [1m]`. */
export function withOneM(model: string, enabled: boolean): string {
  if (!enabled) return model
  const bare = model.trim()
  if (bare === '' || hasOneM(bare)) return model
  return `${bare}[1m]`
}
