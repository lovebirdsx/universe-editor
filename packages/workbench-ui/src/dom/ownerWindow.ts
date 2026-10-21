/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ownerWindow — 解析节点所属的 DOM realm，并从该 realm 借构造器/调度器。
 *
 *  辅助窗口是独立 realm：ResizeObserver 在构造时注册到构造它的 window 的
 *  ResizeObserverController，主窗口停帧后主 realm 的 observer 再也收不到辅助
 *  document 的布局回调；requestAnimationFrame 按 window 调度且是绑定到 window
 *  的 WebIDL 操作，解构后调用会抛 "Illegal invocation"，裸全局调用则把帧排到
 *  主窗口。凡是创建/调度/取消这三类 API 的路径，都必须先解析 owner window。
 *--------------------------------------------------------------------------------------------*/

/** 用调度它的同一个 window/API 取消；回调已经执行后调用也安全。 */
export interface OwnerFrame {
  cancel(): void
}

/** Document 自身返回自身；无 DOM 或节点无 owner 时返回 undefined。 */
export function getOwnerDocument(node: Node | null | undefined): Document | undefined {
  if (!node) return undefined
  // Document 也是 Node，但没有 ownerDocument；nodeType === 9 是跨 realm 安全的
  // 判据（静态守卫 domRealmUsage 禁止 `instanceof Document`）。
  if (node.nodeType === 9) return node as Document
  return node.ownerDocument ?? undefined
}

/** 节点的 owner window；`createHTMLDocument()` 或渲染进程无 DOM 时为 undefined。 */
export function getOwnerWindow(node: Node | null | undefined): Window | undefined {
  return getOwnerDocument(node)?.defaultView ?? undefined
}

/** owner realm 的 ResizeObserver 构造器；缺失时退回当前全局构造器。 */
export function getOwnerResizeObserver(
  node: Node | null | undefined,
): typeof ResizeObserver | undefined {
  const fromWindow = (
    getOwnerWindow(node) as (Window & { ResizeObserver?: typeof ResizeObserver }) | undefined
  )?.ResizeObserver
  if (fromWindow) return fromWindow
  return typeof ResizeObserver === 'undefined' ? undefined : ResizeObserver
}

/** owner realm 的 MouseEvent 构造器；用于 dispatch 到目标 document。 */
export function getOwnerMouseEvent(node: Node | null | undefined): typeof MouseEvent | undefined {
  const fromWindow = (
    getOwnerWindow(node) as (Window & { MouseEvent?: typeof MouseEvent }) | undefined
  )?.MouseEvent
  if (fromWindow) return fromWindow
  return typeof MouseEvent === 'undefined' ? undefined : MouseEvent
}

/** owner realm 的 KeyboardEvent 构造器；用于重放到目标 document。 */
export function getOwnerKeyboardEvent(
  node: Node | null | undefined,
): typeof KeyboardEvent | undefined {
  const fromWindow = (
    getOwnerWindow(node) as (Window & { KeyboardEvent?: typeof KeyboardEvent }) | undefined
  )?.KeyboardEvent
  if (fromWindow) return fromWindow
  return typeof KeyboardEvent === 'undefined' ? undefined : KeyboardEvent
}

/** owner realm 的 getComputedStyle；必须作为 window 的方法调用。 */
export function getOwnerComputedStyle(node: Element): CSSStyleDeclaration | undefined {
  const win = getOwnerWindow(node)
  if (win) return win.getComputedStyle(node)
  return typeof getComputedStyle === 'function' ? getComputedStyle(node) : undefined
}

/**
 * 在节点所属 window 上排一帧。返回的 token 记住调度它的 window 与 id，
 * 调用方不需要（也绝不应该）再用全局 cancelAnimationFrame 取消。
 */
export function requestOwnerFrame(
  node: Node | null | undefined,
  callback: FrameRequestCallback,
): OwnerFrame {
  const win = getOwnerWindow(node)
  if (win && typeof win.requestAnimationFrame === 'function') {
    // 必须作为 win 的方法调用：rAF 绑定到窗口，解构后调用抛 Illegal invocation。
    const id = win.requestAnimationFrame(callback)
    return {
      cancel: () => {
        if (typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(id)
      },
    }
  }
  if (typeof requestAnimationFrame === 'function' && typeof cancelAnimationFrame === 'function') {
    const id = globalThis.requestAnimationFrame(callback)
    return { cancel: () => globalThis.cancelAnimationFrame(id) }
  }
  // renderer-node 单测没有 rAF：退化成宏任务，保持「下一帧再执行」的语义。
  const timer = setTimeout(() => {
    callback(typeof performance === 'undefined' ? Date.now() : performance.now())
  }, 0)
  return { cancel: () => clearTimeout(timer) }
}

/** 清理时的一行写法；token 为空时 no-op。 */
export function cancelOwnerFrame(frame: OwnerFrame | undefined): void {
  frame?.cancel()
}
