/**
 * Extension manifest shapes — the `package.json` an extension ships. These are
 * TYPES ONLY (no validation), shared by all three processes: the host validates
 * raw JSON against these with zod (`extension-host/manifest.ts`), the renderer
 * consumes the already-validated DTOs to translate contribution points.
 *
 * Kept small and additive: commands / menus / keybindings / configuration /
 * views(Containers) and friends are declared here; each grows phase by phase.
 */

/** A single `contributes.commands[]` entry. */
export interface ICommandContribution {
  /** Command id, e.g. `git.commit`. The activation event is `onCommand:<command>`. */
  command: string
  /** Title shown in the command palette / menus. */
  title: string
  /** Optional category prefix shown in the palette (e.g. `Git`). */
  category?: string
  /** Optional icon identifier (resolved to a concrete icon by the renderer). */
  icon?: string
}

/**
 * A single menu item under a `contributes.menus[location][]`. `group` may carry
 * an `@order` suffix (VSCode convention), e.g. `navigation@1`. An item carries
 * either a `command` (runs it) or a `submenu` (opens a nested menu by its id).
 */
export interface IMenuContribution {
  command?: string
  /** Id of a `contributes.submenus[]` entry to nest here instead of a command. */
  submenu?: string
  when?: string
  group?: string
  /** Optional icon identifier (resolved to a concrete icon by the renderer). */
  icon?: string
}

/** A `contributes.submenus[]` entry: a reusable nested menu referenced by id. */
export interface ISubmenuContribution {
  id: string
  label: string
  /** Optional icon identifier (resolved to a concrete icon by the renderer). */
  icon?: string
}

/**
 * A single `contributes.keybindings[]` entry. `key` is a platform-neutral combo
 * (`ctrl+shift+g`); a space separates the two strokes of a chord (`ctrl+k ctrl+s`).
 */
export interface IKeybindingContribution {
  command: string
  key: string
  /** macOS-specific override. Reserved for a later phase; currently unused. */
  mac?: string
  when?: string
}

/** Schema for one configuration property (subset of JSON Schema). */
export interface IConfigurationPropertyContribution {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null'
  default?: unknown
  description?: string
  enum?: unknown[]
  minimum?: number
  maximum?: number
}

/** A `contributes.configuration` node (or one element of its array form). */
export interface IConfigurationContribution {
  title?: string
  properties: Record<string, IConfigurationPropertyContribution>
}

/**
 * One selector under a `contributes.customEditors[].selector[]`. Mirrors VSCode:
 * a glob against the resource path decides whether this custom editor can open a
 * file (e.g. `*.pdf`). The renderer translates it into an editor resolver binding.
 */
export interface ICustomEditorSelector {
  filenamePattern: string
}

/**
 * A single `contributes.customEditors[]` entry — a webview-backed editor an
 * extension registers for matching files (via `window.registerCustomEditorProvider`
 * at activation). `viewType` is the stable id both the manifest binding and the
 * runtime provider registration key on.
 */
export interface ICustomEditorContribution {
  viewType: string
  displayName: string
  selector: ICustomEditorSelector[]
  /** VSCode's `priority`: `'default'` (auto-open) or `'option'` (Reopen With only). */
  priority?: 'default' | 'option'
  /**
   * When true, this custom editor can render a two-content comparison (its
   * `resolveCustomEditor` reads `panel.diffContext`). It then participates in the
   * Explorer's built-in compare menu ("Select for Compare" / "Compare with
   * Selected") for matching resources — the workbench builds a WebviewDiffInput
   * instead of the text diff editor. Defaults to false.
   */
  supportsDiff?: boolean
}

/**
 * A single `contributes.jsonValidation[]` entry: associates a JSON schema with
 * the files matched by `fileMatch`. `url` is a path relative to the extension
 * root (e.g. `./schemas/entity.json`), mirroring VSCode's jsonValidation point.
 */
export interface IJsonValidationContribution {
  fileMatch: string | string[]
  url: string
}

