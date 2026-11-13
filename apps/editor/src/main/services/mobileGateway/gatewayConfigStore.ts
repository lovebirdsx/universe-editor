/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Owner of the machine-local `<userData>/mobile/gateway.json`. File mechanics
 *  (serialized atomic writes, directory watching, self-write suppression) live
 *  in JsonConfigFileStore; this class maps the gateway DTO, validates patches
 *  and exposes the gateway-specific state/event shape.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, Emitter, type Event, type ILogger } from '@universe-editor/platform'
import type {
  MobileGatewayConfig,
  MobileGatewayConfigPatch,
  MobileGatewayConfigState,
  MobileGatewayConfigUpdateResult,
} from '../../../shared/ipc/mobileGatewayService.js'
import { DEFAULT_MOBILE_GATEWAY_CONFIG } from '../../../shared/ipc/mobileGatewayService.js'
import { JsonConfigFileStore, type JsonConfigFileState } from '../jsonConfig/jsonConfigFileStore.js'
import {
  mergeMobileGatewayConfig,
  parseMobileGatewayConfigFile,
  readMobileGatewayConfigFile,
  serializeMobileGatewayConfig,
  validateMobileGatewayConfigPatch,
} from './gatewayConfigFile.js'

export interface MobileGatewayConfigStoreOptions {
  readonly file: string
  readonly logger: ILogger
  readonly debounceMs?: number
  readonly selfWriteSuppressMs?: number
  readonly onChmodError?: (error: Error) => void
}

export class MobileGatewayConfigStore extends Disposable {
  private readonly _configStore: JsonConfigFileStore<MobileGatewayConfig>
  private readonly _onDidChangeExternal = this._register(new Emitter<MobileGatewayConfigState>())
  readonly onDidChangeExternal: Event<MobileGatewayConfigState> = this._onDidChangeExternal.event

  constructor(options: MobileGatewayConfigStoreOptions) {
    super()
    this._configStore = this._register(
      new JsonConfigFileStore<MobileGatewayConfig>({
        file: options.file,
        logger: options.logger,
        ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
        ...(options.selfWriteSuppressMs === undefined
          ? {}
          : { selfWriteSuppressMs: options.selfWriteSuppressMs }),
        ...(options.onChmodError === undefined ? {} : { onChmodError: options.onChmodError }),
        directoryLabel: 'mobile config',
        createDefault: () => ({ ...DEFAULT_MOBILE_GATEWAY_CONFIG }),
        read: async (file) => {
          const result = await readMobileGatewayConfigFile(file)
          return result.kind === 'ok' ? { kind: 'ok', value: result.config } : result
        },
        serialize: (config) => serializeMobileGatewayConfig(config),
      }),
    )
    this._register(
      this._configStore.onDidChangeExternal((state) => {
        this._onDidChangeExternal.fire(toGatewayState(state))
      }),
    )
  }

  get state(): MobileGatewayConfigState {
    return toGatewayState(this._configStore.state)
  }

  async load(): Promise<MobileGatewayConfigState> {
    return toGatewayState(await this._configStore.load())
  }

  async reload(): Promise<MobileGatewayConfigState> {
    return toGatewayState(await this._configStore.reload())
  }

  async update(patch: MobileGatewayConfigPatch): Promise<MobileGatewayConfigUpdateResult> {
    const result = await this._configStore.update((config) => {
      const validated = validateMobileGatewayConfigPatch(patch)
      if (!validated.ok) return { ok: false, errors: validated.errors }

      const merged = mergeMobileGatewayConfig(config, validated.patch)
      const parsed = parseMobileGatewayConfigFile(merged)
      if (!parsed.ok) return { ok: false, errors: parsed.errors }

      return { ok: true, value: parsed.config }
    })
    const state = toGatewayState(result.state)
    if (result.ok) return { ok: true, state }
    return { ok: false, state, errors: result.errors }
  }

  async ensureFile(): Promise<void> {
    await this._configStore.ensureFile()
  }
}

function toGatewayState(state: JsonConfigFileState<MobileGatewayConfig>): MobileGatewayConfigState {
  return state.error === undefined
    ? { config: state.value }
    : { config: state.value, error: state.error }
}
