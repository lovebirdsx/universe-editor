/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useStableCallback — 组件生命周期内保持同一函数身份，调用时执行最新一次渲染的 body。
 *
 *  `useCallback` 换依赖即换身份，而同一渲染 Context 里保存着上一次返回的旧函数——交替失效时当前帧
 *  沿闭包链回指历史（机制与证据见 docs/development/memory-pressure.md）。包装在 hook 自己的函数
 *  作用域里创建、只捕获 ref：持有它不会钉住任何渲染帧；body 经 ref 在调用时读取，始终是最新输入。
 *--------------------------------------------------------------------------------------------*/

import { useRef } from 'react'

export function useStableCallback<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  const fnRef = useRef(fn)
  fnRef.current = fn

  const stableRef = useRef<((...args: Args) => Result) | null>(null)
  if (stableRef.current === null) {
    stableRef.current = (...args: Args): Result => fnRef.current(...args)
  }
  return stableRef.current
}