/**
 * The host-resolved form of a jsonValidation entry. `fileMatch` is normalized to
 * an array. Exactly one of `schema` / `url` is set: a local file is read + parsed
 * by the host into an inline `schema` (Monaco's JSON worker can't fetch files);
 * an http(s) `url` is passed through verbatim for the renderer to download via
 * IRemoteSchemaService. `schema` is `unknown` so this shared package needn't
 * depend on platform's `IJSONSchema`.
 */
export interface IResolvedJsonValidation {
  fileMatch: string[]
  schema?: unknown
  /** Http(s) url passed through unresolved (renderer downloads it). */
  url?: string
}

/**
 * A single `contributes.themes[]` entry (VSCode color theme point). `path` is
 * relative to the extension root (e.g. `./themes/dark.json`); the renderer
 * resolves it against {@link IExtensionDescriptionDto.extensionLocation}.
 * `uiTheme` is the VSCode base-theme selector the workbench chrome derives
 * from (`vs` light / `vs-dark` dark / `hc-black` / `hc-light`).
 */
export interface IThemeContribution {
  /** Optional stable id; defaults to `label`. */
  id?: string
  label?: string
  description?: string
  uiTheme: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light'
  path: string
}

/** A single `contributes.iconThemes[]` entry (VSCode file icon theme point). */
export interface IIconThemeContribution {
  id: string
  label?: string
  path: string
}

/** A single `contributes.productIconThemes[]` entry (VSCode product icon point). */
export interface IProductIconThemeContribution {
  id: string
  label?: string
  path: string
}

/**
 * A single `contributes.colors[]` entry (VSCode color contribution point). The
 * id is what extensions reference via `new ThemeColor(id)`; each `defaults`
 * value is either a hex literal (`#RRGGBB` / `#RRGGBBAA`) or a reference to
 * another color id (resolved by the color registry).
 */
export interface IColorContribution {
  id: string
  description: string
  defaults: {
    light: string
    dark: string
    highContrastLight?: string
    highContrastDark?: string
  }
}

/**
 * A single `contributes.grammars[]` entry (VSCode TextMate grammar point).
 * `path` is relative to the extension root (e.g. `./syntaxes/ts.tmLanguage.json`);
 * the renderer resolves it against {@link IExtensionDescriptionDto.extensionLocation}.
 * Entries without `language` exist only to be injected into / included by other
 * grammars. `embeddedLanguages` maps a scope to a **language id** (the renderer
 * re-encodes it to the numeric encoded id before handing it to vscode-textmate).
 */
export interface IGrammarContribution {
  language?: string
  scopeName: string
  path: string
  embeddedLanguages?: Record<string, string>
  tokenTypes?: Record<string, 'comment' | 'string' | 'regex' | 'other'>
  injectTo?: string[]
  balancedBracketScopes?: string[]
  unbalancedBracketScopes?: string[]
}

/**
 * A single `contributes.languages[]` entry (VSCode language contribution point).
 * `id` is the language id; the association fields (`extensions` / `filenames` /
 * `filenamePatterns` / `mimetypes`) drive file→language detection, and
 * `configuration` points at a language-configuration.json (comments, brackets,
 * auto-closing/surrounding pairs, word pattern) relative to the extension root.
 */
export interface ILanguageContribution {
  id: string
  aliases?: string[]
  extensions?: string[]
  filenames?: string[]
  filenamePatterns?: string[]
  mimetypes?: string[]
  /** Path to a language-configuration.json (JSONC), relative to the extension root. */
  configuration?: string
}

/**
 * One entry under `contributes.mcpServers` (keyed by server name). A declarative
 * MCP server the editor injects into agent sessions as the lowest-priority
 * source — same-named user `acp.mcpServers` entries override it, and the entry
 * vanishes when the extension is uninstalled/disabled (never written to
 * settings.json). v1 supports stdio only. `command` / `args[]` / `env` values
 * may reference `${execPath}` (the editor executable) and `${extensionPath}`
 * (this extension's install root).
 */
