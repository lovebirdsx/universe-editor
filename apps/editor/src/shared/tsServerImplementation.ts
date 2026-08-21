/*---------------------------------------------------------------------------------------------
 *  Default TS server implementation, shared by the main process (fallback when
 *  settings.json has no `js/ts.experimental.useTsgo` entry) and the renderer
 *  (the ConfigurationRegistry schema default). Both sides must agree — the
 *  schema default alone does NOT reach main, which reads settings.json directly
 *  before any renderer ConfigurationService exists. The default is 'tsls':
 *  `js/ts.experimental.useTsgo` defaults to false (tsls), and only a literal
 *  `true` selects the Go native port (tsgo); resolveTsServerSpec additionally
 *  falls back to tsls when no tsgo binary is found.
 *--------------------------------------------------------------------------------------------*/

export type TsServerImplementationName = 'tsls' | 'native'

export const DEFAULT_TS_SERVER_IMPLEMENTATION: TsServerImplementationName = 'tsls'
