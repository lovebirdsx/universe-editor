import { useCallback, useEffect } from 'react'
import { ILayoutService, PartId, LifecyclePhase } from '@universe-editor/platform'
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

interface WorkbenchProps {
  instantiation: InstantiationService
  lifecycle: LifecycleService
}

function WorkbenchShell() {
  useGlobalKeybindingHandler()

  const layoutService = useService(ILayoutService)
  const visible = useObservable(layoutService.visible)
  const sizes = useObservable(layoutService.sizes)
  const sidebarVisible = visible[PartId.SideBar]
  const secondarySidebarVisible = visible[PartId.SecondarySideBar]
  const panelVisible = visible[PartId.Panel]

  useEffect(() => {
    void layoutService.load()
  }, [layoutService])

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
        sizes={sizes}
        onSidebarResize={onSidebarResize}
        onSecondarySidebarResize={onSecondarySidebarResize}
        onPanelResize={onPanelResize}
        titlebar={<TitleBar />}
        activitybar={<ActivityBar />}
        sidebar={<SideBar />}
        secondarySidebar={<SecondarySideBar />}
        editor={<EditorArea />}
        panel={<Panel />}
        statusbar={<StatusBar />}
      />
      <QuickInputPortal />
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
