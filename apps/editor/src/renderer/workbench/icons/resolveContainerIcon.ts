/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Derives a ViewContainer's icon. VSCode semantics: while the container still
 *  holds a view that lives there by default, the container's own icon wins —
 *  otherwise any extension view could repaint Explorer's activity-bar glyph.
 *  Only a container made up entirely of views dragged in from elsewhere (the
 *  runtime-generated "Custom Views" containers) borrows its first view's icon.
 *--------------------------------------------------------------------------------------------*/

import type { IViewContainerDescriptor, IViewDescriptorService } from '@universe-editor/platform'

export function resolveContainerIconName(
  container: IViewContainerDescriptor,
  viewDescriptors: IViewDescriptorService,
): string {
  const views = viewDescriptors.getViewsByContainer(container.id)
  const usesContainerInfo =
    views.length === 0 || views.some((view) => view.containerId === container.id)
  return usesContainerInfo ? container.icon : (views[0]?.icon ?? container.icon)
}
