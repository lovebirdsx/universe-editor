/*---------------------------------------------------------------------------------------------
 *  Default TS server implementation, shared by the main process (fallback when
 *  settings.json has no `typescript.server.implementation` entry) and the
 *  renderer (the ConfigurationRegistry schema default). Both sides must agree —
 *  the schema default alone does NOT reach main, which reads settings.json
 *  directly before any renderer ConfigurationService exists. 'native' is safe
 *  as the default: resolveTsServerSpec falls back to tsls when no tsgo binary
 *  is found (packaged builds ship a staged tsgo under resources/).
 *--------------------------------------------------------------------------------------------*/

export type TsServerImplementationName = 'tsls' | 'native'

export const DEFAULT_TS_SERVER_IMPLEMENTATION: TsServerImplementationName = 'native'
