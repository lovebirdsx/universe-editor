/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Ported from VSCode's AbstractVariableResolverService
 *  (workbench/services/configurationResolver/common/variableResolver.ts).
 *
 *  Evaluates a single `${name:arg}` replacement against a resolve context. The
 *  context supplies the raw data sources (workspace folders, active file, config,
 *  extensions); this class owns the variable grammar and the path math.
 *
 *  Adaptations for this codebase:
 *   - path ops go through platform's string-only helpers (URI.fsPath is already
 *     forward-slash across the app), with `platform` injected explicitly instead
 *     of relying on a global `isWindows`.
 *   - no `labelService` — `fsPath` is `uri.fsPath` directly.
 *   - localized error strings are plain English (renderer surfaces them in logs).
 *--------------------------------------------------------------------------------------------*/

import type { HostPlatform } from '../host/hostService.js'
import type { URI } from '../base/uri.js'
import {
  basename,
  dirname,
  extname,
  normalizeDriveLetter,
  pathSeparator,
  relativePath,
} from '../base/path.js'
import {
  allVariableKinds,
  VariableError,
  VariableKind,
  type IConfigurationResolverService,
  type IProcessEnvironment,
  type IWorkspaceFolderData,
} from './configurationResolver.js'
import {
  ConfigurationResolverExpression,
  type IResolvedValue,
  type Replacement,
} from './configurationResolverExpression.js'

export interface IVariableResolveContext {
  getFolderUri(folderName: string): URI | undefined
  getWorkspaceFolderCount(): number
  getConfigurationValue(folderUri: URI | undefined, section: string): string | undefined
  getExecPath(): string | undefined
  getFilePath(): string | undefined
  getWorkspaceFolderPathForFile?(): string | undefined
  getSelectedText(): string | undefined
  getLineNumber(): string | undefined
  getColumnNumber(): string | undefined
  getExtension(id: string): Promise<{ readonly extensionLocation: URI } | undefined>
}

type Environment = { env: IProcessEnvironment | undefined; userHome: string | undefined }

export abstract class AbstractVariableResolverService implements IConfigurationResolverService {
  declare readonly _serviceBrand: undefined

  private readonly _context: IVariableResolveContext
  private readonly _platform: HostPlatform
  private _envVariablesPromise?: Promise<IProcessEnvironment> | undefined
  private _userHomePromise?: Promise<string> | undefined
  protected _contributedVariables: Map<string, () => Promise<string | undefined>> = new Map()

  public readonly resolvableVariables = new Set<string>(allVariableKinds)

  constructor(
    context: IVariableResolveContext,
    platform: HostPlatform,
    userHomePromise?: Promise<string>,
    envVariablesPromise?: Promise<IProcessEnvironment>,
  ) {
    this._context = context
    this._platform = platform
    this._userHomePromise = userHomePromise
    if (envVariablesPromise) {
      this._envVariablesPromise = envVariablesPromise.then((env) => this.prepareEnv(env))
    }
  }

  private prepareEnv(envVariables: IProcessEnvironment): IProcessEnvironment {
    // windows env variables are case insensitive
    if (this._platform === 'win32') {
      const ev: IProcessEnvironment = Object.create(null)
      Object.keys(envVariables).forEach((key) => {
        ev[key.toLowerCase()] = envVariables[key]
      })
      return ev
    }
    return envVariables
  }

  public async resolveWithEnvironment(
    environment: IProcessEnvironment,
    folder: IWorkspaceFolderData | undefined,
    value: string,
  ): Promise<string> {
    const expr = ConfigurationResolverExpression.parse(value, this._platform)

    for (const replacement of expr.unresolved()) {
      const resolvedValue = await this.evaluateSingleVariable(
        replacement,
        folder?.uri,
        this.prepareEnv(environment),
      )
      if (resolvedValue !== undefined) {
        expr.resolve(replacement, String(resolvedValue))
      }
    }

    return expr.toObject()
  }

  public async resolveAsync<T>(
    folder: IWorkspaceFolderData | undefined,
    config: T,
  ): Promise<T extends ConfigurationResolverExpression<infer R> ? R : T> {
    const expr = ConfigurationResolverExpression.parse(config, this._platform)

    for (const replacement of expr.unresolved()) {
      const resolvedValue = await this.evaluateSingleVariable(replacement, folder?.uri)
      if (resolvedValue !== undefined) {
        expr.resolve(replacement, String(resolvedValue))
      }
    }

    return expr.toObject() as T extends ConfigurationResolverExpression<infer R> ? R : T
  }

