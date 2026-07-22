/**
 * 守护 sidebar / secondary sidebar 的持久化语义（VSCode 对齐）：
 *
 * - onChange 报告的瞬态布局帧（容器缩放、启动沉降、程序性纠正）绝不持久化 ——
 *   否则「最大化状态重启」的启动竞态会把被挤到 minSize 的二级侧栏宽度写回存储。
 * - 只有用户拖拽 sash 结束（onDragEnd）才写回宽度。
 * - 初始化 resize 的目标从 ref 现读（Allotment 构造时捕获的闭包可能滞后于
 *   reconcile），二级侧栏已可见时必须还原其持久化宽度而非 0。
 */

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { LayoutSizes } from '@universe-editor/platform'
import { WorkbenchLayout } from '../WorkbenchLayout.js'

vi.mock('allotment/dist/style.css', () => ({}))

const captured = vi.hoisted(() => ({
  horizontalOnChange: undefined as ((s: (number | undefined)[]) => void) | undefined,
  horizontalOnDragEnd: undefined as ((s: (number | undefined)[]) => void) | undefined,
  horizontalResize: undefined as ReturnType<typeof vi.fn> | undefined,
}))

vi.mock('allotment', () => {
  const resizeMock = vi.fn()
  const Allotment = ({
    children,
    onChange,
    onDragEnd,
    vertical,
    ref,
  }: {
    children?: React.ReactNode
    onChange?: (s: (number | undefined)[]) => void
    onDragEnd?: (s: (number | undefined)[]) => void
    vertical?: boolean
    proportionalLayout?: boolean
    ref?: React.Ref<unknown>
  }) => {
    if (!vertical) {
      captured.horizontalOnChange = onChange
      captured.horizontalOnDragEnd = onDragEnd
      captured.horizontalResize = resizeMock
      if (ref && typeof ref === 'object')
        (ref as { current: unknown }).current = { resize: resizeMock }
    }
    return React.createElement(
      'div',
      { 'data-allotment': vertical ? 'vertical' : 'horizontal' },
      children,
    )
  }

  Allotment.Pane = ({
    children,
    visible,
  }: {
    children?: React.ReactNode
    visible?: boolean
    minSize?: number
    maxSize?: number
    preferredSize?: number | string
    priority?: string
  }) => (visible === false ? null : React.createElement('div', null, children))

  return { Allotment, LayoutPriority: { Normal: 'NORMAL', Low: 'LOW', High: 'HIGH' } }
})

afterEach(() => {
  cleanup()
  captured.horizontalOnChange = undefined
  captured.horizontalOnDragEnd = undefined
  captured.horizontalResize?.mockClear()
})

const DEFAULT_SIZES: LayoutSizes = { sidebar: 240, secondarySidebar: 320, panel: 200 }

function makeProps(
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
    secondarySidebarVisible: true,
    panelVisible: false,
    panelMaximized: false,
    activitybarVisible: true,
    sizes: DEFAULT_SIZES,
    onSidebarResize: vi.fn(),
    onSecondarySidebarResize: vi.fn(),
    onPanelResize: vi.fn(),
    ...overrides,
  }
}

function initializeHorizontal() {
  // 首个非零 onChange 让 isInitializedRef 置真（其自身走初始化分支不持久化）。
  captured.horizontalOnChange?.([240, 1312, 320])
}

describe('WorkbenchLayout – sidebar width persistence semantics', () => {
  it('does NOT persist widths from onChange frames (container resize / settling)', async () => {
    const onSidebarResize = vi.fn()
    const onSecondarySidebarResize = vi.fn()
    render(<WorkbenchLayout {...makeProps({ onSidebarResize, onSecondarySidebarResize })} />)

    initializeHorizontal()
    await Promise.resolve()

    // 模拟最大化/启动沉降产生的瞬态帧：secondary 被挤到 minSize。
    captured.horizontalOnChange?.([240, 1462, 170])
    captured.horizontalOnChange?.([936, 766, 170])

    expect(onSidebarResize).not.toHaveBeenCalled()
    expect(onSecondarySidebarResize).not.toHaveBeenCalled()
  })

  it('persists widths when a sash drag ends', () => {
    const onSidebarResize = vi.fn()
    const onSecondarySidebarResize = vi.fn()
    render(<WorkbenchLayout {...makeProps({ onSidebarResize, onSecondarySidebarResize })} />)

    initializeHorizontal()
    captured.horizontalOnDragEnd?.([260, 1252, 360])

    expect(onSidebarResize).toHaveBeenCalledWith(260)
    expect(onSecondarySidebarResize).toHaveBeenCalledWith(360)
  })

  it('does not persist a hidden pane width on drag end', () => {
    const onSecondarySidebarResize = vi.fn()
    render(
      <WorkbenchLayout
        {...makeProps({ onSecondarySidebarResize, secondarySidebarVisible: false })}
      />,
    )

    initializeHorizontal()
    captured.horizontalOnDragEnd?.([260, 1612, 0])

    expect(onSecondarySidebarResize).not.toHaveBeenCalled()
  })

  it('initial resize targets the reconciled visibility/sizes read via refs, not the mount closure', async () => {
    // 挂载时二级侧栏隐藏（默认布局），随后 reconcile 翻转可见 + 落地持久化尺寸 ——
    // 之后才来第一个非零 onChange（其闭包捕获的还是旧 props）。
    const { rerender } = render(
      <WorkbenchLayout {...makeProps({ secondarySidebarVisible: false })} />,
    )
    const staleOnChange = captured.horizontalOnChange

    rerender(<WorkbenchLayout {...makeProps({ secondarySidebarVisible: true })} />)

    // 用挂载时捕获的（过期）闭包触发初始化，模拟 Allotment 的滞后回调。
    staleOnChange?.([936, 766, 170])
    await Promise.resolve()

    // 初始化 resize 必须以「二级侧栏可见 @ 320」为目标，而不是 0。
    expect(captured.horizontalResize).toHaveBeenCalledWith([240, 1872 - 240 - 320, 320])
  })
})
