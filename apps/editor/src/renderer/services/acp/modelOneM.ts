/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure helpers for the `[1m]` (1M-context lane) suffix on Claude model ids.
 *
 *  The effective id in `settings.json` (`model` / `env.CLAUDE_CODE_SUBAGENT_MODEL`)
 *  is the single source of truth — nothing mirrors the pick elsewhere. So the lane
 *  is not a stored flag but a property of that string: `hasOneM` reads the
 *  checkbox state off it, `stripOneM` + `withOneM` recompose it when toggled.
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

/** The id with any trailing `[1m]` removed — the base a lane toggle recomposes
 *  from, so toggling on then off returns the original id rather than stacking or
 *  stranding the suffix. */
export function stripOneM(model: string): string {
  return model.trim().replace(/\[1m\]$/i, '')
}
