/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Concrete Part classes for the six workbench regions.
 *
 *  Each class is a thin subclass of `Part` that fixes the id + ARIA role.
 *  All behavior (container management, visibility observable, focus dispatch)
 *  lives on the base class.
 *--------------------------------------------------------------------------------------------*/

import { ILayoutService, Part, PartId } from '@universe-editor/platform'

export class ActivityBarPart extends Part {
  constructor(@ILayoutService layoutService: ILayoutService) {
    super(PartId.ActivityBar, 'navigation', layoutService)
  }
}

export class SideBarPart extends Part {
  constructor(@ILayoutService layoutService: ILayoutService) {
    super(PartId.SideBar, 'complementary', layoutService)
  }
}

export class SecondarySideBarPart extends Part {
  constructor(@ILayoutService layoutService: ILayoutService) {
    super(PartId.SecondarySideBar, 'complementary', layoutService)
  }
}

export class EditorAreaPart extends Part {
  constructor(@ILayoutService layoutService: ILayoutService) {
    super(PartId.EditorArea, 'main', layoutService)
  }
}

export class PanelPart extends Part {
  constructor(@ILayoutService layoutService: ILayoutService) {
    super(PartId.Panel, 'region', layoutService)
  }
}

export class StatusBarPart extends Part {
  constructor(@ILayoutService layoutService: ILayoutService) {
    super(PartId.StatusBar, 'status', layoutService)
  }
}

export const ALL_PART_CTORS = [
  ActivityBarPart,
  SideBarPart,
  SecondarySideBarPart,
  EditorAreaPart,
  PanelPart,
  StatusBarPart,
] as const
