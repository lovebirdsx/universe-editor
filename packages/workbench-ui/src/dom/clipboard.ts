/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  clipboard — 文本剪贴板的统一入口。
 *
 *  辅助窗口是主 renderer 用 window.open 打开的同源 popup，组件里的裸 navigator
 *  指向主窗口。焦点落在辅助窗口时主文档 hasFocus() 为 false，Chromium 会拒绝
 *  navigator.clipboard 的读写；主进程 Electron clipboard 没有这个焦点门槛。
 *  editor 启动时注入 IHostService；未注入时（单测 / 非 editor 宿主）退回 owner
 *  document（显式传入时）或全局 navigator。
 *--------------------------------------------------------------------------------------------*/

import type { IHostService } from '@universe-editor/platform'

/** 只依赖宿主服务的两个文本剪贴板方法；IHostService 结构化满足它。 */
export type ClipboardHost = Pick<IHostService, 'readClipboardText' | 'writeClipboardText'>

let host: ClipboardHost | undefined

/** editor 在 registerProxyChannelServices 之后注入一次；测试传 undefined 复位。 */
export function setClipboardHost(value: ClipboardHost | undefined): void {
  host = value
}

function fallbackClipboard(doc: Document | undefined): Clipboard | undefined {
  // 惰性读取：模块加载后才 vi.stubGlobal('navigator', …) 的测试也必须命中。
  const fromDocument = doc?.defaultView?.navigator.clipboard
  if (fromDocument) return fromDocument
  if (typeof navigator === 'undefined') return undefined
  return navigator.clipboard
}

/**
 * 写入文本剪贴板。注入了宿主就走主进程（与窗口焦点无关）；否则回退到
 * `doc` 所属 window 或全局 navigator。剪贴板 API 不可用时 reject，调用方决定
 * 是否吞掉（菜单类用 {@link copyText}）。
 */
export async function writeClipboardText(text: string, doc?: Document): Promise<void> {
  if (host) return host.writeClipboardText(text)
  const clipboard = fallbackClipboard(doc)
  if (typeof clipboard?.writeText !== 'function') {
    throw new Error('clipboard.writeText is unavailable')
  }
  return clipboard.writeText(text)
}

/** 读取文本剪贴板；回退规则同 {@link writeClipboardText}。 */
export async function readClipboardText(doc?: Document): Promise<string> {
  if (host) return host.readClipboardText()
  const clipboard = fallbackClipboard(doc)
  if (typeof clipboard?.readText !== 'function') {
    throw new Error('clipboard.readText is unavailable')
  }
  return clipboard.readText()
}

/** Fire-and-forget：菜单项等没有失败反馈的入口用它，避免 unhandled rejection。 */
export function copyText(text: string, doc?: Document): void {
  void writeClipboardText(text, doc).catch(() => {})
}
