/**
 * Extension manifest shapes — the `package.json` an extension ships. These are
 * TYPES ONLY (no validation), shared by all three processes: the host validates
 * raw JSON against these with zod (`extension-host/manifest.ts`), the renderer
 * consumes the already-validated DTOs to translate contribution points.
 *
 * Kept small and additive: commands / menus / keybindings / configuration are
 * here; views land in a later phase.
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
