/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Boots the extension system: starts the host, pulls every extension's static
 *  contributions and translates them into the core registries (so contributed
 *  commands are immediately visible / lazily activatable), then fires the
 *  startup activation events. Per-command activation happens on first use via
 *  the bootstrap proxies the translator installs.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationTarget,
  Disposable,
  DisposableStore,
  IConfigurationService,
  IEditorResolverService,
  IFileService,
  IInstantiationService,
  ILoggerService,
  INotificationService,
  IThemeService,
  MutableDisposable,
  NullLogger,
  Severity,
  localize,
  type IDisposable,
  type ILogger,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import {
  STARTUP_ACTIVATION,
  STARTUP_FINISHED_ACTIVATION,
  customEditorActivationEvent,
  type ICustomEditorContribution,
  type IExtensionDescriptionDto,
} from '@universe-editor/extensions-common'
import { IExtensionHostClientService } from '../services/extensions/ExtensionHostClientService.js'
import { IExtensionMcpServersService } from '../services/extensions/extensionMcpServersService.js'
import { ExtensionPointTranslator } from '../services/extensions/ExtensionPointTranslator.js'
import { ITrustedViewService } from '../services/trustedViews/TrustedViewService.js'
import {
  TRUSTED_VIEW_EXTENSIONS_SETTING,
  isTrustedViewExtension,
  readTrustedViewExtensions,
  trustedViewIdsSignature,
} from '../services/trustedViews/trustedViewTrust.js'
import { ITextMateService } from '../services/textmate/textMateService.js'
import type { WorkbenchThemeService } from '../services/themes/workbenchThemeService.js'
import { IExtensionManagementService } from '../../shared/ipc/extensionManagementService.js'
import { IUserKeybindingsService } from '../services/keybindings/UserKeybindingsService.js'
import { IRemoteSchemaService } from '../../shared/ipc/remoteSchemaService.js'
import { resolveSchemaFromUrl } from '../services/preferences/schemaUrlResolver.js'
import { CustomEditorInput } from '../services/editor/CustomEditorInput.js'

export class ExtensionsContribution extends Disposable implements IWorkbenchContribution {
  private readonly _translator = this._register(new MutableDisposable<ExtensionPointTranslator>())
  private readonly _logger: ILogger
  /** Ids already notified as version-incompatible (memory-only dedup). */
  private readonly _seenVersionIncompatibleIds = new Set<string>()
  /** Extensions already prompted about trusted views in this renderer session. */
  private readonly _notifiedUntrustedTrustedViewIds = new Set<string>()
  /** Last translated contribution set, replayed after the trust list changes. */
  private _lastContributions: readonly IExtensionDescriptionDto[] = []
  private _trustedViewIdsSignature = ''

