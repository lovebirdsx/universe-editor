/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Derives a ViewContainer's icon from its first view, falling back to the
 *  container's own icon. Keeps generated containers (and any container) showing
 *  the glyph of the view they currently hold, matching VSCode behaviour.
 *--------------------------------------------------------------------------------------------*/

import type { IViewContainerDescriptor, IViewDescriptorService } from '@universe-editor/platform'

export function resolveContainerIconName(
  container: IViewContainerDescriptor,
  viewDescriptors: IViewDescriptorService,
): string {
  return viewDescriptors.getViewsByContainer(container.id)[0]?.icon ?? container.icon
}
