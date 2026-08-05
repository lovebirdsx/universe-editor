/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Seed built-in configuration schema. Acts as the source of truth for the
 *  Settings editor UI; future themes / extensions append more nodes via the
 *  same ConfigurationRegistry API.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationRegistry,
  Disposable,
  IWorkbenchContribution,
  localize,
} from '@universe-editor/platform'
import { GENERATED_EDITOR_OPTIONS } from './generated/editorOptionsSchema.generated.js'
import { DISPLAY_LANGUAGE_SETTING_KEY } from '../../shared/i18n/availableLocales.js'
import {
  EDITOR_FONT_FAMILY_DEFAULT,
  EDITOR_FONT_WEIGHT_DEFAULT,
  EDITOR_DISABLE_MONOSPACE_OPTIMIZATIONS_DEFAULT,
  EDITOR_LETTER_SPACING_DEFAULT,
  EDITOR_LINE_HEIGHT_DEFAULT,
  EDITOR_RENDER_LINE_HIGHLIGHT_DEFAULT,
  EDITOR_OCCURRENCES_HIGHLIGHT_DEFAULT,
  EDITOR_LINE_HIGHLIGHT_BACKGROUND_DEFAULT,
  EDITOR_LINE_HIGHLIGHT_BORDER_DEFAULT,
  OUTPUT_FONT_FAMILY_DEFAULT,
  OUTPUT_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_FAMILY_DEFAULT,
  TERMINAL_FONT_SIZE_DEFAULT,
  WORKBENCH_FONT_FAMILY_DEFAULT,
} from '../services/configuration/fontDefaults.js'
import {
  DEFAULT_STARTUP_WARNING_DEVELOPMENT_THRESHOLD_MS,
  DEFAULT_STARTUP_WARNING_RELEASE_THRESHOLD_MS,
  STARTUP_WARNING_DEVELOPMENT_THRESHOLD_KEY,
  STARTUP_WARNING_ENABLED_KEY,
  STARTUP_WARNING_RELEASE_THRESHOLD_KEY,
} from '../services/performance/startupPerformanceSettings.js'
import {
  DEFAULT_RESPONSIVENESS_WARN_THRESHOLD_MS,
  RESPONSIVENESS_ENABLED_KEY,
  RESPONSIVENESS_STATUS_WARNING_ENABLED_KEY,
  RESPONSIVENESS_WARN_THRESHOLD_KEY,
} from '../services/performance/interactionPerfSettings.js'
import { ERROR_COLLECTION_ENABLED_KEY } from '../services/telemetry/telemetryClientService.js'
import {
  DEFAULT_ISSUE_REPORTER_PROVIDER,
  GITHUB_PROVIDER_ID,
  ILOOP_APP_URL_SETTING_KEY,
  ILOOP_BOARD_SETTING_KEY,
  ILOOP_CATEGORY_SETTING_KEY,
  ILOOP_PROVIDER_ID,
  ILOOP_SERVER_URL_SETTING_KEY,
  ISSUE_REPORTER_PROVIDER_SETTING_KEY,
  ILoopDefaults,
} from '../../shared/issueReporter.js'

