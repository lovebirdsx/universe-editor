/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  cloneEditorInputForSplit — produce a fresh EditorInput instance for a split.
 *
 *  A split must NOT share the same input instance across two groups: closing a
 *  tab disposes the input via its group's editor store, which would tear down
 *  the still-open copy in the other group. Serializing + deserializing yields an
 *  independent instance with the same identity (resource-derived `id`), so the
 *  two groups own separate lifetimes while still referring to the same resource.
 *--------------------------------------------------------------------------------------------*/

import { type EditorInput, EditorRegistry, type ServicesAccessor } from '@universe-editor/platform'

export function cloneEditorInputForSplit(
  input: EditorInput,
  accessor: ServicesAccessor,
): EditorInput {
  const serialized = input.serialize?.()
  if (serialized === undefined) return input
  return EditorRegistry.deserialize(input.typeId, serialized, accessor) ?? input
}
