import { afterEach, describe, expect, it } from 'vitest'
import {
  JSONContributionRegistry,
  URI,
  UserDataFile,
  type IUserDataFilesService,
  type UriComponents,
} from '@universe-editor/platform'
import { UpdateConfigurationContribution } from '../UpdateConfigurationContribution.js'

const SCHEMA_URI = 'universe-editor://schemas/updateConfig'

function fakeUserDataFiles(uriByFile: Partial<Record<UserDataFile, UriComponents>>) {
  return {
    getFileUri: async (file: UserDataFile) => uriByFile[file] ?? null,
  } as unknown as IUserDataFilesService
}

/** Let the contribution's async _refresh() settle. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function updateConfigContrib() {
  return JSONContributionRegistry.getContributions().find((c) => c.uri === SCHEMA_URI)
}

describe('UpdateConfigurationContribution', () => {
  const disposables: { dispose(): void }[] = []
  afterEach(() => {
    for (const d of disposables.splice(0)) d.dispose()
  })

  it('registers a schema with an exact fileMatch for update-config.json', async () => {
    const uri = URI.file('D:/Users/admin/AppData/Roaming/Universe Editor/update-config.json')
    const c = new UpdateConfigurationContribution(
      fakeUserDataFiles({ [UserDataFile.UpdateConfig]: uri.toJSON() }),
    )
    disposables.push(c)
    await settle()

    const contrib = updateConfigContrib()
    expect(contrib).toBeDefined()
    expect(contrib?.fileMatch).toEqual([
      'd:/Users/admin/AppData/Roaming/Universe Editor/update-config.json',
    ])
    expect(contrib?.schema.properties?.['updateUrl']).toBeDefined()
    expect(contrib?.schema.properties?.['galleryUrl']).toBeDefined()
    expect(contrib?.schema.additionalProperties).toBe(false)
  })

  it('does not register when the file uri is unavailable', async () => {
    const c = new UpdateConfigurationContribution(fakeUserDataFiles({}))
    disposables.push(c)
    await settle()
    expect(updateConfigContrib()).toBeUndefined()
  })

  it('removes the schema on dispose', async () => {
    const uri = URI.file('/home/foo/.config/universe-editor/update-config.json')
    const c = new UpdateConfigurationContribution(
      fakeUserDataFiles({ [UserDataFile.UpdateConfig]: uri.toJSON() }),
    )
    await settle()
    expect(updateConfigContrib()).toBeDefined()
    c.dispose()
    expect(updateConfigContrib()).toBeUndefined()
  })
})
