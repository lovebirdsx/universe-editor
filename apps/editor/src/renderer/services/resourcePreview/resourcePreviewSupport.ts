/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  resourcePreviewSupport — which files can be opened in a rendered preview.
 *  Single place every file list (explorer / SCM / session changes / graphs)
 *  asks before showing its hover "Open Preview" button. Keep in sync with the
 *  preview EditorInputs registered in BuiltInEditorProvidersContribution.
 *--------------------------------------------------------------------------------------------*/

import type { URI } from '@universe-editor/platform'
import { URI as Uri } from '@universe-editor/platform'
import { languageForResource } from '../../workbench/files/resourceLanguage.js'

export type PreviewLanguage = 'markdown' | 'html'

/** The preview flavor available for {@link resource}, if any. */
export function previewLanguageForResource(resource: URI): PreviewLanguage | undefined {
  const languageId = languageForResource(resource)
  if (languageId === 'markdown' || languageId === 'mdx') return 'markdown'
  if (languageId === 'html') return 'html'
  return undefined
}

export function isPreviewableResource(resource: URI): boolean {
  return previewLanguageForResource(resource) !== undefined
}

/**
 * Path-based variant for callers (git/perforce graph rows) that only carry a
 * repo-relative path, not a resolved URI. Only the basename matters for the
 * language lookup, so a plain file URI is enough.
 */
export function isPreviewablePath(path: string): boolean {
  return previewLanguageForResource(Uri.file(path)) !== undefined
}
