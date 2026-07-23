/*---------------------------------------------------------------------------------------------
 *  Default TS server implementation, shared by the main process (fallback when
 *  settings.json has no `typescript.server.implementation` entry) and the
 *  renderer (the ConfigurationRegistry schema default). Both sides must agree —
 *  the schema default alone does NOT reach main, which reads settings.json
 *  directly before any renderer ConfigurationService exists. 'native' is safe
 *  as the default: packaged builds fall back to tsls in resolveTsServerSpec.
 *--------------------------------------------------------------------------------------------*/

export type TsServerImplementationName = 'tsls' | 'native'

export const DEFAULT_TS_SERVER_IMPLEMENTATION: TsServerImplementationName = 'native'
