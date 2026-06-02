import { PartId, type ILayoutService, type IViewsService } from '@universe-editor/platform'

export const OUTPUT_VIEW_CONTAINER_ID = 'workbench.view.output'

export function revealOutputPanel(
  layoutService: ILayoutService,
  viewsService: IViewsService,
): void {
  viewsService.openViewContainer(OUTPUT_VIEW_CONTAINER_ID)
  layoutService.setVisible(PartId.Panel, true)
  layoutService.getPart(PartId.Panel)?.focus()
}
