/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Agent-facing text for the "Send to Agent Chat" entries that offer a Perforce
 *  changelist or a Swarm review as context. Kept separate from the actions so
 *  the SCM/Graph/Swarm views (which each hold their own DTOs) compose the text
 *  through one place.
 *
 *  The perforce extension's own chat-context providers build the same strings
 *  for the `#` picker (extensions/perforce/src/chatContext.ts) — an extension
 *  cannot import renderer code, so the templates exist on both sides; each side
 *  has a test pinning its shape.
 *--------------------------------------------------------------------------------------------*/

/** First non-empty line of a description, trimmed (changelists and reviews both
 *  carry multi-line descriptions whose first line is the summary). */
export function descriptionFirstLine(description: string): string {
  for (const line of description.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ''
}

/** `Perforce changelist 1234: fix the parser` (id + description first line). */
export function formatChangelistText(id: string, description: string): string {
  const summary = descriptionFirstLine(description)
  return summary ? `Perforce changelist ${id}: ${summary}` : `Perforce changelist ${id}`
}

/** `Swarm review 1001 "fix the parser": Needs Review — <review url>` */
export function formatSwarmReviewText(review: {
  readonly id: string
  readonly description: string
  readonly stateLabel: string
  readonly url: string | undefined
}): string {
  const summary = descriptionFirstLine(review.description)
  const head = summary ? `Swarm review ${review.id} "${summary}"` : `Swarm review ${review.id}`
  const detail = [review.stateLabel.trim(), review.url ?? ''].filter((part) => part !== '')
  return detail.length > 0 ? `${head}: ${detail.join(' — ')}` : head
}
