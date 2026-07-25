/*---------------------------------------------------------------------------------------------
 *  RendererLifecycleService 必须跑完整两阶段 shutdown（veto + willShutdown join）。
 *  只跑 veto 阶段会让窗口关闭/退出时的 join 清理（如停止 ACP agent 进程）从不
 *  执行——agent 子进程残留并把 cwd 钉在 workspace 上，Windows 下文件夹删不掉。
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { LifecycleService, ShutdownReason } from '@universe-editor/platform'
import { RendererLifecycleService } from '../RendererLifecycleService.js'

describe('RendererLifecycleService', () => {
  it('confirmShutdown fires onWillShutdown and awaits joins before proceeding', async () => {
    const lifecycle = new LifecycleService()
    const service = new RendererLifecycleService(lifecycle)

    const order: string[] = []
    lifecycle.onWillShutdown((e) =>
      e.join(
        new Promise<void>((resolve) => setTimeout(resolve, 10)).then(() => {
          order.push('join')
        }),
        'test.join',
      ),
    )

    const proceed = await service.confirmShutdown(ShutdownReason.CloseWindow)
    expect(proceed).toBe(true)
    expect(order).toEqual(['join'])
  })

  it('confirmShutdown does not fire onWillShutdown when vetoed', async () => {
    const lifecycle = new LifecycleService()
    const service = new RendererLifecycleService(lifecycle)

    lifecycle.onBeforeShutdown((e) => e.veto(true, 'test.veto'))
    let willShutdownFired = false
    lifecycle.onWillShutdown(() => {
      willShutdownFired = true
    })

    const proceed = await service.confirmShutdown(ShutdownReason.CloseWindow)
    expect(proceed).toBe(false)
    expect(willShutdownFired).toBe(false)
  })
})