  public contributeVariable(variable: string, resolution: () => Promise<string | undefined>): void {
    if (this._contributedVariables.has(variable)) {
      throw new Error('Variable ' + variable + ' is contributed twice.')
    } else {
      this.resolvableVariables.add(variable)
      this._contributedVariables.set(variable, resolution)
    }
  }

  private fsPath(displayUri: URI): string {
    return displayUri.fsPath
  }

  protected async evaluateSingleVariable(
    replacement: Replacement,
    folderUri: URI | undefined,
    processEnvironment?: IProcessEnvironment,
    commandValueMapping?: Record<string, IResolvedValue>,
  ): Promise<IResolvedValue | string | undefined> {
    const environment: Environment = {
      env:
        processEnvironment !== undefined
          ? processEnvironment
          : this._envVariablesPromise
            ? await this._envVariablesPromise
            : undefined,
      userHome:
        processEnvironment !== undefined
          ? undefined
          : this._userHomePromise
            ? await this._userHomePromise
            : undefined,
    }

    const { name: variable, arg: argument } = replacement

    // common error handling for all variables that require an open editor
    const getFilePath = (variableKind: VariableKind): string => {
      const filePath = this._context.getFilePath()
      if (filePath) {
        return normalizeDriveLetter(filePath)
      }
      throw new VariableError(
        variableKind,
        `Variable ${replacement.id} can not be resolved. Please open an editor.`,
      )
    }

    // common error handling for all variables that require an open editor
    const getFolderPathForFile = (variableKind: VariableKind): string => {
      const filePath = getFilePath(variableKind) // throws error if no editor open
      if (this._context.getWorkspaceFolderPathForFile) {
        const folderPath = this._context.getWorkspaceFolderPathForFile()
        if (folderPath) {
          return normalizeDriveLetter(folderPath)
        }
      }
      throw new VariableError(
        variableKind,
        `Variable ${replacement.id}: can not find workspace folder of '${basename(filePath)}'.`,
      )
    }

    // common error handling for all variables that require an open folder and accept a folder name argument
    const getFolderUri = (variableKind: VariableKind): URI => {
      if (argument) {
        const folder = this._context.getFolderUri(argument)
        if (folder) {
          return folder
        }
        throw new VariableError(
          variableKind,
          `Variable ${variableKind} can not be resolved. No such folder '${argument}'.`,
        )
      }

      if (folderUri) {
        return folderUri
      }

      if (this._context.getWorkspaceFolderCount() > 1) {
        throw new VariableError(
          variableKind,
          `Variable ${variableKind} can not be resolved in a multi folder workspace. Scope this variable using ':' and a workspace folder name.`,
        )
      }
      throw new VariableError(
        variableKind,
        `Variable ${variableKind} can not be resolved. Please open a folder.`,
      )
    }

    switch (variable) {
      case 'env':
        if (argument) {
          if (environment.env) {
            const env =
              environment.env[this._platform === 'win32' ? argument.toLowerCase() : argument]
            if (typeof env === 'string') {
              return env
            }
          }
          return ''
        }
        throw new VariableError(
          VariableKind.Env,
          `Variable ${replacement.id} can not be resolved because no environment variable name is given.`,
        )

      case 'config':
        if (argument) {
          const config = this._context.getConfigurationValue(folderUri, argument)
          if (config === undefined || config === null) {
            throw new VariableError(
              VariableKind.Config,
              `Variable ${replacement.id} can not be resolved because setting '${argument}' not found.`,
            )
          }
          if (typeof config === 'object') {
            throw new VariableError(
              VariableKind.Config,
              `Variable ${replacement.id} can not be resolved because '${argument}' is a structured value.`,
            )
          }
          return config
        }
        throw new VariableError(
          VariableKind.Config,
          `Variable ${replacement.id} can not be resolved because no settings name is given.`,
        )

      case 'command':
        return this.resolveFromMap(
          VariableKind.Command,
          replacement.id,
          argument,
          commandValueMapping,
          'command',
        )

      case 'input':
        return this.resolveFromMap(
          VariableKind.Input,
          replacement.id,
          argument,
          commandValueMapping,
          'input',
        )

      case 'extensionInstallFolder':
        if (argument) {
          const ext = await this._context.getExtension(argument)
          if (!ext) {
            throw new VariableError(
              VariableKind.ExtensionInstallFolder,
              `Variable ${replacement.id} can not be resolved because the extension ${argument} is not installed.`,
            )
          }
          return this.fsPath(ext.extensionLocation)
        }
        throw new VariableError(
          VariableKind.ExtensionInstallFolder,
          `Variable ${replacement.id} can not be resolved because no extension name is given.`,
        )

      default: {
        switch (variable) {
          case 'workspaceRoot':
          case 'workspaceFolder': {
            const uri = getFolderUri(VariableKind.WorkspaceFolder)
            return uri ? normalizeDriveLetter(this.fsPath(uri)) : undefined
          }

          case 'cwd': {
            if (!folderUri && !argument) {
              return environment.userHome ?? '.'
            }
            const uri = getFolderUri(VariableKind.Cwd)
            return uri ? normalizeDriveLetter(this.fsPath(uri)) : undefined
          }

          case 'workspaceRootFolderName':
          case 'workspaceFolderBasename': {
            const uri = getFolderUri(VariableKind.WorkspaceFolderBasename)
            return uri ? normalizeDriveLetter(basename(this.fsPath(uri))) : undefined
          }

          case 'userHome':
            if (environment.userHome) {
              return environment.userHome
            }
            throw new VariableError(
              VariableKind.UserHome,
              `Variable ${replacement.id} can not be resolved. UserHome path is not defined`,
            )

          case 'lineNumber': {
            const lineNumber = this._context.getLineNumber()
            if (lineNumber) {
              return lineNumber
            }
            throw new VariableError(
              VariableKind.LineNumber,
              `Variable ${replacement.id} can not be resolved. Make sure to have a line selected in the active editor.`,
            )
          }

          case 'columnNumber': {
            const columnNumber = this._context.getColumnNumber()
            if (columnNumber) {
              return columnNumber
            }
            throw new Error(
              `Variable ${replacement.id} can not be resolved. Make sure to have a column selected in the active editor.`,
            )
          }

          case 'selectedText': {
            const selectedText = this._context.getSelectedText()
            if (selectedText) {
              return selectedText
            }
            throw new VariableError(
              VariableKind.SelectedText,
              `Variable ${replacement.id} can not be resolved. Make sure to have some text selected in the active editor.`,
            )
          }

          case 'file':
            return getFilePath(VariableKind.File)

          case 'fileWorkspaceFolder':
            return getFolderPathForFile(VariableKind.FileWorkspaceFolder)

          case 'fileWorkspaceFolderBasename':
            return basename(getFolderPathForFile(VariableKind.FileWorkspaceFolderBasename))

          case 'relativeFile':
            if (folderUri || argument) {
              return relativePath(
                this.fsPath(getFolderUri(VariableKind.RelativeFile)),
                getFilePath(VariableKind.RelativeFile),
                this._platform,
              )
            }
            return getFilePath(VariableKind.RelativeFile)

          case 'relativeFileDirname': {
            const dir = dirname(getFilePath(VariableKind.RelativeFileDirname))
            if (folderUri || argument) {
              const relative = relativePath(
                this.fsPath(getFolderUri(VariableKind.RelativeFileDirname)),
                dir,
                this._platform,
              )
              return relative.length === 0 ? '.' : relative
            }
            return dir
          }

          case 'fileDirname':
            return dirname(getFilePath(VariableKind.FileDirname))

          case 'fileExtname':
            return extname(getFilePath(VariableKind.FileExtname))

          case 'fileBasename':
            return basename(getFilePath(VariableKind.FileBasename))

          case 'fileBasenameNoExtension': {
            const base = basename(getFilePath(VariableKind.FileBasenameNoExtension))
            return base.slice(0, base.length - extname(base).length)
          }

          case 'fileDirnameBasename':
            return basename(dirname(getFilePath(VariableKind.FileDirnameBasename)))

          case 'execPath': {
            const ep = this._context.getExecPath()
            if (ep) {
              return ep
            }
            return replacement.id
          }

          case 'pathSeparator':
          case '/':
            return pathSeparator(this._platform)

          default: {
            try {
              return this.resolveFromMap(
                VariableKind.Unknown,
                replacement.id,
                argument,
                commandValueMapping,
                undefined,
              )
            } catch {
              return replacement.id
            }
          }
        }
      }
    }
  }

  private resolveFromMap(
    variableKind: VariableKind,
    match: string,
    argument: string | undefined,
    commandValueMapping: Record<string, IResolvedValue> | undefined,
    prefix: string | undefined,
  ): string {
    if (argument && commandValueMapping) {
      const v =
        prefix === undefined
          ? commandValueMapping[argument]
          : commandValueMapping[prefix + ':' + argument]
      if (typeof v?.value === 'string') {
        return v.value
      }
      throw new VariableError(
        variableKind,
        `Variable ${match} can not be resolved because the command has no value.`,
      )
    }
    return match
  }
}