  constructor(
    @IExtensionHostClientService private readonly _client: IExtensionHostClientService,
    @IExtensionManagementService private readonly _management: IExtensionManagementService,
    @IUserKeybindingsService private readonly _userKeybindings: IUserKeybindingsService,
    @IConfigurationService private readonly _configuration: IConfigurationService,
    @IFileService private readonly _fileService: IFileService,
    @IRemoteSchemaService private readonly _remoteSchema: IRemoteSchemaService,
    @INotificationService private readonly _notification: INotificationService,
    @IEditorResolverService private readonly _editorResolver: IEditorResolverService,
    @IInstantiationService private readonly _instantiation: IInstantiationService,
    @IThemeService private readonly _themeService: WorkbenchThemeService,
    @ITextMateService private readonly _textMateService: ITextMateService,
    @IExtensionMcpServersService private readonly _extensionMcpServers: IExtensionMcpServersService,
    @ITrustedViewService private readonly _trustedViews: ITrustedViewService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger =
      loggerService?.createLogger({ id: 'extensionSchemas', name: 'Extension Schemas' }) ??
      new NullLogger()
    this._register(
      this._configuration.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration(TRUSTED_VIEW_EXTENSIONS_SETTING)) return
        const signature = trustedViewIdsSignature(readTrustedViewExtensions(this._configuration))
        if (signature === this._trustedViewIdsSignature) return
        // The trust list changed: an extension the user removed must be able to
        // prompt again on the next scan.
        this._notifiedUntrustedTrustedViewIds.clear()
        this._applyContributions(this._lastContributions)
      }),
    )
    void this._boot()
  }

  private async _boot(): Promise<void> {
    // A host relaunch (workspace swap / crash) re-emits its contributions; re-apply
    // them so contributed commands survive a restart that raced this initial boot.
    this._register(
      this._client.onDidChangeContributions((contributions) => {
        try {
          this._applyContributions(contributions)
        } catch (err) {
          this._logger.error(
            `failed to apply extension contributions: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }),
    )

    // Installing / uninstalling an extension re-scans the restricted tier so the
    // change takes effect without a full reload.
    this._register(
      this._management.onDidChangeExtensions(() => {
        void this._client.refreshExtensions().catch((err: unknown) => {
          this._logger.warn(`extension refresh failed: ${(err as Error).message}`)
        })
        void this._notifyVersionIncompatible()
      }),
    )

    try {
      const contributions = await this._client.getContributions()
      this._applyContributions(contributions)
    } catch {
      // The initial pull lost a race with a workspace/crash restart; that
      // restart's onDidChangeContributions event drives translation instead.
    }

    await this._client.activateByEvent(STARTUP_ACTIVATION)
    await this._client.activateByEvent(STARTUP_FINISHED_ACTIVATION)

    // Remote kill switch: disable any installed extension the control manifest
    // now marks malicious (found bad after it was installed) and tell the user.
    void this._quarantineMalicious()

    // One-shot: warn once per newly-seen extension whose `engines.universe` is
    // incompatible with this editor version (auto-disabled by the host).
    void this._notifyVersionIncompatible()
  }

  private async _notifyVersionIncompatible(): Promise<void> {
    try {
      const all = [
        ...(await this._management.getInstalled()),
        ...(await this._management.listBuiltinExtensions()),
        ...(await this._management.listDevExtensions()),
      ]
      const fresh = all.filter(
        (e) =>
          e.isVersionCompatible === false && !this._seenVersionIncompatibleIds.has(e.identifier),
      )
      if (fresh.length === 0) return
      for (const e of fresh) this._seenVersionIncompatibleIds.add(e.identifier)
      this._notification.notify({
        severity: Severity.Warning,
        message: localize(
          'extensions.versionIncompatible.disabled',
          'Disabled {count} extension(s) because they are incompatible with this version: {ids}',
          { count: fresh.length, ids: fresh.map((e) => e.identifier).join(', ') },
        ),
      })
    } catch (err) {
      this._logger.warn(`version-incompatible check failed: ${(err as Error).message}`)
    }
  }

  private async _quarantineMalicious(): Promise<void> {
    try {
      const disabled = await this._management.quarantineMalicious()
      if (disabled.length > 0) {
        this._notification.notify({
          severity: Severity.Warning,
          message: localize(
            'extensions.quarantined',
            'Disabled {count} extension(s) flagged as malicious: {ids}',
            { count: disabled.length, ids: disabled.join(', ') },
          ),
        })
      }
    } catch (err) {
      this._logger.warn(`malicious quarantine failed: ${(err as Error).message}`)
    }
  }

  /**
   * Bind a contributed custom editor to the editor resolver: one glob → editor
   * registration per selector. `priority: 'default'` auto-opens matching files
   * (priority 100, above the catch-all file editor); otherwise it's an "option"
   * only reachable via Reopen With (priority 1, below the file editor). Opening
   * fires the `onCustomEditor:<viewType>` activation event so the extension
   * registers its provider before the webview resolves. Returns a store the
   * translator disposes when contributions are re-applied.
   */
  private _registerCustomEditor(editor: ICustomEditorContribution): IDisposable {
    const store = new DisposableStore()
    const priority = editor.priority === 'option' ? 1 : 100
    for (const selector of editor.selector) {
      const glob = toResolverGlob(selector.filenamePattern)
      store.add(
        this._editorResolver.registerEditor(
          glob,
          {
            typeId: CustomEditorInput.TYPE_ID,
            displayName: editor.displayName,
            priority,
            viewType: editor.viewType,
            supportsDiff: editor.supportsDiff ?? false,
          },
          (uri) => {
            void this._client.activateByEvent(customEditorActivationEvent(editor.viewType))
            return this._instantiation.createInstance(CustomEditorInput, editor.viewType, uri)
          },
        ),
      )
    }
    return store
  }

  /** Dispose the previous translation and re-apply the current contribution set. */
  private _applyContributions(contributions: readonly IExtensionDescriptionDto[]): void {
    this._lastContributions = contributions
    const trustedIds = readTrustedViewExtensions(this._configuration)
    this._trustedViewIdsSignature = trustedViewIdsSignature(trustedIds)
    this._translator.clear()
    const translator = new ExtensionPointTranslator(
      (event) => this._client.activateByEvent(event),
      (id, args) => this._client.executeContributedCommand(id, args),
      (url) =>
        resolveSchemaFromUrl(
          url,
          {
            configuration: this._configuration,
            fileService: this._fileService,
            remoteSchema: this._remoteSchema,
            logger: this._logger,
          },
          'jsonValidation',
        ),
      this._logger,
      (editor) => this._registerCustomEditor(editor),
      (themes, context) => this._themeService.registerColorThemes(themes, context),
      (iconThemes, context) => this._themeService.registerFileIconThemes(iconThemes, context),
      (productIconThemes, context) =>
        this._themeService.registerProductIconThemes(productIconThemes, context),
      (grammars, context) => this._textMateService.registerGrammars(grammars, context),
      (languages, context) => this._textMateService.registerLanguages(languages, context),
      (colors) => this._themeService.registerColors(colors),
      (ext) => isTrustedViewExtension(ext, trustedIds),
      (registration) => this._trustedViews.registerView(registration),
      (ext) => this._notifyUntrustedTrustedViews(ext),
    )
    try {
      translator.translate(contributions)
    } catch (err) {
      this._logger.error(
        `failed to translate extension contributions: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    this._translator.value = translator

    // Extension-contributed MCP servers are not a core-registry concern — hand
    // the DTOs to their dedicated resolver (covers first boot + host restarts).
    this._extensionMcpServers.setContributions(contributions)

    // Extension commands are now in CommandsRegistry; re-apply VSCode/user
    // keybindings so bindings to those commands (skipped at startup) take effect.
    void this._userKeybindings.reload()
  }

  /**
   * An untrusted extension declares `contributes.trustedViews`: tell the user
   * once per extension per session. Trusting writes the id to the User layer
   * and re-translates so the views load without a reload; ignoring is silent.
   */
  private _notifyUntrustedTrustedViews(ext: IExtensionDescriptionDto): void {
    const key = ext.id.toLowerCase()
    if (this._notifiedUntrustedTrustedViewIds.has(key)) return
    this._notifiedUntrustedTrustedViewIds.add(key)
    const name = ext.displayName ?? ext.name ?? ext.id
    void this._notification.prompt(
      Severity.Warning,
      localize(
        'extensions.trustedViews.untrusted',
        'Extension {0} provides trusted views. Add it to the trusted list to load them.',
        { 0: name },
      ),
      [
        {
          label: localize('extensions.trustedViews.trust', 'Trust and Load'),
          run: () => this._trustTrustedViewExtension(ext.id),
        },
        {
          label: localize('extensions.trustedViews.ignore', 'Ignore'),
          isSecondary: true,
          run: () => {},
        },
      ],
    )
  }

  private _trustTrustedViewExtension(extensionId: string): void {
    const current = readTrustedViewExtensions(this._configuration)
    if (!current.some((id) => id.toLowerCase() === extensionId.toLowerCase())) {
      this._configuration.update(
        TRUSTED_VIEW_EXTENSIONS_SETTING,
        [...current, extensionId],
        ConfigurationTarget.User,
      )
    }
    const signature = trustedViewIdsSignature(readTrustedViewExtensions(this._configuration))
    if (signature !== this._trustedViewIdsSignature) {
      this._applyContributions(this._lastContributions)
    }
  }
}

/**
 * Turn a VSCode `customEditors` `filenamePattern` into an editor-resolver glob.
 * A pattern without a slash matches by basename anywhere (e.g. `*.pdf` becomes a
 * recursive basename glob), mirroring VSCode; a pattern that already includes a
 * path is used as-is.
 */
function toResolverGlob(filenamePattern: string): string {
  if (filenamePattern.includes('/')) return filenamePattern
  return `**/${filenamePattern}`
}
