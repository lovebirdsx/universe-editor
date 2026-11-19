/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  The ViewContainer header tab strips live inside React and are reached by the
 *  `workbench.action.focusViewContainerTabs` command without a DI handle. Each
 *  tabs-mode header publishes a focus callback here (keyed by location); the
 *  command picks the part that currently owns focus, falling back to the first
 *  visible tabs header.
 *--------------------------------------------------------------------------------------------*/

import type { ViewContainerLocation } from '@universe-editor/platform'

type FocusCallback = () => boolean

const targets = new Map<ViewContainerLocation, FocusCallback>()

export function registerViewContainerTabsFocus(
  location: ViewContainerLocation,
  focus: FocusCallback,
): { dispose(): void } {
  targets.set(location, focus)
  return {
    dispose: () => {
      if (targets.get(location) === focus) targets.delete(location)
    },
  }
}

export function focusViewContainerTabsArea(location: ViewContainerLocation): boolean {
  return targets.get(location)?.() === true
}
