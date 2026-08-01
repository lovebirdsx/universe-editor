/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Declarative table of this app's multi-source config items. Mechanism lives in
 *  @universe-editor/platform (ConfigResolver + sources); this is the policy:
 *  the concrete cli flags, UNIVERSE_* env conventions, and file fields.
 *--------------------------------------------------------------------------------------------*/

import { type ConfigItem, isHttpUrl } from '@universe-editor/platform'

/** Print usage and exit. */
export const HELP: ConfigItem<'boolean'> = {
  id: 'help',
  type: 'boolean',
  cli: 'help',
  cliAlias: 'h',
  description: '打印命令行用法并退出',
}

/** Print version and exit. */
export const VERSION: ConfigItem<'boolean'> = {
  id: 'version',
  type: 'boolean',
  cli: 'version',
  cliAlias: 'v',
  description: '打印版本号并退出',
}

/** userData directory override. CLI wins over env (matches legacy productPaths). */
export const USER_DATA_DIR: ConfigItem<'string'> = {
  id: 'userDataDir',
  type: 'string',
  cli: 'user-data-dir',
  env: 'UNIVERSE_USER_DATA_DIR',
  args: '<path>',
  description: '覆盖用户数据目录',
}

/**
 * Directory to load user settings.json / keybindings.json from. cli > env > file
 * (the UI-written pointer at <userData>/config-location.json) > default (userData
 * itself). Only relocates those two user-level files; global state and per-workspace
 * data stay under userData.
 */
export const CONFIG_DIR: ConfigItem<'string'> = {
  id: 'configDir',
  type: 'string',
  cli: 'config-dir',
  env: 'UNIVERSE_CONFIG_DIR',
  filePath: 'configDir',
  args: '<path>',
  description: '从指定目录加载用户设置（settings.json / keybindings.json）',
}

export const IS_E2E: ConfigItem<'boolean'> = {
  id: 'isE2E',
  type: 'boolean',
  env: 'UNIVERSE_E2E',
  default: false,
}

/** Dev renderer URL injected by electron-vite; undefined in packaged builds. */
export const RENDERER_URL: ConfigItem<'string'> = {
  id: 'rendererUrl',
  type: 'string',
  env: 'ELECTRON_RENDERER_URL',
}

/** Set by the VS Code debug task to delay renderer load for the Chrome debugger. */
export const RENDERER_DEBUG: ConfigItem<'boolean'> = {
  id: 'rendererDebug',
  type: 'boolean',
  env: 'VSCODE_RENDERER_DEBUG',
  default: false,
}

/** Auto-update feed URL override (packaged builds only). cli > env > file. */
export const UPDATE_URL: ConfigItem<'string'> = {
  id: 'updateUrl',
  type: 'string',
  cli: 'update-url',
  env: 'UNIVERSE_UPDATE_URL',
  filePath: 'updateUrl',
  args: '<url>',
  description: '覆盖自动更新服务器地址（仅打包版生效）',
  validate: isHttpUrl,
}

/** Extension marketplace gallery URL. cli > env > file. Empty ⇒ marketplace disabled. */
export const GALLERY_URL: ConfigItem<'string'> = {
  id: 'galleryUrl',
  type: 'string',
  cli: 'gallery-url',
  env: 'UNIVERSE_GALLERY_URL',
  filePath: 'galleryUrl',
  args: '<url>',
  description: '覆盖扩展市场地址',
  validate: isHttpUrl,
}

/**
 * Extension development roots (each is ONE extension's root containing package.json,
 * not a container directory). Repeatable; env form joins multiple roots with
 * path.delimiter. Presence switches the instance into extension-development mode:
 * no single-instance lock, isolated userData ("- ExtDev" flavor).
 */
export const EXTENSION_DEV_PATHS: ConfigItem<'string[]'> = {
  id: 'extensionDevPaths',
  type: 'string[]',
  cli: 'extension-development-path',
  env: 'UNIVERSE_EXTENSION_DEV_PATH',
  args: '<dir>',
  description: '从源码目录加载开发中的扩展（每个路径是一个扩展根目录）',
  validate: (paths) => paths.every((p) => p !== ''),
}

/** Start the extension host with --inspect bound to loopback on this port. */
export const INSPECT_EXTENSIONS: ConfigItem<'number'> = {
  id: 'inspectExtensionsPort',
  type: 'number',
  cli: 'inspect-extensions',
  env: 'UNIVERSE_INSPECT_EXTENSIONS',
  args: '<port>',
  description: '在指定端口启用扩展宿主调试（绑定 127.0.0.1）',
  validate: (p) => Number.isInteger(p) && p >= 1 && p <= 65535,
}

/** Like INSPECT_EXTENSIONS but breaks before user code (--inspect-brk). Wins when both are set. */
export const INSPECT_BRK_EXTENSIONS: ConfigItem<'number'> = {
  id: 'inspectBrkExtensionsPort',
  type: 'number',
  cli: 'inspect-brk-extensions',
  env: 'UNIVERSE_INSPECT_BRK_EXTENSIONS',
  args: '<port>',
  description: '在指定端口启用扩展宿主调试并在激活前断住（绑定 127.0.0.1）',
  validate: (p) => Number.isInteger(p) && p >= 1 && p <= 65535,
}

/** Platform data roots — env-only inputs to productPaths' identity resolution. */
export const APP_DATA: ConfigItem<'string'> = { id: 'appData', type: 'string', env: 'APPDATA' }
export const XDG_CONFIG_HOME: ConfigItem<'string'> = {
  id: 'xdgConfigHome',
  type: 'string',
  env: 'XDG_CONFIG_HOME',
}
export const HOME: ConfigItem<'string'> = { id: 'home', type: 'string', env: 'HOME' }
export const USER_PROFILE: ConfigItem<'string'> = {
  id: 'userProfile',
  type: 'string',
  env: 'USERPROFILE',
}

/** User-facing CLI options, in --help display order. */
export const CLI_OPTIONS: readonly ConfigItem[] = [
  HELP,
  VERSION,
  USER_DATA_DIR,
  CONFIG_DIR,
  UPDATE_URL,
  GALLERY_URL,
  EXTENSION_DEV_PATHS,
  INSPECT_EXTENSIONS,
  INSPECT_BRK_EXTENSIONS,
]
