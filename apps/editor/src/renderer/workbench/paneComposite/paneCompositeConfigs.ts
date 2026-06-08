/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Static configuration for the three PaneCompositePart instances. Each entry
 *  captures how a location differs: which Part/registry it binds to, its header
 *  form, and its content form.
 *--------------------------------------------------------------------------------------------*/

import { PartId, ViewContainerLocation, localize } from '@universe-editor/platform'

export interface PaneCompositeConfig {
  partId: PartId
  location: ViewContainerLocation
  /** Test id on the root element. */
  testId: string
  /** Root element tag — sidebar/secondary use <aside>, panel uses <div>. */
  rootTag: 'aside' | 'div'
  /** Header form: text label (SideBar) vs icon tabs (Panel / Secondary). */
  header: 'label' | 'tabs'
  /** Content form: collapsible stack (SideBar / Secondary) vs kept-mounted tiles (Panel). */
  content: 'stack' | 'tiled'
  /** Expose data-active-view on the root (only SideBar needs it for explorer hover CSS). */
  exposeActiveView?: boolean
  /** Empty-state text for the stack content form. */
  emptyMessage?: string
}

export const sideBarConfig: PaneCompositeConfig = {
  partId: PartId.SideBar,
  location: ViewContainerLocation.SideBar,
  testId: 'part-sidebar',
  rootTag: 'aside',
  header: 'label',
  content: 'stack',
  exposeActiveView: true,
  emptyMessage: localize('sidebar.empty', 'No views registered.'),
}

export const secondarySideBarConfig: PaneCompositeConfig = {
  partId: PartId.SecondarySideBar,
  location: ViewContainerLocation.SecondarySideBar,
  testId: 'part-secondarysidebar',
  rootTag: 'aside',
  header: 'tabs',
  content: 'stack',
}

export const panelConfig: PaneCompositeConfig = {
  partId: PartId.Panel,
  location: ViewContainerLocation.Panel,
  testId: 'part-panel',
  rootTag: 'div',
  header: 'tabs',
  content: 'tiled',
}
