/*---------------------------------------------------------------------------------------------
 *  ownerDocumentContext — 浮层所属文档的 React 侧来源。
 *
 *  辅助窗口由主 renderer 经 createPortal 渲染，React context 随组件树传播、不随
 *  DOM 目标传播；因此每棵跨文档 portal 子树都必须重新 Provider，否则原语会退回
 *  主窗口的全局 document。解析优先级：显式 prop > context > 全局 document。
 *--------------------------------------------------------------------------------------------*/

import { createContext, useContext, type ReactNode } from 'react'

export const OwnerDocumentContext = createContext<Document | undefined>(undefined)

export function OwnerDocumentProvider({
  targetDocument,
  children,
}: {
  targetDocument: Document | undefined
  children: ReactNode
}) {
  return <OwnerDocumentContext value={targetDocument}>{children}</OwnerDocumentContext>
}

/**
 * 返回浮层应归属的 document。显式 prop 优先；否则取最近的 Provider；最后退回
 * 全局 document。node 环境（renderer-node 单测）没有全局 document，返回 undefined，
 * 调用方需按“无 DOM”处理。
 */
export function useOwnerDocument(explicit?: Document | undefined): Document | undefined {
  const fromContext = useContext(OwnerDocumentContext)
  if (explicit !== undefined) return explicit
  if (fromContext !== undefined) return fromContext
  return typeof document === 'undefined' ? undefined : document
}
