/**
 * 复现 "ResizeObserver loop completed with undelivered notifications" 错误。
 *
 * 根本原因：打开 Panel 时，Allotment 内部的 ResizeObserver 触发 onChange，
 * onChange 同步调用 onPanelResize → 更新 sizes.panel → React 重渲染 →
 * preferredSize 变化 → Allotment 再次 layout → 形成一次循环，触发浏览器警告。
 *
 * 修复：panel 首次出现时，将 onPanelResize 延迟到 requestAnimationFrame，
 * 使其脱离 ResizeObserver 同步回调栈。
 */

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { LayoutSizes } from '@universe-editor/platform'
import { WorkbenchLayout } from '../WorkbenchLayout.js'

// ── allotment CSS 副作用（测试中不需要实际样式）─────────────────────────────
vi.mock('allotment/dist/style.css', () => ({}))

// ── 捕获垂直 Allotment 的 onChange 以模拟 ResizeObserver 触发场景 ─────────
const captured = vi.hoisted(() => ({
  verticalOnChange: undefined as ((s: (number | undefined)[]) => void) | undefined,
}))

vi.mock('allotment', () => {
  const Allotment = ({
    children,
    onChange,
    vertical,
  }: {
    children?: React.ReactNode
    onChange?: (s: (number | undefined)[]) => void
    vertical?: boolean
    proportionalLayout?: boolean
    ref?: React.Ref<unknown>
  }) => {
    if (vertical) captured.verticalOnChange = onChange
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
  }) => (visible === false ? null : React.createElement('div', null, children))

  return { Allotment }
})

afterEach(() => {
  cleanup()
  captured.verticalOnChange = undefined
})

const DEFAULT_SIZES: LayoutSizes = { sidebar: 200, secondarySidebar: 200, panel: 200 }

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
    secondarySidebarVisible: false,
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

describe('WorkbenchLayout – panel resize deferral', () => {
  it('does NOT call onPanelResize synchronously on the first onChange when panel opens', () => {
    const onPanelResize = vi.fn()
    const rafCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb)
      return 0
    })

    const { rerender } = render(
      <WorkbenchLayout {...makeProps({ onPanelResize, panelVisible: false })} />,
    )

    // 打开 Panel
    rerender(<WorkbenchLayout {...makeProps({ onPanelResize, panelVisible: true })} />)

    // Allotment 内部 ResizeObserver 触发 onChange（模拟 panel 出现后的布局回调）
    captured.verticalOnChange?.([300, 200])

    // ❌ Bug（修复前）：onPanelResize 被同步调用，落在 ResizeObserver 回调栈中
    // ✅ 修复后：此处不应同步调用，必须延迟到下一帧
    expect(onPanelResize).not.toHaveBeenCalled()

    // 下一帧执行后，才真正回报尺寸
    rafCallbacks.forEach((cb) => cb(0))
    expect(onPanelResize).toHaveBeenCalledWith(200)

    vi.unstubAllGlobals()
  })

  it('calls onPanelResize synchronously for resize events when panel is already open (drag performance)', () => {
    const onPanelResize = vi.fn()

    // panel 初始就可见：不触发 "首次显示" 逻辑，后续 onChange 应同步执行
    render(<WorkbenchLayout {...makeProps({ onPanelResize, panelVisible: true })} />)

    captured.verticalOnChange?.([300, 200])

    expect(onPanelResize).toHaveBeenCalledWith(200)
  })

  it('resumes synchronous calls after the deferred first-show onChange fires', () => {
    const onPanelResize = vi.fn()
    const rafCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb)
      return 0
    })

    const { rerender } = render(
      <WorkbenchLayout {...makeProps({ onPanelResize, panelVisible: false })} />,
    )
    rerender(<WorkbenchLayout {...makeProps({ onPanelResize, panelVisible: true })} />)

    // 第 1 次 onChange：延迟（首次显示）
    captured.verticalOnChange?.([300, 200])
    expect(onPanelResize).not.toHaveBeenCalled()

    // 第 2 次 onChange（用户拖动）：应同步
    captured.verticalOnChange?.([350, 150])
    expect(onPanelResize).toHaveBeenCalledWith(150)

    rafCallbacks.forEach((cb) => cb(0))
    expect(onPanelResize).toHaveBeenCalledWith(200)

    vi.unstubAllGlobals()
  })
})
