import { describe, expect, it, vi } from 'vitest'

import { EditorMcpVersionMismatchError } from '../editorBridge.js'
import { discoverEditors, type EditorProcessInfo } from '../editorDiscovery.js'

const editors: EditorProcessInfo[] = [
  { pid: 501, executablePath: '', commandLine: '' },
  { pid: 502, executablePath: '', commandLine: '' },
]

describe('discoverEditors', () => {
  it('没有 UE 进程时明确报错', async () => {
    await expect(
      discoverEditors({ connectTimeoutMs: 100, enumerate: async () => [] }),
    ).rejects.toThrow('未发现正在运行的 UE4Editor')
  })

  it('只返回握手成功的实例，即使其他 UE 未就绪', async () => {
    const probe = vi.fn(async (pid: number) => {
      if (pid === 501) throw new Error('pipe not ready')
      return { EditorPid: pid, InstanceId: 'session-b', ProjectPath: 'X:/workspace/B' }
    })
    const candidates = await discoverEditors({
      connectTimeoutMs: 100,
      enumerate: async () => editors,
      probe,
    })
    expect(candidates).toEqual([
      { identity: { EditorPid: 502, InstanceId: 'session-b', ProjectPath: 'X:/workspace/B' } },
    ])
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('多个可用实例按 PID 排序，项目路径相同也不会合并', async () => {
    const candidates = await discoverEditors({
      connectTimeoutMs: 100,
      enumerate: async () => [{ ...editors[1]!, startTime: 1_725_000_000_000 }, editors[0]!],
      probe: async (pid) => ({
        EditorPid: pid,
        InstanceId: `session-${pid}`,
        ProjectPath: 'X:/workspace',
      }),
    })
    expect(candidates.map((candidate) => candidate.identity.EditorPid)).toEqual([501, 502])
    expect(candidates[0]?.startTime).toBeUndefined()
    expect(candidates[1]?.startTime).toBe(1_725_000_000_000)
  })

  it('没有可握手的实例时拒绝路由业务请求', async () => {
    await expect(
      discoverEditors({
        connectTimeoutMs: 100,
        enumerate: async () => editors,
        probe: async () => {
          throw new Error('protocol mismatch')
        },
      }),
    ).rejects.toThrow('没有可连接的 MCP 服务')
  })

  it('服务存在但协议版本不一致时提示更新', async () => {
    await expect(
      discoverEditors({
        connectTimeoutMs: 100,
        enumerate: async () => editors,
        probe: async () => {
          throw new EditorMcpVersionMismatchError()
        },
      }),
    ).rejects.toThrow('协议不兼容')
  })
})
