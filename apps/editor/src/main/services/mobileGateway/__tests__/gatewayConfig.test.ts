import { describe, expect, it } from 'vitest'
import type { NetworkInterfaceInfo } from 'node:os'
import {
  buildOrigins,
  capabilitiesForOrigins,
  DEFAULT_MOBILE_GATEWAY_CONFIG,
  resolveGatewayRuntime,
  type GatewayEnvironment,
} from '../gatewayConfig.js'

const noEnv: GatewayEnvironment = {
  mobileGateway: undefined,
  mobilePort: undefined,
  mobileBind: undefined,
  mobileLanAddress: undefined,
  mobileInsecure: undefined,
}

const interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {
  lo: [
    {
      address: '127.0.0.1',
      netmask: '255.0.0.0',
      family: 'IPv4',
      mac: '00:00:00:00:00:00',
      internal: true,
      cidr: '127.0.0.1/8',
    },
  ],
  eth0: [
    {
      address: '192.0.2.10',
      netmask: '255.255.255.0',
      family: 'IPv4',
      mac: '00:00:00:00:00:01',
      internal: false,
      cidr: '192.0.2.10/24',
    },
  ],
}

function resolve(bind: 'loopback' | 'lan', env: Partial<GatewayEnvironment>, isPackaged = true) {
  return resolveGatewayRuntime({
    config: { ...DEFAULT_MOBILE_GATEWAY_CONFIG, enabled: true, bind },
    env: { ...noEnv, ...env },
    isPackaged,
    interfaces,
  })
}

describe('resolveGatewayRuntime', () => {
  it('keeps loopback HTTP without a certificate', () => {
    expect(resolve('loopback', {})).toEqual({
      ok: true,
      bind: 'loopback',
      host: '127.0.0.1',
      port: 47321,
      secure: false,
      insecure: false,
    })
  })

  it('serves the LAN tier over self-signed HTTPS in packaged builds', () => {
    expect(resolve('lan', {})).toEqual({
      ok: true,
      bind: 'lan',
      host: '192.0.2.10',
      port: 47321,
      secure: true,
      insecure: false,
    })
  })

  it('lets the environment pick the LAN address and an ephemeral port', () => {
    expect(
      resolve('lan', {
        mobileBind: 'lan',
        mobileLanAddress: '192.0.2.20',
        mobilePort: '0',
      }),
    ).toMatchObject({ ok: true, host: '192.0.2.20', port: 0, secure: true })
  })

  it('refuses clear-text LAN HTTP in packaged builds', () => {
    const runtime = resolve('lan', { mobileInsecure: '1' })
    expect(runtime.ok).toBe(false)
    if (!runtime.ok) expect(runtime.error).toContain('明文局域网 HTTP')
  })

  it('allows clear-text LAN HTTP only in development', () => {
    expect(resolve('lan', { mobileInsecure: '1' }, false)).toMatchObject({
      ok: true,
      secure: false,
      insecure: true,
    })
  })

  it('fails when no LAN address is available', () => {
    const runtime = resolveGatewayRuntime({
      config: { ...DEFAULT_MOBILE_GATEWAY_CONFIG, enabled: true, bind: 'lan' },
      env: noEnv,
      isPackaged: true,
      interfaces: { lo: interfaces['lo'] },
    })
    expect(runtime.ok).toBe(false)
  })
})

describe('buildOrigins and capabilities', () => {
  it('marks only configured extra hosts as trusted secure origins', () => {
    const lan = buildOrigins({
      bind: 'lan',
      host: '192.0.2.10',
      port: 47321,
      secure: true,
      allowedHosts: [],
    })
    expect(lan.urls).toEqual(['https://192.0.2.10:47321'])
    expect(capabilitiesForOrigins(lan)).toEqual({ installable: false, push: false })

    const withTailscale = buildOrigins({
      bind: 'lan',
      host: '192.0.2.10',
      port: 47321,
      secure: true,
      allowedHosts: ['pc.example.ts.net'],
    })
    expect(withTailscale.urls).toContain('https://pc.example.ts.net')
    expect(capabilitiesForOrigins(withTailscale)).toEqual({ installable: true, push: true })
  })

  it('uses HTTP for the development LAN tier', () => {
    const origins = buildOrigins({
      bind: 'lan',
      host: '192.0.2.10',
      port: 47321,
      secure: false,
      allowedHosts: [],
    })
    expect(origins.urls).toEqual(['http://192.0.2.10:47321'])
    expect(capabilitiesForOrigins(origins)).toEqual({ installable: false, push: false })
  })
})
