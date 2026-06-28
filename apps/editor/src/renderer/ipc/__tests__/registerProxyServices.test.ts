import { describe, expect, it } from 'vitest'
import { ServiceCollection, type IChannel, type IIpcService } from '@universe-editor/platform'
import { ServiceChannels } from '../../../shared/ipc/channelNames.js'
import { PROXY_SERVICE_BINDINGS, registerProxyChannelServices } from '../registerProxyServices.js'

const KNOWN_CHANNELS = new Set<string>(Object.values(ServiceChannels))

describe('PROXY_SERVICE_BINDINGS', () => {
  it('every binding targets a real ServiceChannels name', () => {
    for (const binding of PROXY_SERVICE_BINDINGS) {
      expect(KNOWN_CHANNELS.has(binding.channel), `unknown channel: ${binding.channel}`).toBe(true)
    }
  })

  it('has no duplicate channels or service identifiers', () => {
    const channels = PROXY_SERVICE_BINDINGS.map((b) => b.channel)
    expect(new Set(channels).size).toBe(channels.length)
    const ids = PROXY_SERVICE_BINDINGS.map((b) => b.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('registers one proxy per binding and serves local properties without an RPC', () => {
    const requested: string[] = []
    const stubChannel: IChannel = {
      call: async () => undefined,
      listen: () => () => {},
    } as unknown as IChannel
    const ipc: IIpcService = {
      _serviceBrand: undefined,
      getChannel: (name: string) => {
        requested.push(name)
        return stubChannel
      },
      registerChannel: () => {},
    }

    const services = new ServiceCollection()
    registerProxyChannelServices(services, ipc, 'win32')

    expect(requested.sort()).toEqual(PROXY_SERVICE_BINDINGS.map((b) => b.channel).sort())

    // The host proxy serves its local `platform` property without an RPC call.
    const host = services.get(
      PROXY_SERVICE_BINDINGS.find((b) => b.channel === ServiceChannels.Host)!.id,
    ) as { platform: string }
    expect(host.platform).toBe('win32')
  })
})
