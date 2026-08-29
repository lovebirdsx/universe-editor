/*---------------------------------------------------------------------------------------------
 *  Minimal IConfigurationService for the Search view tests: reads come from a
 *  plain map, everything else is inert. `search.searchOnType` and friends are
 *  read on every keystroke, so the defaults here mirror the registered ones.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, type IConfigurationService } from '@universe-editor/platform'

export interface StubConfigurationService extends IConfigurationService {
  /** Write a value and fire onDidChangeConfiguration for that key. */
  set(key: string, value: unknown): void
}

export function stubConfigurationService(
  values: Record<string, unknown> = {},
): StubConfigurationService {
  const current = { ...values }
  const onDidChange = new Emitter<{ affectsConfiguration(key: string): boolean }>()
  return {
    _serviceBrand: undefined,
    get: (<T>(key: string, defaultValue?: T) =>
      key in current ? (current[key] as T) : defaultValue) as IConfigurationService['get'],
    getMerged: () => ({}) as never,
    update: () => {},
    loadLayer: () => {},
    getLayerSnapshot: () => ({}),
    getValueOrigin: () => undefined,
    getValueForTarget: () => undefined,
    getValueOriginForTarget: () => undefined,
    onDidChangeConfiguration: onDidChange.event,
    set(key: string, value: unknown): void {
      current[key] = value
      onDidChange.fire({ affectsConfiguration: (k) => k === key })
    },
  } as unknown as StubConfigurationService
}
