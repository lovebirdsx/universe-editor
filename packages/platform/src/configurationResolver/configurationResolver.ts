/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Ported from VSCode's IConfigurationResolverService contract
 *  (workbench/services/configurationResolver/common/configurationResolver.ts).
 *
 *  Trimmed vs upstream: the interactive `resolveWithInteraction*` surface (inputs
 *  / command variables driven by UI) is kept in the interface for parity but the
 *  abstract base throws `not implemented` — we have no interactive consumer yet.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../di/instantiation.js'
import type { URI } from '../base/uri.js'
import type { ConfigurationResolverExpression } from './configurationResolverExpression.js'

/** Minimal process-environment shape the resolver consumes (name → value). */
export type IProcessEnvironment = Record<string, string | undefined>

/** A workspace folder the resolver scopes `${workspaceFolder}` style variables to. */
export interface IWorkspaceFolderData {
  readonly uri: URI
  readonly name: string
}

export const IConfigurationResolverService = createDecorator<IConfigurationResolverService>(
  'configurationResolverService',
)

export interface IConfigurationResolverService {
  readonly _serviceBrand: undefined

  /** Variables the resolver is able to resolve. */
  readonly resolvableVariables: ReadonlySet<string>

  resolveWithEnvironment(
    environment: IProcessEnvironment,
    folder: IWorkspaceFolderData | undefined,
    value: string,
  ): Promise<string>

  /**
   * Recursively resolves all variables in the given config and returns a copy of
   * it with substituted values.
   */
  resolveAsync<T>(
    folder: IWorkspaceFolderData | undefined,
    config: T,
  ): Promise<T extends ConfigurationResolverExpression<infer R> ? R : T>

  /**
   * Contributes a variable that can be resolved later.
   */
  contributeVariable(variable: string, resolution: () => Promise<string | undefined>): void
}

export enum VariableKind {
  Unknown = 'unknown',

  Env = 'env',
  Config = 'config',
  Command = 'command',
  Input = 'input',
  ExtensionInstallFolder = 'extensionInstallFolder',
  TaskVar = 'taskVar',

  WorkspaceFolder = 'workspaceFolder',
  Cwd = 'cwd',
  WorkspaceFolderBasename = 'workspaceFolderBasename',
  UserHome = 'userHome',
  LineNumber = 'lineNumber',
  ColumnNumber = 'columnNumber',
  SelectedText = 'selectedText',
  File = 'file',
  FileWorkspaceFolder = 'fileWorkspaceFolder',
  FileWorkspaceFolderBasename = 'fileWorkspaceFolderBasename',
  RelativeFile = 'relativeFile',
  RelativeFileDirname = 'relativeFileDirname',
  FileDirname = 'fileDirname',
  FileExtname = 'fileExtname',
  FileBasename = 'fileBasename',
  FileBasenameNoExtension = 'fileBasenameNoExtension',
  FileDirnameBasename = 'fileDirnameBasename',
  ExecPath = 'execPath',
  ExecInstallFolder = 'execInstallFolder',
  PathSeparator = 'pathSeparator',
  PathSeparatorAlias = '/',
}

export const allVariableKinds: readonly VariableKind[] = Object.values(VariableKind).filter(
  (value): value is VariableKind => typeof value === 'string',
)

export class VariableError extends Error {
  constructor(
    public readonly variable: VariableKind,
    message?: string,
  ) {
    super(message)
    this.name = 'VariableError'
  }
}
