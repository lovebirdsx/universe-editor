/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  cloneEditorInputForSplit — produce a fresh EditorInput instance for a split.
 *
 *  A split/copy must NOT share the same input instance across two groups:
 *  closing a tab disposes the input via its group's editor store, which would
 *  tear down the still-open copy in the other group. Serializing + deserializing
 *  yields an independent instance with the same identity (resource-derived `id`),
 *  so the two groups own separate lifetimes while still referring to the same
 *  resource/model.
 *
 *  Inputs that cannot round-trip through the editor registry return `undefined`
 *  instead of falling back to the original instance. Callers must pre-check
 *  (commands: disable/refuse before creating the target group/window) and never
 *  copy the original instance into a second group.
 *--------------------------------------------------------------------------------------------*/

import { type EditorInput, EditorRegistry, type ServicesAccessor } from '@universe-editor/platform'

/**
 * Whether a split copy can be produced without sharing the input instance.
 * Cheap pre-check for commands/menus: it only inspects the type registration,
 * not the input's current data (a `serialize()` that yields nothing, or a
 * `deserialize` that rejects the snapshot, can still make cloning fail).
 */
export function canCloneEditorInputForSplit(input: EditorInput): boolean {
  if (typeof input.serialize !== 'function') return false
  return EditorRegistry.getProvider(input.typeId)?.deserialize !== undefined
}

/**
 * Clone `input` for a split/copy. Returns `undefined` when the input is not
 * safely copyable; the caller must then leave the source untouched (do not
 * create the split target).
 */
export function cloneEditorInputForSplit(
  input: EditorInput,
  accessor: ServicesAccessor,
): EditorInput | undefined {
  if (!canCloneEditorInputForSplit(input)) return undefined
  let serialized: unknown
  try {
    serialized = input.serialize?.()
  } catch {
    return undefined
  }
  if (serialized === undefined) return undefined
  return EditorRegistry.deserialize(input.typeId, serialized, accessor) ?? undefined
}
