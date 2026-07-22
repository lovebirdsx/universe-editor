/**
 * 复现：底栏（Panel）尺寸在工作区恢复时丢失。
 *
 * 真实时序：Panel 默认隐藏，恢复工作区时 reconcile 把它翻成可见 + sizes.panel=保存值。
 * Panel 由隐藏→可见触发 panelJustShown 分支。此时纵向 Allotment 的
 * distributeEmptySpace 会贪婪地把空间给 editor pane，忽略 panel 的 preferredSize，
 * 于是 Allotment 报告的 panel 尺寸是错的（被挤到最小）。旧代码把这个错误尺寸
 * 直接持久化，且从不强制重放保存值 → 底栏高度恢复失败。
 *
 * 对照横向 Allotment（sidebar/secondary）首帧 onChange 会 queueMicrotask(resize) 重放
 * initialSizesRef 的保存值，故侧边栏不受影响。
 */

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { LayoutSizes } from '@universe-editor/platform'
import { WorkbenchLayout } from '../WorkbenchLayout.js'

vi.mock('allotment/dist/style.css', () => ({}))

const captured = vi.hoisted(() => ({
  verticalOnChange: undefined as ((s: (number | undefined)[]) => void) | undefined,
  verticalResize: vi.fn<(sizes: number[]) => void>(),
  horizontalResize: vi.fn<(sizes: number[]) => void>(),
}))

vi.mock('allotment', () => {
  const Allotment = React.forwardRef(function Allotment(
    {
      children,
      onChange,
      vertical,
    }: {
      children?: React.ReactNode
      onChange?: (s: (number | undefined)[]) => void
      vertical?: boolean
    },
    ref: React.Ref<unknown>,
  ) {
    React.useImperativeHandle(ref, () => ({
      resize: vertical ? captured.verticalResize : captured.horizontalResize,
    }))
    if (vertical) captured.verticalOnChange = onChange
    return React.createElement(
      'div',
      { 'data-allotment': vertical ? 'vertical' : 'horizontal' },
      children,
    )
  })

  ;(
    Allotment as unknown as { Pane: React.FC<{ children?: React.ReactNode; visible?: boolean }> }
  ).Pane = ({ children, visible }) =>
    visible === false ? null : React.createElement('div', null, children)

  return { Allotment, LayoutPriority: { Normal: 'NORMAL', Low: 'LOW', High: 'HIGH' } }
})

afterEach(() => {
  cleanup()
  captured.verticalOnChange = undefined
  captured.verticalResize.mockClear()
  captured.horizontalResize.mockClear()
})

function makeProps(
  sizes: LayoutSizes,
  overrides?: Partial<React.ComponentProps<typeof WorkbenchLayout>>,
): React.ComponentProps<typeof WorkbenchLayout> {
  return {
    titlebar: null,
    activitybar: null,
    sidebar: null,
    secondarySidebar: null,
    editor: null,
    panel: null,
    statusbar: null,
    sidebarVisible: true,
    secondarySidebarVisible: false,
    panelVisible: false,
    panelMaximized: false,
    activitybarVisible: true,
    sizes,
    onSidebarResize: vi.fn(),
    onSecondarySidebarResize: vi.fn(),
    onPanelResize: vi.fn(),
    ...overrides,
  }
}

describe('WorkbenchLayout – panel size restore', () => {
  it('restores the saved panel height when the panel is revealed on restore, even if Allotment greedily mis-distributes', () => {
    const onPanelResize = vi.fn()
    const rafCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb)
      return 0
    })

    // 恢复场景：sizes.panel 已是保存值 400，panel 初始隐藏。
    const sizes: LayoutSizes = { sidebar: 240, secondarySidebar: 300, panel: 400 }
    const { rerender } = render(
      <WorkbenchLayout {...makeProps(sizes, { onPanelResize, panelVisible: false })} />,
    )

    // reconcile 把 panel 翻成可见（sizes.panel 仍是 400）。
    rerender(<WorkbenchLayout {...makeProps(sizes, { onPanelResize, panelVisible: true })} />)

    // Allotment 首次布局贪婪地把空间给 editor(650)，panel 被挤到 50（错误）。total=700。
    captured.verticalOnChange?.([650, 50])

    // 首帧不应把错误的 50 持久化。
    expect(onPanelResize).not.toHaveBeenCalledWith(50)

    // 下一帧应强制重放保存值：resize([editor=300, panel=400])。
    rafCallbacks.forEach((cb) => cb(0))
    expect(captured.verticalResize).toHaveBeenCalledWith([300, 400])

    vi.unstubAllGlobals()
  })
})
