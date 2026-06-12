import { useCallback, useEffect } from 'react'
import {
  IDialogService,
  ILayoutService,
  PartId,
  LifecyclePhase,
  mark,
} from '@universe-editor/platform'
import type { LifecycleService, InstantiationService, LayoutSizes } from '@universe-editor/platform'
import { PerfMarks } from '../../shared/perf/marks.js'
import { ServicesContext, useService, useObservable } from './useService.js'
import { useGlobalKeybindingHandler } from './useGlobalKeybindingHandler.js'
import { WorkbenchLayout } from './layout/WorkbenchLayout.js'
import { TitleBar } from './titlebar/TitleBar.js'
import { ActivityBar } from './activitybar/ActivityBar.js'
import { PaneCompositePart } from './paneComposite/PaneCompositePart.js'
import {
  sideBarConfig,
  secondarySideBarConfig,
  panelConfig,
} from './paneComposite/paneCompositeConfigs.js'
import { EditorArea } from './editor/EditorArea.js'
import { StatusBar } from './statusbar/StatusBar.js'
import { QuickInputPortal } from './quickinput/QuickInput.js'
import { DialogHost } from './dialog/DialogHost.js'
import type { RendererDialogService } from '../services/dialog/RendererDialogService.js'
import { NotificationsToast } from './notification/NotificationsToast.js'
import { NotificationsCenter } from './notification/NotificationsCenter.js'
import { ProgressDialogHost } from './progress/ProgressDialogHost.js'

interface WorkbenchProps {
  instantiation: InstantiationService
  lifecycle: LifecycleService
}

function WorkbenchShell() {
  useGlobalKeybindingHandler()

  const layoutService = useService(ILayoutService)
  const dialogService = useService(IDialogService) as RendererDialogService
  const visible = useObservable(layoutService.visible)
  const sizes = useObservable(layoutService.sizes)
  const panelMaximized = useObservable(layoutService.panelMaximized)
  const sidebarVisible = visible[PartId.SideBar]
  const secondarySidebarVisible = visible[PartId.SecondarySideBar]
  const panelVisible = visible[PartId.Panel]
  const activityBarVisible = visible[PartId.ActivityBar]

  // Look up Parts registered by main.tsx's bootstrap. Parts are singletons —
  // they live for the lifetime of the workbench, so this lookup happens once.
  const activityBarPart = layoutService.getPart(PartId.ActivityBar)
  const sideBarPart = layoutService.getPart(PartId.SideBar)
  const secondarySideBarPart = layoutService.getPart(PartId.SecondarySideBar)
  const editorAreaPart = layoutService.getPart(PartId.EditorArea)
  const panelPart = layoutService.getPart(PartId.Panel)
  const statusBarPart = layoutService.getPart(PartId.StatusBar)

  const onSidebarResize = useCallback(
    (px: number) => layoutService.setSize('sidebar' satisfies keyof LayoutSizes, px),
    [layoutService],
  )
  const onSecondarySidebarResize = useCallback(
    (px: number) => layoutService.setSize('secondarySidebar' satisfies keyof LayoutSizes, px),
    [layoutService],
  )
  const onPanelResize = useCallback(
    (px: number) => layoutService.setSize('panel' satisfies keyof LayoutSizes, px),
    [layoutService],
  )

  return (
    <>
      <WorkbenchLayout
        sidebarVisible={sidebarVisible}
        secondarySidebarVisible={secondarySidebarVisible}
        panelVisible={panelVisible}
        panelMaximized={panelMaximized}
        activitybarVisible={activityBarVisible}
        sizes={sizes}
        onSidebarResize={onSidebarResize}
        onSecondarySidebarResize={onSecondarySidebarResize}
        onPanelResize={onPanelResize}
        titlebar={<TitleBar />}
        activitybar={<ActivityBar part={activityBarPart} />}
        sidebar={<PaneCompositePart part={sideBarPart} config={sideBarConfig} />}
        secondarySidebar={
          <PaneCompositePart part={secondarySideBarPart} config={secondarySideBarConfig} />
        }
        editor={<EditorArea part={editorAreaPart} />}
        panel={<PaneCompositePart part={panelPart} config={panelConfig} />}
        statusbar={<StatusBar part={statusBarPart} />}
      />
      <QuickInputPortal />
      <DialogHost service={dialogService} />
      <NotificationsToast />
      <NotificationsCenter />
      <ProgressDialogHost />
    </>
  )
}

export function Workbench({ instantiation, lifecycle }: WorkbenchProps) {
  useEffect(() => {
    lifecycle.setPhase(LifecyclePhase.Restored)
    mark(PerfMarks.rendererDidRestoreEditors)
    const id = requestIdleCallback(() => lifecycle.setPhase(LifecyclePhase.Eventually))
    return () => cancelIdleCallback(id)
  }, [lifecycle])

  return (
    <ServicesContext.Provider value={instantiation}>
      <WorkbenchShell />
    </ServicesContext.Provider>
  )
}