export interface IMcpServerContribution {
  /** Required for stdio entries; the renderer skips (and warns on) entries without it. */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /**
   * Configuration key gating injection: when the setting resolves to `false`
   * the server is not injected (undefined/truthy injects). Editor-side
   * annotation only — never sent on the wire.
   */
  whenConfiguration?: string
}

/**
 * A single `contributes.viewsContainers.activitybar[]` entry — an extension-owned
 * ViewContainer shown in the activity bar (VSCode shape). `icon` accepts a
 * `$(codicon)`-style name or a plain icon name (resolved against the workbench's
 * icon map, falling back to a default glyph); file-path icons are a later phase.
 */
export interface IViewContainerContribution {
  id: string
  title: string
  icon: string
}

/**
 * A single view entry under `contributes.views[containerId][]`. The key is either
 * the `id` of a container the same extension declares in `viewsContainers`, or a
 * well-known built-in container key (e.g. `explorer`); unknown keys are skipped
 * with a warning by the renderer. `when` gates the view's visibility against
 * workbench context keys (re-evaluated live as they change); while it evaluates
 * false the view disappears from its container.
 */
export interface IViewContribution {
  id: string
  name: string
  when?: string
}

/** The `contributes.viewsContainers` block (VSCode shape; `panel` is a later phase). */
export interface IViewContainersContribution {
  activitybar?: IViewContainerContribution[]
}

/** The `contributes` block as declared in a manifest. Grows phase by phase. */
export interface IExtensionContributions {
  commands?: ICommandContribution[]
  /** Keyed by menu location, e.g. `commandPalette`, `scm/title`. */
  menus?: Record<string, IMenuContribution[]>
  /** Reusable nested menus referenced by `IMenuContribution.submenu`. */
  submenus?: ISubmenuContribution[]
  keybindings?: IKeybindingContribution[]
  configuration?: IConfigurationContribution | IConfigurationContribution[]
  jsonValidation?: IJsonValidationContribution[]
  /** Webview-backed editors registered for matching files. */
  customEditors?: ICustomEditorContribution[]
  themes?: IThemeContribution[]
  iconThemes?: IIconThemeContribution[]
  productIconThemes?: IProductIconThemeContribution[]
  grammars?: IGrammarContribution[]
  /** Language declarations: id + file associations + language configuration. */
  languages?: ILanguageContribution[]
  /** Custom theme colors referenced by `new ThemeColor(id)` in decorations. */
  colors?: IColorContribution[]
  /** Declarative MCP servers, keyed by server name (stdio only in v1). */
  mcpServers?: Record<string, IMcpServerContribution>
  /** Extension-owned view containers (activity bar). */
  viewsContainers?: IViewContainersContribution
  /** Tree views, keyed by the id of their home view container. */
  views?: Record<string, IViewContribution[]>
}

/**
 * The `contributes` block as the renderer sees it: identical to
 * {@link IExtensionContributions} except `jsonValidation` carries the
 * host-resolved (inlined) schemas rather than file-relative urls.
 */
export interface IExtensionContributionsDto extends Omit<
  IExtensionContributions,
  'jsonValidation'
> {
  jsonValidation?: IResolvedJsonValidation[]
}

/**
 * `repository` may be a plain url string or the npm-style `{ type, url }` object.
 * Marketplace UI only needs the url; both forms are accepted (additive).
 */
export type IExtensionRepository = string | { type?: string; url: string }

/** The subset of an extension `package.json` the host cares about. */
export interface IExtensionManifest {
  name: string
  version: string
  displayName?: string
  description?: string
  publisher?: string
  /** Entry module relative to the extension root (e.g. `dist/extension.js`). */
  main?: string
  engines: { universe: string }
  activationEvents?: string[]
  contributes?: IExtensionContributions
  /** VSCode-style capability declarations (currently: Workspace Trust support). */
  capabilities?: IExtensionCapabilities
  // --- Marketplace display metadata (all optional, purely additive) ---
  /** Category ids for filtering; see `EXTENSION_CATEGORIES`. */
  categories?: string[]
  /** Free-form search keywords. */
  keywords?: string[]
  /** Icon path relative to the extension root (recommended 128×128 png). */
  icon?: string
  /** Source repository link for the details page. */
  repository?: IExtensionRepository
  /** Homepage link for the details page. */
  homepage?: string
  /** SPDX license identifier. */
  license?: string
  /** Renders a "preview" badge in the marketplace. */
  preview?: boolean
}

