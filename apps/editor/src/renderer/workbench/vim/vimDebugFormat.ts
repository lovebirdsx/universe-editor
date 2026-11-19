/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Vim dispatch trace lines. Kept separate from the keyboard-debug formatter so
 *  the Vim grammar can evolve without touching the global dispatcher's output.
 *  Only formatted while `IKeyboardDebugService.enabled` is true.
 *--------------------------------------------------------------------------------------------*/

export interface VimTraceContext {
  readonly surface: string
  readonly surfaceId: string
  readonly mode: string
}

function prefix(context: VimTraceContext): string {
  return `→ vim surface=${context.surface}(${context.surfaceId}) mode=${context.mode}`
}

export function formatVimSurface(context: VimTraceContext): string {
  return prefix(context)
}

export function formatVimPending(context: VimTraceContext, keys: readonly string[]): string {
  return `${prefix(context)} / sequence pending [${keys.join(' ')}]`
}

export function formatVimExecute(context: VimTraceContext, command: string, count: number): string {
  return `${prefix(context)} / EXECUTE ${command}(${count})`
}

export function formatVimUserShadow(context: VimTraceContext, command: string): string {
  return `${prefix(context)} / ⤫ user binding shadows Vim — ${command}`
}

export function formatVimPassThrough(context: VimTraceContext, reason: string): string {
  return `${prefix(context)} / ⤫ ${reason}`
}
