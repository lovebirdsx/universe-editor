/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Parses the icon-reference syntax extensions write in manifests (`$(files)`,
 *  `files`, `$(sync~spin)`) into the bare id + optional modifier the renderers
 *  consume. Anything that is not a whole-string icon reference — notably file
 *  paths — is rejected so callers can fall back instead of rendering an empty
 *  glyph.
 *--------------------------------------------------------------------------------------------*/

const WRAPPED_RE = /^\$\(([A-Za-z0-9-]+)(~[A-Za-z]+)?\)$/
const BARE_RE = /^([A-Za-z0-9-]+)(~[A-Za-z]+)?$/

export interface IconReference {
  readonly id: string
  readonly modifier?: string
}

export function parseIconReference(value: string): IconReference | undefined {
  const match = WRAPPED_RE.exec(value) ?? BARE_RE.exec(value)
  if (match === null) return undefined
  const id = match[1]
  if (id === undefined) return undefined
  const modifier = match[2]?.slice(1)
  return modifier === undefined ? { id } : { id, modifier }
}

/** Strips the `$(…)` wrapper; anything unrecognised is returned untouched. */
export function normalizeIconReference(value: string): string {
  const reference = parseIconReference(value)
  if (reference === undefined) return value
  return reference.modifier === undefined ? reference.id : `${reference.id}~${reference.modifier}`
}
