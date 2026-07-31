import { Disposable } from '@universe-editor/platform'
import type { IMainThreadMcp, IMcpServerDefinitionDto } from '@universe-editor/extensions-common'
import type { IMcpServerDefinitionRegistry } from '../acp/mcpServerDefinitionRegistry.js'

export class MainThreadMcp extends Disposable implements IMainThreadMcp {
  private readonly _sources = new Set<string>()

  constructor(private readonly _registry: IMcpServerDefinitionRegistry) {
    super()
  }

  async $setMcpServerDefinitions(
    sourceId: string,
    definitions: readonly IMcpServerDefinitionDto[],
  ): Promise<void> {
    this._sources.add(sourceId)
    this._registry.set(sourceId, definitions)
  }

  async $removeMcpServerDefinitions(sourceId: string): Promise<void> {
    this._sources.delete(sourceId)
    this._registry.remove(sourceId)
  }

  override dispose(): void {
    for (const sourceId of this._sources) this._registry.remove(sourceId)
    this._sources.clear()
    super.dispose()
  }
}
