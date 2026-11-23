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
  TRACKER_APP_URL_SETTING_KEY,
  TRACKER_BOARD_SETTING_KEY,
  TRACKER_CATEGORY_SETTING_KEY,
  TRACKER_PROVIDER_ID,
  TRACKER_SERVER_URL_SETTING_KEY,
  ISSUE_REPORTER_PROVIDER_SETTING_KEY,
  TrackerDefaults,
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
          'editor.codeActionsOnSave': {
            type: 'object',
            default: {},
            additionalProperties: {
              type: ['string', 'boolean'],
              enum: ['always', 'explicit', 'never', true, false],
            },
            description: localize(
              'settings.editor.codeActionsOnSave.description',
              'Code actions to run on save, keyed by action kind (e.g. "source.organizeImports", "source.fixAll"). "always" runs on every save, "explicit" only on explicit saves, "never" disables the kind.',
            ),
          },
          'vim.enabled': {
            type: 'boolean',
            default: false,
            description: localize(
              'settings.vim.enabled.description',
              'Enable Vim keybindings (Normal/Insert modes) across the workbench: editors, lists, tab strips, Activity Bar, Settings, notifications and Chat, plus terminal Normal mode. In Normal mode, h/j/k/l move, w/b/e jump by word, gg/G go to the first/last line, and Ctrl+F/B/D/U page.',
            ),
          },
          'vim.showStatusBar': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.vim.showStatusBar.description',
              'Show the current Vim mode (NORMAL / INSERT / VISUAL ...), pending keys and unsupported-key notices in the status bar while any active Vim surface holds the keyboard.',
            ),
          },
          'vim.autoSwitchInputMethod': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.vim.autoSwitchInputMethod.description',
              'Switch the OS input method to English in Normal mode and restore it in Insert mode, so a Chinese IME does not type into the buffer. Windows only; ignored elsewhere.',
            ),
          },
          'vim.searchCaseSensitivity': {
            type: 'string',
            default: 'smart',
            enum: ['smart', 'sensitive', 'insensitive'],
            enumItemLabels: {
              smart: localize('settings.vim.searchCaseSensitivity.smart', 'Smart case'),
              sensitive: localize('settings.vim.searchCaseSensitivity.sensitive', 'Match case'),
              insensitive: localize(
                'settings.vim.searchCaseSensitivity.insensitive',
                'Ignore case',
              ),
            },
            description: localize(
              'settings.vim.searchCaseSensitivity.description',
              'Controls case sensitivity for Vim `/` and `?` searches. "smart" matches case only when the pattern contains an uppercase letter; `\\c`/`\\C` override it per search.',
            ),
          },
          'vim.highlightSearch': {
            type: 'boolean',
            default: false,
            description: localize(
              'settings.vim.highlightSearch.description',
              'Highlight all Vim search matches and keep them updated while editing. Press Escape in Normal mode to clear them (`:nohlsearch`). Large files are capped.',
            ),
          },
          'vim.whichKey': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.vim.whichKey.description',
              'After a multi-key prefix such as the leader, pause briefly to list the keys that can follow and what they do.',
            ),
          },
          'vim.useSystemClipboard': {
            type: 'boolean',
            default: false,
            description: localize(
              'settings.vim.useSystemClipboard.description',
              'Sync the editor Vim unnamed register with the system clipboard: y/d/c write to it, p/P paste from it.',
            ),
          },
          'vim.leader': {
            type: 'string',
            default: 'space',
            description: localize(
              'settings.vim.leader.description',
              'Vim leader key token (default `space`). Leader mappings such as `<leader>e` use it.',
            ),
          },
          'vim.sequenceTimeoutMs': {
            type: 'number',
            default: 800,
            minimum: 1,
            description: localize(
              'settings.vim.sequenceTimeoutMs.description',
              'How long a pending Vim sequence (count or prefix) waits for the next key before resetting.',
            ),
          },
          'vim.reservedKeys': {
            type: 'array',
            items: { type: 'string' },
            default: ['escape', 'ctrl+[', 'i', 'a', ':', '/', '?', '<leader>'],
            description: localize(
              'settings.vim.reservedKeys.description',
              'Keys Vim keeps even when a User keybinding with the same stroke exists. All other keys yield to User bindings.',
            ),
          },
          'vim.passThroughUnmappedKeys': {
            type: 'boolean',
            default: false,
            description: localize(
              'settings.vim.passThroughUnmappedKeys.description',
              'Let unmapped printable keys reach list/menu/overlay surfaces and the terminal in Normal mode instead of swallowing them.',
            ),
          },
          'vim.keymap': {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                keys: { type: 'array', items: { type: 'string' } },
                command: { type: 'string' },
                args: { type: ['object', 'array', 'string', 'number', 'boolean'] },
                when: { type: 'string' },
                surfaces: { type: 'array', items: { type: 'string' } },
              },
            },
            default: [],
            description: localize(
              'settings.vim.keymap.description',
              'User Vim mappings. An entry with an existing `id` overrides that built-in entry and inherits any field it omits (keys, command, surfaces, when). Other entries are added and need `keys` and `command`. A `command` starting with `-` removes a mapping, like a keybindings.json "-command" entry: `{ "id": "list.delete", "command": "-" }` or `{ "keys": ["d", "d"], "command": "-list.delete" }`. Keys use Vim tokens (`j`, `G`, `ctrl+d`, `<leader>`); `surfaces` defaults to every non-editor surface (and the editor for `<leader>` chords). Invalid entries are skipped with a warning in the console and in "Vim: Show Active Keymap".',
            ),
          },
          'vim.surfaces.lists': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.vim.surfaces.lists.description',
              'Enable Vim keys on trees, lists and the Markdown preview.',
            ),
          },
          'vim.surfaces.menus': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.vim.surfaces.menus.description',
              'Enable Vim keys on context menus and dropdown menus.',
            ),
          },
          'vim.surfaces.overlays': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.vim.surfaces.overlays.description',
              'Enable Vim keys on overlays such as notifications and the hover panel.',
            ),
          },
          'vim.surfaces.tabs': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.vim.surfaces.tabs.description',
              'Enable Vim keys on editor tab strips.',
            ),
          },
          'vim.surfaces.activityBar': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.vim.surfaces.activityBar.description',
              'Enable Vim keys on the activity bar and view container headers.',
            ),
          },
          'vim.surfaces.terminalNormalMode': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.vim.surfaces.terminalNormalMode.description',
              'Enable the terminal Normal Mode surface.',
            ),
          },
          'vim.surfaces.editor': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.vim.surfaces.editor.description',
              'Enable Vim keys in text editors (including the Output panel). When off, editors behave as plain Monaco even while vim.enabled is on; the leader chords stay inactive there too.',
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
              '**/.vs/**': true,
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
        id: 'workspace',
        // "Focus" rather than "Workspace": the Settings editor already has a
        // Workspace *scope* tab, and a same-named group in the table of
        // contents reads as the same thing. This group is only the focus keys.
        title: localize('settings.workspace', 'Focus'),
        properties: {
          'workspace.focusEnabled': {
            type: 'boolean',
            default: false,
            description: localize(
              'settings.workspace.focusEnabled.description',
              'Restrict the editor to the subfolders listed in `workspace.focusFolders`. Narrows the Explorer, search, Quick Open and file watching — a whitelist alternative to excluding noise folder by folder in a very large workspace.',
            ),
          },
          'workspace.focusFolders': {
            type: 'object',
            default: {},
            additionalProperties: { type: 'boolean' },
            description: localize(
              'settings.workspace.focusFolders.description',
              'Workspace-relative folders or individual files to focus on, e.g. `{ "Client": true, "Source/Client/Run.bat": true }`. Paths, not glob patterns — they are handed straight to the file scanner and watcher; an entry naming a file is treated as a file (watched directly, covered by search, and reconciled per-file by Perforce). Set an entry to false to cancel one inherited from a lower settings layer. Only takes effect when `workspace.focusEnabled` is on.',
            ),
          },
          'workspace.focusShowRootFiles': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.workspace.focusShowRootFiles.description',
              'Keep files sitting directly in the workspace root visible while focus mode is on. Folders leading to a focus folder are always shown, but their own files are hidden.',
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
          'search.searchOnType': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.search.searchOnType.description',
              'Search all files as you type. When disabled, the search runs only when you press Enter.',
            ),
          },
          'search.useIgnoreFiles': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.search.useIgnoreFiles.description',
              'Controls whether to use .gitignore and .ignore files when searching for text and file names. Disable to also search ignored files such as build output and the .git folder.',
            ),
          },
          'search.searchOnTypeDebouncePeriod': {
            type: 'number',
            default: 300,
            minimum: 0,
            description: localize(
              'settings.search.searchOnTypeDebouncePeriod.description',
              'How long to wait (in milliseconds) after you stop typing before running the search. Regular expressions that match almost everything wait proportionally longer. Only applies when Search On Type is enabled.',
            ),
          },
          'search.collapseResults': {
            type: 'string',
            enum: ['auto', 'alwaysCollapse', 'alwaysExpand'],
            default: 'alwaysExpand',
            enumDescriptions: [
              localize(
                'settings.search.collapseResults.auto',
                'Files with less than 10 results are expanded. Others are collapsed.',
              ),
              localize('settings.search.collapseResults.alwaysCollapse', 'Collapse every file.'),
              localize('settings.search.collapseResults.alwaysExpand', 'Expand every file.'),
            ],
            description: localize(
              'settings.search.collapseResults.description',
              'Whether the search results tree expands files by default. Collapsing keeps very large result sets responsive.',
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
              'Controls whether the editor checks for updates automatically. none: never; manual: only via the command; start: once shortly after launch; default: on launch and periodically. Releases marked as important download in the background under start / default and install on a normal quit.',
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
            enum: [TRACKER_PROVIDER_ID, GITHUB_PROVIDER_ID],
            default: DEFAULT_ISSUE_REPORTER_PROVIDER,
            description: localize(
              'settings.issueReporter.provider.description',
              'Target the Report Issue command submits to. Tracker supports attaching the diagnostics package; GitHub only pre-fills the issue body.',
            ),
          },
          [TRACKER_SERVER_URL_SETTING_KEY]: {
            type: 'string',
            default: TrackerDefaults.serverUrl,
            description: localize(
              'settings.issueReporter.tracker.serverUrl.description',
              'Tracker file server the diagnostics package is uploaded to when reporting an issue with attachments.',
            ),
          },
          [TRACKER_APP_URL_SETTING_KEY]: {
            type: 'string',
            default: TrackerDefaults.appUrl,
            description: localize(
              'settings.issueReporter.tracker.appUrl.description',
              'Tracker web app base URL. Report Issue opens its pre-filled addPost page.',
            ),
          },
          [TRACKER_BOARD_SETTING_KEY]: {
            type: 'string',
            default: TrackerDefaults.board,
            description: localize(
              'settings.issueReporter.tracker.board.description',
              'Tracker board (name or id) the issue report post is pre-filled for.',
            ),
          },
          [TRACKER_CATEGORY_SETTING_KEY]: {
            type: 'string',
            default: TrackerDefaults.category,
            description: localize(
              'settings.issueReporter.tracker.category.description',
              'Tracker category the issue report post is pre-filled for.',
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
