/*---------------------------------------------------------------------------------------------
 *  Locates the capturable body of one timeline message and waits for it to be
 *  laid out. The action temporarily expands a folded card first, so the body may
 *  mount a frame later; the user-message clamp is released through DOM
 *  attributes (its CSS keys off `data-collapsed`) without touching React state.
 *--------------------------------------------------------------------------------------------*/

import { findRowElement } from '@universe-editor/workbench-ui'

const BODY_TESTID = 'acp-collapsible-body'
const USER_BODY_TESTID = 'acp-user-message-body'
const POLL_INTERVAL_MS = 16
const DEFAULT_TIMEOUT_MS = 1500

/** The message body for `slotKey`, if the row and its expanded body are mounted. */
export function findSlotBody(container: HTMLElement, slotKey: string): HTMLElement | undefined {
  const row = findSlotRow(container, slotKey)
  if (row === null) return undefined
  return row.querySelector<HTMLElement>(`[data-testid="${BODY_TESTID}"]`) ?? undefined
}

/**
 * Polls until the body mounts and has a non-zero box. The row already exists
 * when the context menu was raised; a missing row means the card was unmounted
 * by virtualization or a session switch, so three misses end the wait early.
 */
export async function waitForSlotBody(
  container: HTMLElement,
  slotKey: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<HTMLElement | undefined> {
  if (!container.isConnected) return undefined
  const startedAt = Date.now()
  let missedRows = 0
  while (Date.now() - startedAt <= timeoutMs) {
    if (!container.isConnected) return undefined
    const row = findSlotRow(container, slotKey)
    if (row === null) {
      missedRows += 1
      if (missedRows >= 3) return undefined
    } else {
      missedRows = 0
      const body = row.querySelector<HTMLElement>(`[data-testid="${BODY_TESTID}"]`)
      if (body !== null) {
        const rect = body.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) return body
      }
    }
    await delay(POLL_INTERVAL_MS)
  }
  return undefined
}

/**
 * Releases the 160px clamp on collapsed user messages so the image carries the
 * full prompt. Returns a restore callback for the action's `finally`.
 */
export function expandCollapsedUserBodies(root: HTMLElement): () => void {
  const bodies = [
    ...root.querySelectorAll<HTMLElement>(
      `[data-testid="${USER_BODY_TESTID}"][data-collapsed="true"]`,
    ),
  ]
  for (const body of bodies) body.setAttribute('data-collapsed', 'false')
  return () => {
    for (const body of bodies) body.setAttribute('data-collapsed', 'true')
  }
}

function findSlotRow(container: HTMLElement, slotKey: string): HTMLElement | null {
  return (
    findRowElement(container, 'data-timeline-key', slotKey) ??
    findRowElement(container, 'data-sticky-key', slotKey)
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
