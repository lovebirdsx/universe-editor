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
  FileWatcher: 'fileWatcher',
  Workspace: 'workspace',
  UserData: 'userData',
  Log: 'log',
  LogFiles: 'logFiles',
  Window: 'window',
  AcpHost: 'acpHost',
  AcpTerminal: 'acpTerminal',
  ClaudeBinary: 'claudeBinary',
  CodexBinary: 'codexBinary',
  DisposableLeak: 'disposableLeak',
  Update: 'update',
  ReleaseNotes: 'releaseNotes',
  Lifecycle: 'lifecycle',
} as const

export type ServiceChannelName = (typeof ServiceChannels)[keyof typeof ServiceChannels]
