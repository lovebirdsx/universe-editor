import { afterEach, describe, expect, it } from 'vitest'
import { JSONContributionRegistry, URI } from '@universe-editor/platform'
import {
  IMobileGatewayService,
  MOBILE_GATEWAY_DEFAULT_SESSION_HISTORY_WORKSPACE_LIMIT,
  MOBILE_GATEWAY_MAX_SESSION_HISTORY_WORKSPACE_LIMIT,
  type MobileGatewayConfigState,
} from '../../../shared/ipc/mobileGatewayService.js'
import { MobileGatewayConfigurationContribution } from '../MobileGatewayContributions.js'

const SCHEMA_URI = 'universe-editor://schemas/mobileGateway'

function fakeGateway(uri: string | Promise<string>) {
  return {
    getConfigFileUri: async () => uri,
    getConfig: async (): Promise<MobileGatewayConfigState> => {
      throw new Error('not used')
    },
  } as unknown as IMobileGatewayService
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function contribution() {
  return JSONContributionRegistry.getContributions().find((c) => c.uri === SCHEMA_URI)
}

describe('MobileGatewayConfigurationContribution', () => {
  const disposables: { dispose(): void }[] = []
  afterEach(() => {
    for (const d of disposables.splice(0)) d.dispose()
  })

  it('registers a schema with an exact fileMatch for gateway.json', async () => {
    const uri = URI.file(
      'D:/Users/admin/AppData/Roaming/Universe Editor/mobile/gateway.json',
    ).toString()
    const c = new MobileGatewayConfigurationContribution(fakeGateway(uri))
    disposables.push(c)
    await settle()

    const registered = contribution()
    expect(registered).toBeDefined()
    expect(registered?.fileMatch).toEqual([
      'd:/Users/admin/AppData/Roaming/Universe Editor/mobile/gateway.json',
    ])
    expect(registered?.schema.additionalProperties).toBe(false)
    expect(Object.keys(registered?.schema.properties ?? {})).toEqual([
      'enabled',
      'bind',
      'lanAddress',
      'port',
      'allowedHosts',
      'vapidSubject',
      'sessionHistoryWorkspaceLimit',
      'keepRunningInBackground',
      'launchAtLogin',
    ])
    expect(registered?.schema.properties?.['bind']?.enum).toEqual(['loopback', 'lan'])
    expect(registered?.schema.properties?.['port']?.minimum).toBe(1)
    expect(registered?.schema.properties?.['port']?.maximum).toBe(65535)
    expect(registered?.schema.properties?.['sessionHistoryWorkspaceLimit']?.default).toBe(
      MOBILE_GATEWAY_DEFAULT_SESSION_HISTORY_WORKSPACE_LIMIT,
    )
    expect(registered?.schema.properties?.['sessionHistoryWorkspaceLimit']?.maximum).toBe(
      MOBILE_GATEWAY_MAX_SESSION_HISTORY_WORKSPACE_LIMIT,
    )
    expect(registered?.schema.properties?.['keepRunningInBackground']?.default).toBe(false)
    expect(registered?.schema.properties?.['launchAtLogin']?.default).toBe(false)
  })

  it('does not register when the config file uri is unavailable', async () => {
    const c = new MobileGatewayConfigurationContribution(
      fakeGateway(Promise.reject(new Error('service disposed'))),
    )
    disposables.push(c)
    await settle()
    expect(contribution()).toBeUndefined()
  })

  it('removes the schema on dispose', async () => {
    const uri = URI.file('/home/foo/.config/universe-editor/mobile/gateway.json').toString()
    const c = new MobileGatewayConfigurationContribution(fakeGateway(uri))
    await settle()
    expect(contribution()).toBeDefined()

    c.dispose()
    expect(contribution()).toBeUndefined()
  })
})