export class SettingsContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()

    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'workbench',
        title: localize('settings.title.workbench', 'Workbench'),
        properties: {
          [DISPLAY_LANGUAGE_SETTING_KEY]: {
            type: 'string',
            default: 'auto',
            enum: ['auto', 'en-US', 'zh-CN'],
            enumItemLabels: {
              auto: localize('settings.enum.auto', 'Use System Language'),
              'en-US': localize('settings.enum.en-US', 'English'),
              'zh-CN': localize('settings.enum.zh-CN', 'Simplified Chinese'),
            },
            description: localize(
              'settings.language.description',
              'Controls the display language. Changes require a restart.',
            ),
          },
          // `workbench.colorTheme` itself is owned by ThemesContribution: it
          // re-registers the node with the live theme enum on every registry
          // change (VSCode's updateColorThemeConfigurationSchemas equivalent).
          'workbench.colorCustomizations': {
            type: 'object',
            default: {},
            description: localize(
              'settings.workbench.colorCustomizations.description',
              'Overrides colors from the active color theme. Keys are color ids (e.g. "editor.background"), values are color strings or "default" to restore the theme value. Nest under "[Theme Name]" to scope overrides to one theme.',
            ),
          },
          'workbench.fontFamily': {
            type: 'string',
            default: WORKBENCH_FONT_FAMILY_DEFAULT,
            description: localize(
              'settings.workbench.fontFamily.description',
              'Controls the font family of the workbench UI.',
            ),
          },
        },
      }),
    )

    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'editor',
        title: localize('settings.editor', 'Editor'),
        properties: {
          // Full Monaco option schema extracted from VSCode (codegen). Spread
          // first so the hand-written entries below override any overlap. The
          // generator already excludes the hand-written keys, so in practice
          // there is no collision — this ordering is just defensive.
          ...GENERATED_EDITOR_OPTIONS,
          'editor.fontSize': {
            type: 'number',
            default: 14,
            minimum: 6,
            maximum: 100,
            description: localize(
              'settings.editor.fontSize.description',
              'Controls the editor font size in pixels.',
            ),
          },
          'editor.fontFamily': {
            type: 'string',
            default: EDITOR_FONT_FAMILY_DEFAULT,
            description: localize(
              'settings.editor.fontFamily.description',
              'Controls the editor font family.',
            ),
          },
          'editor.lineHeight': {
            type: 'number',
            default: EDITOR_LINE_HEIGHT_DEFAULT,
            minimum: 0,
            maximum: 150,
            description: localize(
              'settings.editor.lineHeight.description',
              'Controls the line height. Use 0 to compute from font size; values 0–8 are a multiplier of the font size; values ≥ 8 are used as pixels.',
            ),
          },
          'editor.letterSpacing': {
            type: 'number',
            default: EDITOR_LETTER_SPACING_DEFAULT,
            minimum: -5,
            maximum: 20,
            description: localize(
              'settings.editor.letterSpacing.description',
              'Controls the letter spacing in pixels.',
            ),
          },
          'editor.fontWeight': {
            type: 'string',
            default: EDITOR_FONT_WEIGHT_DEFAULT,
            enum: ['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900'],
            description: localize(
              'settings.editor.fontWeight.description',
              'Controls the font weight. Accepts "normal", "bold", or a number between 100 and 900.',
            ),
          },
          'editor.disableMonospaceOptimizations': {
            type: 'boolean',
            default: EDITOR_DISABLE_MONOSPACE_OPTIMIZATIONS_DEFAULT,
            description: localize(
              'settings.editor.disableMonospaceOptimizations.description',
              'Disables Monaco monospace rendering optimizations, forcing exact per-character width measurement on every line. Lines containing CJK (e.g. Chinese) text already use exact measurement, so leave this off (the default) unless you see horizontal jitter on pure-ASCII lines. Enabling it can make the current line look bolder/darker during IME composition.',
            ),
          },
          'editor.renderLineHighlight': {
            type: 'string',
            default: EDITOR_RENDER_LINE_HIGHLIGHT_DEFAULT,
            enum: ['none', 'gutter', 'line', 'all'],
            description: localize(
              'settings.editor.renderLineHighlight.description',
              'Controls how the current line is highlighted. "line" fills the whole line, "gutter" highlights only the line-number area, "all" does both, "none" disables it.',
            ),
          },
          'editor.occurrencesHighlight': {
            type: 'string',
            default: EDITOR_OCCURRENCES_HIGHLIGHT_DEFAULT,
            enum: ['off', 'singleFile', 'multiFile'],
            description: localize(
              'settings.editor.occurrencesHighlight.description',
              'Controls whether occurrences of the word under the cursor are highlighted automatically (without a selection). "off" disables it.',
            ),
          },
          'editor.lineHighlightBackground': {
            type: 'string',
            default: EDITOR_LINE_HIGHLIGHT_BACKGROUND_DEFAULT,
            description: localize(
              'settings.editor.lineHighlightBackground.description',
              'Background color of the current line highlight (CSS color, supports 8-digit alpha). Leave empty to use the theme default.',
            ),
          },
          'editor.lineHighlightBorder': {
            type: 'string',
            default: EDITOR_LINE_HIGHLIGHT_BORDER_DEFAULT,
            description: localize(
              'settings.editor.lineHighlightBorder.description',
              'Border color of the current line highlight. Leave empty to use the theme default (transparent, i.e. no border).',
            ),
          },
          'editor.languageFonts': {
            type: 'object',
            default: {},
            additionalProperties: {
              type: 'object',
              properties: {
                fontFamily: { type: 'string' },
                fontSize: { type: 'number' },
              },
              additionalProperties: false,
            },
            description: localize(
              'settings.editor.languageFonts.description',
              'Per-language font overrides. Keys are Monaco language ids (e.g. "markdown", "typescript"). Each value may have "fontFamily" (string) and/or "fontSize" (number).',
            ),
          },
          'editor.tabSize': {
            type: 'integer',
            default: 4,
            minimum: 1,
            maximum: 100,
            description: localize(
              'settings.editor.tabSize.description',
              'The number of spaces a tab is equal to. This setting is overridden based on the file contents when `editor.detectIndentation` is on.',
            ),
          },
          'editor.insertSpaces': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.editor.insertSpaces.description',
              'Insert spaces when pressing Tab. This setting is overridden based on the file contents when `editor.detectIndentation` is on.',
            ),
          },
          'editor.detectIndentation': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.editor.detectIndentation.description',
              'Controls whether `editor.tabSize` and `editor.insertSpaces` are automatically detected when a file is opened based on the file contents.',
            ),
          },
          'editor.wordWrap': {
            type: 'string',
            default: 'off',
            enum: ['off', 'on', 'wordWrapColumn', 'bounded'],
            enumItemLabels: {
              off: localize('settings.enum.wordWrap.off', 'Off'),
              on: localize('settings.enum.wordWrap.on', 'On'),
              wordWrapColumn: localize('settings.enum.wordWrap.wordWrapColumn', 'Word Wrap Column'),
              bounded: localize('settings.enum.wordWrap.bounded', 'Bounded'),
            },
            enumDescriptions: [
              localize('settings.editor.wordWrap.off', 'Lines will never wrap.'),
              localize('settings.editor.wordWrap.on', 'Lines will wrap at the viewport width.'),
              localize(
                'settings.editor.wordWrap.wordWrapColumn',
                'Lines will wrap at `editor.wordWrapColumn`.',
              ),
              localize(
                'settings.editor.wordWrap.bounded',
                'Lines will wrap at the minimum of viewport and `editor.wordWrapColumn`.',
              ),
            ],
            description: localize(
              'settings.editor.wordWrap.description',
              'Controls how lines should wrap.',
            ),
          },
          'editor.largeFileOptimizations': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.editor.largeFileOptimizations.description',
              'Special handling for large files to disable certain memory intensive features. Requires reopening the file to take effect.',
            ),
          },
          'editor.minimap.enabled': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.editor.minimap.description',
              'Controls whether the minimap is shown.',
            ),
          },
          'editor.semanticHighlighting.enabled': {
            type: ['boolean', 'string'],
            default: 'configuredByTheme',
            enum: [true, false, 'configuredByTheme'],
            enumItemLabels: {
              true: localize('settings.semanticHighlighting.true', 'Enabled'),
              false: localize('settings.semanticHighlighting.false', 'Disabled'),
              configuredByTheme: localize(
                'settings.semanticHighlighting.configuredByTheme',
                'Configured By Theme',
              ),
            },
            enumDescriptions: [
              localize(
                'settings.semanticHighlighting.true.description',
                'Semantic highlighting enabled for all color themes.',
              ),
              localize(
                'settings.semanticHighlighting.false.description',
                'Semantic highlighting disabled for all color themes.',
              ),
              localize(
                'settings.semanticHighlighting.configuredByTheme.description',
                "Semantic highlighting is configured by the current color theme's `semanticHighlighting` setting.",
              ),
            ],
            description: localize(
              'settings.editor.semanticHighlighting.description',
              'Controls whether the semanticHighlighting is shown for the languages that support it.',
            ),
          },
        },
      }),
    )

    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'files',
        title: localize('settings.files', 'Files'),
        properties: {
          'files.autoSave': {
            type: 'string',
            default: 'off',
            enum: ['off', 'afterDelay', 'onFocusChange'],
            enumItemLabels: {
              off: localize('settings.enum.off', 'Off'),
              afterDelay: localize('settings.enum.afterDelay', 'After Delay'),
              onFocusChange: localize('settings.enum.onFocusChange', 'On Focus Change'),
            },
            description: localize(
              'settings.files.autoSave.description',
              'Controls auto save of dirty files.',
            ),
          },
          'files.autoSaveDelay': {
            type: 'number',
            default: 1000,
            minimum: 100,
            description: localize(
              'settings.files.autoSaveDelay.description',
              'Auto save delay in milliseconds (when autoSave=afterDelay).',
            ),
          },
          'files.nativeDialog.enable': {
            type: 'boolean',
            default: false,
            description: localize(
              'settings.files.nativeDialog.enable.description',
              'Use the operating system file dialog for opening files/folders and saving, instead of the built-in dialog.',
            ),
          },
          'files.exclude': {
            type: 'object',
            default: {},
            additionalProperties: { type: 'boolean' },
            description: localize(
              'settings.files.exclude.description',
              'Configure glob patterns for excluding files and folders from the Explorer. Read from .vscode/settings.json too.',
            ),
          },
          'files.watcherExclude': {
            type: 'object',
            default: {
              '**/node_modules/**': true,
              '**/.git/**': true,
              '**/dist/**': true,
              '**/out/**': true,
              '**/.turbo/**': true,
              '**/.next/**': true,
            },
            additionalProperties: { type: 'boolean' },
            description: localize(
              'settings.files.watcherExclude.description',
              'Configure glob patterns of file paths to exclude from file watching.',
            ),
          },
        },
      }),
    )

    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'search',
        title: localize('settings.search', 'Search'),
        properties: {
          'search.exclude': {
            type: 'object',
            default: {
              '**/node_modules': true,
              '**/dist': true,
              '**/out': true,
              '**/.turbo': true,
              '**/.next': true,
              '**/.cache': true,
              '**/bower_components': true,
              '**/*.code-search': true,
            },
            additionalProperties: { type: 'boolean' },
            description: localize(
              'settings.search.exclude.description',
              'Configure glob patterns for excluding files and folders in searches and quick open. Inherits files.exclude.',
            ),
          },
          'search.threads': {
            type: 'number',
            default: 0,
            minimum: 0,
            description: localize(
              'settings.search.threads.description',
              'Number of threads used for workspace text search. 0 means automatic (CPU cores minus 2).',
            ),
          },
        },
      }),
    )

    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'explorer',
        title: localize('settings.explorer', 'Explorer'),
        properties: {
          'explorer.autoReveal': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.explorer.autoReveal.description',
              'Controls whether the Explorer should automatically reveal and select files when opening them.',
            ),
          },
          'workbench.tree.virtualizationThreshold': {
            type: 'number',
            default: 200,
            minimum: 10,
            description: localize(
              'settings.workbench.tree.virtualizationThreshold.description',
              'Number of visible tree items above which virtual scrolling is enabled.',
            ),
          },
          'workbench.chat.virtualizationThreshold': {
            type: 'number',
            default: 50,
            minimum: 10,
            description: localize(
              'settings.workbench.chat.virtualizationThreshold.description',
              'Number of agent session timeline items above which virtual scrolling is enabled.',
            ),
          },
        },
      }),
    )

    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'terminal',
        title: localize('settings.terminal', 'Terminal'),
        properties: {
          'terminal.external.windowsExec': {
            type: 'string',
            default: 'pwsh',
            enum: ['wt', 'cmd', 'powershell', 'pwsh'],
            enumItemLabels: {
              wt: localize('settings.enum.terminal.wt', 'Windows Terminal'),
              cmd: localize('settings.enum.terminal.cmd', 'Command Prompt'),
              powershell: localize('settings.enum.terminal.powershell', 'PowerShell'),
              pwsh: localize('settings.enum.terminal.pwsh', 'PowerShell Core'),
            },
            description: localize(
              'settings.terminal.external.windowsExec.description',
              'Which terminal to launch on Windows when running "Open in External Terminal".',
            ),
          },
          'terminal.integrated.profiles.windows': {
            type: 'object',
            default: {},
            additionalProperties: {
              anyOf: [
                { type: 'null' },
                {
                  type: 'object',
                  properties: {
                    path: {
                      anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
                    },
                    args: { type: 'array', items: { type: 'string' } },
                    env: { type: 'object' },
                  },
                },
              ],
            },
            description: localize(
              'settings.terminal.integrated.profiles.windows.description',
              'Terminal profiles on Windows, e.g. { "Git Bash": null, "My Shell": { "path": "C:\\\\bin\\\\sh.exe", "args": ["-l"] } }. A profile set to null removes the auto-detected one of the same name; an object overrides only the fields it declares.',
            ),
          },
          'terminal.integrated.profiles.osx': {
            type: 'object',
            default: {},
            additionalProperties: {
              anyOf: [
                { type: 'null' },
                {
                  type: 'object',
                  properties: {
                    path: {
                      anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
                    },
                    args: { type: 'array', items: { type: 'string' } },
                    env: { type: 'object' },
                  },
                },
              ],
            },
            description: localize(
              'settings.terminal.integrated.profiles.osx.description',
              'Terminal profiles on macOS. A profile set to null removes the auto-detected one of the same name; an object overrides only the fields it declares.',
            ),
          },
          'terminal.integrated.profiles.linux': {
            type: 'object',
            default: {},
            additionalProperties: {
              anyOf: [
                { type: 'null' },
                {
                  type: 'object',
                  properties: {
                    path: {
                      anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
                    },
                    args: { type: 'array', items: { type: 'string' } },
                    env: { type: 'object' },
                  },
                },
              ],
            },
            description: localize(
              'settings.terminal.integrated.profiles.linux.description',
              'Terminal profiles on Linux. A profile set to null removes the auto-detected one of the same name; an object overrides only the fields it declares.',
            ),
          },
          'terminal.integrated.defaultProfile.windows': {
            type: 'string',
            default: '',
            description: localize(
              'settings.terminal.integrated.defaultProfile.windows.description',
              'The default terminal profile name on Windows (from the profiles list). Leave empty to use PowerShell.',
            ),
          },
          'terminal.integrated.defaultProfile.osx': {
            type: 'string',
            default: '',
            description: localize(
              'settings.terminal.integrated.defaultProfile.osx.description',
              'The default terminal profile name on macOS (from the profiles list). Leave empty to use the login shell.',
            ),
          },
          'terminal.integrated.defaultProfile.linux': {
            type: 'string',
            default: '',
            description: localize(
              'settings.terminal.integrated.defaultProfile.linux.description',
              'The default terminal profile name on Linux (from the profiles list). Leave empty to use the login shell.',
            ),
          },
          'terminal.integrated.useWslProfiles': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.terminal.integrated.useWslProfiles.description',
              'Controls whether or not WSL distros are shown in the terminal profile list (Windows only).',
            ),
          },
          'terminal.integrated.cwd': {
            type: 'string',
            default: '',
            description: localize(
              'settings.terminal.integrated.cwd.description',
              'Default working directory for new integrated terminals. Supports variables like ${workspaceFolder}, ${userHome} and ${env:NAME}. Leave empty to use workspace root.',
            ),
          },
          'terminal.integrated.scrollback': {
            type: 'number',
            default: 5000,
            minimum: 0,
            description: localize(
              'settings.terminal.integrated.scrollback.description',
              'Maximum number of lines kept in the terminal scrollback (history). Restored when switching back to a terminal editor. Set to 0 for unlimited.',
            ),
          },
          'terminal.integrated.fontSize': {
            type: 'number',
            default: TERMINAL_FONT_SIZE_DEFAULT,
            minimum: 6,
            maximum: 32,
            description: localize(
              'settings.terminal.integrated.fontSize.description',
              'Controls the font size (in pixels) of the terminal.',
            ),
          },
          'terminal.integrated.fontFamily': {
            type: 'string',
            default: TERMINAL_FONT_FAMILY_DEFAULT,
            description: localize(
              'settings.terminal.integrated.fontFamily.description',
              'Controls the font family of the terminal.',
            ),
          },
        },
      }),
    )

    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'update',
        title: localize('settings.update', 'Update'),
        properties: {
          'update.mode': {
            type: 'string',
            default: 'default',
            enum: ['none', 'manual', 'start', 'default'],
            enumItemLabels: {
              none: localize('settings.enum.update.none', 'Never Check'),
              manual: localize('settings.enum.update.manual', 'Manual'),
              start: localize('settings.enum.update.start', 'Check on Startup'),
              default: localize('settings.enum.update.default', 'Check Automatically'),
            },
            description: localize(
              'settings.update.mode.description',
              'Controls whether the editor checks for updates automatically. none: never; manual: only via the command; start: once shortly after launch; default: on launch and periodically.',
            ),
          },
          'update.checkIntervalMinutes': {
            type: 'number',
            default: 1440,
            minimum: 0,
            description: localize(
              'settings.update.checkIntervalMinutes.description',
              'How often (in minutes) to check for updates while running. 0 disables periodic checks.',
            ),
          },
        },
      }),
    )

    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'performance',
        title: localize('settings.performance', 'Performance'),
        properties: {
          [STARTUP_WARNING_ENABLED_KEY]: {
            type: 'boolean',
            default: import.meta.env.DEV,
            description: localize(
              'settings.performance.startupWarning.enabled.description',
              'Controls whether slow startup warnings are shown in the status bar.',
            ),
          },
          [STARTUP_WARNING_RELEASE_THRESHOLD_KEY]: {
            type: 'number',
            default: DEFAULT_STARTUP_WARNING_RELEASE_THRESHOLD_MS,
            minimum: 0,
            description: localize(
              'settings.performance.startupWarning.releaseThresholdMs.description',
              'Show a startup warning in release builds only when startup exceeds this many milliseconds.',
            ),
          },
          [STARTUP_WARNING_DEVELOPMENT_THRESHOLD_KEY]: {
            type: 'number',
            default: DEFAULT_STARTUP_WARNING_DEVELOPMENT_THRESHOLD_MS,
            minimum: 0,
            description: localize(
              'settings.performance.startupWarning.developmentThresholdMs.description',
              'Show a startup warning in development builds only when startup exceeds this many milliseconds.',
            ),
          },
          [RESPONSIVENESS_ENABLED_KEY]: {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.performance.responsiveness.enabled.description',
              'Continuously monitor interaction responsiveness (typing, clicks, tab switches) and log slow interactions with attribution to the window log. Near-zero overhead.',
            ),
          },
          [RESPONSIVENESS_WARN_THRESHOLD_KEY]: {
            type: 'number',
            default: DEFAULT_RESPONSIVENESS_WARN_THRESHOLD_MS,
            minimum: 50,
            description: localize(
              'settings.performance.responsiveness.warnThresholdMs.description',
              'Log a warning for interactions slower than this many milliseconds.',
            ),
          },
          [RESPONSIVENESS_STATUS_WARNING_ENABLED_KEY]: {
            type: 'boolean',
            default: false,
            description: localize(
              'settings.performance.responsiveness.statusWarning.enabled.description',
              'Show a status bar warning when slow interactions occur frequently.',
            ),
          },
        },
      }),
    )

    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'telemetry',
        title: localize('settings.telemetry', 'Telemetry'),
        properties: {
          [ERROR_COLLECTION_ENABLED_KEY]: {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.telemetry.errorCollection.enabled.description',
              'Collect structured error records (fingerprint, redacted stack, occurrence count) into the local errors.jsonl log for diagnostics. Nothing is sent over the network.',
            ),
          },
        },
      }),
    )

    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'issueReporter',
        title: localize('settings.issueReporter', 'Issue Reporter'),
        properties: {
          [ISSUE_REPORTER_PROVIDER_SETTING_KEY]: {
            type: 'string',
            enum: [ILOOP_PROVIDER_ID, GITHUB_PROVIDER_ID],
            default: DEFAULT_ISSUE_REPORTER_PROVIDER,
            description: localize(
              'settings.issueReporter.provider.description',
              'Target the Report Issue command submits to. iLoop supports attaching the diagnostics package; GitHub only pre-fills the issue body.',
            ),
          },
          [ILOOP_SERVER_URL_SETTING_KEY]: {
            type: 'string',
            default: ILoopDefaults.serverUrl,
            description: localize(
              'settings.issueReporter.iloop.serverUrl.description',
              'iLoop file server (go-fastdfs) the diagnostics package is uploaded to when reporting an issue with attachments.',
            ),
          },
          [ILOOP_APP_URL_SETTING_KEY]: {
            type: 'string',
            default: ILoopDefaults.appUrl,
            description: localize(
              'settings.issueReporter.iloop.appUrl.description',
              'iLoop web app base URL. Report Issue opens its pre-filled addPost page.',
            ),
          },
          [ILOOP_BOARD_SETTING_KEY]: {
            type: 'string',
            default: ILoopDefaults.board,
            description: localize(
              'settings.issueReporter.iloop.board.description',
              'iLoop board (name or id) the issue report post is pre-filled for.',
            ),
          },
          [ILOOP_CATEGORY_SETTING_KEY]: {
            type: 'string',
            default: ILoopDefaults.category,
            description: localize(
              'settings.issueReporter.iloop.category.description',
              'iLoop category the issue report post is pre-filled for.',
            ),
          },
        },
      }),
    )

    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'output',
        title: localize('settings.output', 'Output'),
        properties: {
          'output.fontSize': {
            type: 'number',
            default: OUTPUT_FONT_SIZE_DEFAULT,
            minimum: 8,
            maximum: 32,
            description: localize(
              'settings.output.fontSize.description',
              'Controls the font size (in pixels) in the Output panel.',
            ),
          },
          'output.fontFamily': {
            type: 'string',
            default: OUTPUT_FONT_FAMILY_DEFAULT,
            description: localize(
              'settings.output.fontFamily.description',
              'Controls the font family in the Output panel.',
            ),
          },
        },
      }),
    )
  }
}
