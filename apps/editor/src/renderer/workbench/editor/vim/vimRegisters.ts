/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  A single unnamed register. Vim's named/macro registers are out of scope for
 *  the first version; yank and delete both write here, paste reads it.
 *--------------------------------------------------------------------------------------------*/

export interface VimRegisterContent {
  readonly text: string
  readonly linewise: boolean
}

let content: VimRegisterContent | null = null

export function getVimRegister(): VimRegisterContent | null {
  return content
}

export function setVimRegister(next: VimRegisterContent): void {
  content = next
}

export function resetVimRegisterForTests(): void {
  content = null
}
