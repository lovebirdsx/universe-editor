/**
 *  Wire-boundary URI normalization for host→renderer RPC arguments. Extensions
 *  hand us raw UriComponents — hand-built, or extension-api `Uri.toJSON()` —
 *  and neither carries `$mid`, so the remote channel codec's URI transformer
 *  (keyed on that marker) would never see them and a remote host's `file:` uri
 *  would reach the renderer untranslated. Platform `URI.toJSON()` adds `$mid`;
 *  reviving here puts every extension-originated uri back on the codec's radar.
 */
import { URI } from '@universe-editor/platform'
import type { UriComponents } from '@universe-editor/extension-api'

export function reviveWireUri(uri: UriComponents): URI {
  return uri instanceof URI ? uri : URI.from(uri)
}
