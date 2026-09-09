import { PartId, type ILayoutService, type IViewsService } from '@universe-editor/platform'

export const OUTPUT_VIEW_CONTAINER_ID = 'workbench.view.output'
export const OUTPUT_VIEW_ID = 'workbench.view.output.main'

// Reveal the panel and hand keyboard focus to the Output view itself — the
// view's registered focusable is the Monaco textarea, so this lands cursor /
// selection keys in the log editor without a click (VSCode's toggleOutput
// focuses the Output editor the same way).
export function revealOutputPanel(
  layoutService: ILayoutService,
  viewsService: IViewsService,
): void {
  viewsService.openViewContainer(OUTPUT_VIEW_CONTAINER_ID)
  layoutService.setVisible(PartId.Panel, true)
  void layoutService.focusView(OUTPUT_VIEW_ID)
}
