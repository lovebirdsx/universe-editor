import { useCallback, useEffect } from 'react'
import { IDialogService, ILayoutService, PartId, LifecyclePhase } from '@universe-editor/platform'
import type { LifecycleService, InstantiationService, LayoutSizes } from '@universe-editor/platform'
import { ServicesContext, useService, useObservable } from './useService.js'
import { useGlobalKeybindingHandler } from './useGlobalKeybindingHandler.js'
import { WorkbenchLayout } from './layout/WorkbenchLayout.js'
import { TitleBar } from './titlebar/TitleBar.js'
import { ActivityBar } from './activitybar/ActivityBar.js'
import { SideBar } from './sidebar/SideBar.js'
import { SecondarySideBar } from './sidebar/SecondarySideBar.js'
import { EditorArea } from './editor/EditorArea.js'
import { Panel } from './panel/Panel.js'
import { StatusBar } from './statusbar/StatusBar.js'
import { QuickInputPortal } from './quickinput/QuickInput.js'
import { DialogHost, type RendererDialogService } from './dialog/RendererDialogService.js'

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
        activitybarVisible={activityBarVisible}
        sizes={sizes}
        onSidebarResize={onSidebarResize}
        onSecondarySidebarResize={onSecondarySidebarResize}
        onPanelResize={onPanelResize}
        titlebar={<TitleBar />}
        activitybar={<ActivityBar part={activityBarPart} />}
        sidebar={<SideBar part={sideBarPart} />}
        secondarySidebar={<SecondarySideBar part={secondarySideBarPart} />}
        editor={<EditorArea part={editorAreaPart} />}
        panel={<Panel part={panelPart} />}
        statusbar={<StatusBar part={statusBarPart} />}
      />
      <QuickInputPortal />
      <DialogHost service={dialogService} />
    </>
  )
}

export function Workbench({ instantiation, lifecycle }: WorkbenchProps) {
  useEffect(() => {
    lifecycle.setPhase(LifecyclePhase.Restored)
    const id = requestIdleCallback(() => lifecycle.setPhase(LifecyclePhase.Eventually))
    return () => cancelIdleCallback(id)
  }, [lifecycle])

  return (
    <ServicesContext.Provider value={instantiation}>
      <WorkbenchShell />
    </ServicesContext.Provider>
  )
}
