/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Breadcrumbs — thin mount point above a FileEditor. The bar itself reads the
 *  outline of ITS OWN editor group (IOutlineService.forGroup): in a split view
 *  each group follows its own active editor, so a background group must not
 *  mirror the focused one.
 *--------------------------------------------------------------------------------------------*/

import type { EditorInput } from '@universe-editor/platform'
import { BreadcrumbsBar } from './breadcrumbs/BreadcrumbsBar.js'

export function Breadcrumbs({ input }: { input: EditorInput }) {
  return <BreadcrumbsBar input={input} />
}
