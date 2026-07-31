import { createDecorator, Disposable, Emitter, type Event } from '@universe-editor/platform'
import type {
  IMcpServerDefinitionDto,
  IMcpStdioServerDefinitionDto,
} from '@universe-editor/extensions-common'
import type { McpServer } from '@agentclientprotocol/sdk'
import type { McpServerDefinition } from './acpMcpServers.js'

export interface IMcpServerDefinitionRegistry {
  readonly _serviceBrand: undefined
  readonly onDidChangeDefinitions: Event<void>
  set(sourceId: string, definitions: readonly IMcpServerDefinitionDto[]): void
  remove(sourceId: string): void
  definitions(): readonly McpServerDefinition[]
  wireServers(): readonly McpServer[]
}

export const IMcpServerDefinitionRegistry = createDecorator<IMcpServerDefinitionRegistry>(
  'mcpServerDefinitionRegistry',
)

export class McpServerDefinitionRegistry
  extends Disposable
  implements IMcpServerDefinitionRegistry
{
  declare readonly _serviceBrand: undefined
  private readonly _bySource = new Map<string, readonly IMcpServerDefinitionDto[]>()
  private readonly _onDidChangeDefinitions = this._register(new Emitter<void>())
  readonly onDidChangeDefinitions = this._onDidChangeDefinitions.event

  set(sourceId: string, definitions: readonly IMcpServerDefinitionDto[]): void {
    this._bySource.set(sourceId, definitions)
    this._onDidChangeDefinitions.fire()
  }

  remove(sourceId: string): void {
    if (this._bySource.delete(sourceId)) this._onDidChangeDefinitions.fire()
  }

  definitions(): readonly McpServerDefinition[] {
    return this._merged().map((definition) => ({
      name: definition.name,
      transport: 'stdio',
      disabled: false,
      source: 'extension',
    }))
  }

  wireServers(): readonly McpServer[] {
    return this._merged().map((definition) => ({
      name: definition.name,
      command: definition.command,
      args: [...definition.args],
      env: Object.entries(definition.env).map(([name, value]) => ({ name, value })),
      ...(definition.cwd !== undefined ? { cwd: definition.cwd } : {}),
    }))
  }

  private _merged(): readonly IMcpStdioServerDefinitionDto[] {
    const byName = new Map<string, IMcpStdioServerDefinitionDto>()
    for (const definitions of this._bySource.values()) {
      for (const definition of definitions) byName.set(definition.name, definition)
    }
    return [...byName.values()]
  }
}

export const mcpServerDefinitionRegistry = new McpServerDefinitionRegistry()