/**
 * VSCode `capabilities.untrustedWorkspaces`. Declares whether the extension may
 * run in an untrusted workspace:
 *  - `true` — fully supported (runs even when untrusted).
 *  - `{ supported: false }` — not supported: the extension is NOT activated in an
 *    untrusted workspace (VSCode `DisabledByTrustRequirement`).
 *  - `{ supported: 'limited' }` — runs with reduced functionality; the extension
 *    itself checks `workspace.isTrusted` and disables the unsafe parts.
 *
 * An extension with a `main` entry that declares nothing defaults to requiring
 * trust (treated as `supported: false`), matching VSCode.
 */
export type ExtensionUntrustedWorkspaceSupport =
  | true
  | { readonly supported: false; readonly description: string }
  | {
      readonly supported: 'limited'
      readonly description: string
      readonly restrictedConfigurations?: readonly string[]
    }

export interface IExtensionCapabilities {
  readonly untrustedWorkspaces?: ExtensionUntrustedWorkspaceSupport
}

/** The three-way support type after applying the "has main → default false" rule. */
export type UntrustedWorkspaceSupportType = true | false | 'limited'

/**
 * Wire form of a URI. The RPC codec recognises the `$mid: 1` marker (stamped by
 * `URI.toJSON()`) and applies the per-connection file ↔ remote-ssh translation.
 * Kept structurally identical to platform's `UriComponents` so the two remain
 * assignable in both directions; this protocol package ships standalone, so it
 * defines its own copy rather than importing platform.
 */
export interface UriComponents {
  scheme: string
  authority?: string
  path?: string
  query?: string
  fragment?: string
}

/**
 * What the host sends the renderer per scanned extension. The renderer never
 * sees the filesystem — it translates these into the core registries. `id` is
 * `<publisher>.<name>` when a publisher is present, else `<name>`.
 */
export interface IExtensionDescriptionDto {
  readonly id: string
  readonly name: string
  readonly displayName?: string
  readonly activationEvents: readonly string[]
  readonly contributes: IExtensionContributionsDto
  /** Whether this extension has a `main` entry (activation gate applies only then). */
  readonly hasMain: boolean
  /** Declared untrusted-workspace support, verbatim from the manifest. */
  readonly untrustedWorkspaces?: ExtensionUntrustedWorkspaceSupport
  /**
   * URI of the extension's root folder. Contribution `path`s (themes, icon
   * themes, …) are relative to this; the renderer joins the two. In a remote
   * workspace the per-connection codec translates it file ↔ remote-ssh.
   */
  readonly extensionLocation: UriComponents
  /** True for extensions shipped with the app (built-in dir). */
  readonly extensionIsBuiltin: boolean
  /**
   * True for extensions loaded from a --extension-development-path root: they
   * bypass the Workspace Trust activation gate and show a "development" badge
   * in the Extensions UI. Deliberately separate from `extensionIsBuiltin` —
   * built-in also feeds distribution-side rules (not uninstallable) that must
   * not apply to a dev extension.
   */
  readonly extensionIsUnderDevelopment?: boolean
}

/**
 * Resolve an extension's effective untrusted-workspace support (VSCode
 * `getExtensionUntrustedWorkspaceSupportType`):
 *  - explicit declaration wins;
 *  - a UI-only extension (no `main`) needs no trust → `true`;
 *  - a `main` extension that declares nothing defaults to `false` (needs trust).
 */
export function getUntrustedWorkspaceSupportType(
  ext: Pick<IExtensionDescriptionDto, 'hasMain' | 'untrustedWorkspaces'>,
): UntrustedWorkspaceSupportType {
  const declared = ext.untrustedWorkspaces
  if (declared === true) return true
  if (declared) return declared.supported
  return ext.hasMain ? false : true
}
