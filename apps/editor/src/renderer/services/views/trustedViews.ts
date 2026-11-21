/*---------------------------------------------------------------------------------------------
 *  Shared componentKey for `contributes.trustedViews` entries with
 *  `location: 'view'`. Every translated view descriptor points here; the single
 *  bound component receives its own view id via props and mounts the extension
 *  module for that id (see TrustedViewHost).
 *--------------------------------------------------------------------------------------------*/

export const EXTENSION_TRUSTED_VIEW_COMPONENT_KEY = 'extension.trustedView'
