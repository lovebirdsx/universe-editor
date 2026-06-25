/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IPC channel name constants shared between main and renderer.
 *--------------------------------------------------------------------------------------------*/

/** Single Electron channel that carries all framed IPC messages. */
export const IPC_PROTOCOL_CHANNEL = 'ue:ipc'

/** Names of service channels multiplexed onto the protocol. */
export const ServiceChannels = {
  Host: 'host',
  Storage: 'storage',
  Ping: 'ping',
  FileSystem: 'fileSystem',
  FileSearch: 'fileSearch',
  TextSearch: 'textSearch',
  FileWatcher: 'fileWatcher',
  Workspace: 'workspace',
  UserData: 'userData',
  ConfigLocation: 'configLocation',
  Log: 'log',
  LogFiles: 'logFiles',
  Window: 'window',
  AcpHost: 'acpHost',
  AcpTerminal: 'acpTerminal',
  Terminal: 'terminal',
  ClaudeBinary: 'claudeBinary',
  ClaudeConfig: 'claudeConfig',
  CodexBinary: 'codexBinary',
  CodexConfig: 'codexConfig',
  DisposableLeak: 'disposableLeak',
  Update: 'update',
  ReleaseNotes: 'releaseNotes',
  Performance: 'performance',
  Lifecycle: 'lifecycle',
  ExtensionHost: 'extensionHost',
  SessionSwitcher: 'sessionSwitcher',
  RendererSessions: 'rendererSessions',
  Usage: 'usage',
  AiModel: 'aiModel',
  AiDebug: 'aiDebug',
  RemoteSchema: 'remoteSchema',
  ExchangeRate: 'exchangeRate',
} as const

export type ServiceChannelName = (typeof ServiceChannels)[keyof typeof ServiceChannels]
