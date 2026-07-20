/**
 * 复现：打开一个"底栏(Panel)默认可见"的工作区时崩溃。
 *
 * TypeError: Cannot read properties of undefined (reading 'minimumSize')
 *   at SplitView.resizeViews (allotment)
 *
 * 真实时序：恢复工作区时 reconcile 把 panelVisible 翻成 true 并写入保存的
 * sizes.panel。sizes.panel 变化触发 WorkbenchLayout 里针对 panel 的 resize
 * effect。但嵌套的纵向 Allotment(editor + panel)是惰性初始化的——只有等它
 * 自己的 ResizeObserver 首次报出非零尺寸后才会填充 viewItems，这发生在外层
 * 横向 Allotment 布局之后。若 effect 在纵向 Allotment 还没 fire 过 onChange
 * 时就调用 verticalAllotment.resize([editor, panel])，allotment 内部
 * SplitView.resizeViews 会用 2 个尺寸去索引空的 viewItems 数组，读到
 * undefined.minimumSize 而崩溃。
 *
 * 旧代码的两个漏洞：
 *   1. 守卫用的是"横向" isInitializedRef，不代表纵向已就绪；
 *   2. currentVerticalRef 被种成 [0, sizes.panel]，使 total<=0 守卫失效。
 *
 * 修复：新增独立的 isVerticalInitializedRef(在纵向 onChange 里置位)，并把
 * currentVerticalRef 种子改为 [0, 0]。
 */

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { LayoutSizes } from '@universe-editor/platform'
import { WorkbenchLayout } from '../WorkbenchLayout.js'

vi.mock('allotment/dist/style.css', () => ({}))

const captured = vi.hoisted(() => ({
  horizontalOnChange: undefined as ((s: (number | undefined)[]) => void) | undefined,
  verticalOnChange: undefined as ((s: (number | undefined)[]) => void) | undefined,
  // 模拟 allotment SplitView.resizeViews 的崩溃：纵向 Allotment 还没 fire 过
  // onChange 时 viewItems 为空，此时被调用即视为触发了会崩溃的路径。
  verticalHasLaidOut: false,
  verticalResize: vi.fn<(sizes: number[]) => void>(),
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
      resize: (sizes: number[]) => {
        if (vertical) {
          if (!captured.verticalHasLaidOut) {
            // 复刻真实崩溃：对未初始化(空 viewItems)的纵向 SplitView resize。
            throw new TypeError("Cannot read properties of undefined (reading 'minimumSize')")
          }
          captured.verticalResize(sizes)
        }
      },
    }))
    if (vertical) captured.verticalOnChange = onChange
    else captured.horizontalOnChange = onChange
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

  return { Allotment }
})

afterEach(() => {
  cleanup()
  captured.horizontalOnChange = undefined
  captured.verticalOnChange = undefined
  captured.verticalHasLaidOut = false
  captured.verticalResize.mockClear()
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

describe('WorkbenchLayout – panel restore crash', () => {
  it('does not resize the vertical Allotment before it has laid out (workspace with panel visible on restore)', () => {
    // 恢复场景：sizes.panel 是保存值 300，panel 初始隐藏。
    const sizes: LayoutSizes = { sidebar: 240, secondarySidebar: 300, panel: 300 }
    const { rerender } = render(<WorkbenchLayout {...makeProps(sizes, { panelVisible: false })} />)

    // 横向 Allotment 先完成初始化(拿到真实尺寸)。
    captured.horizontalOnChange?.([240, 760, 0])

    // reconcile：panel 翻可见，sizes.panel 从默认变为保存值 → 触发 panel resize effect。
    // 此刻纵向 Allotment 尚未 fire 过 onChange(viewItems 为空)。
    expect(() =>
      rerender(
        <WorkbenchLayout {...makeProps({ ...sizes, panel: 350 }, { panelVisible: true })} />,
      ),
    ).not.toThrow()

    // 修复后不应在纵向未就绪时调用它的 resize。
    expect(captured.verticalResize).not.toHaveBeenCalled()
  })

  it('resizes the vertical Allotment once it has laid out and sizes.panel changes', () => {
    captured.verticalHasLaidOut = true
    const sizes: LayoutSizes = { sidebar: 240, secondarySidebar: 300, panel: 200 }
    const { rerender } = render(<WorkbenchLayout {...makeProps(sizes, { panelVisible: true })} />)

    captured.horizontalOnChange?.([240, 760, 0])
    // 纵向 Allotment 完成布局：editor=500, panel=200，total=700。
    captured.verticalOnChange?.([500, 200])

    // 程序化改变 panel 尺寸(如键盘调整)→ 应对纵向 Allotment 施加 resize。
    rerender(<WorkbenchLayout {...makeProps({ ...sizes, panel: 300 }, { panelVisible: true })} />)

    expect(captured.verticalResize).toHaveBeenCalledWith([400, 300])
  })
})
