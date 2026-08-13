/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Per-connection URI transformer for the remote tunnel (VSCode URITransformer
 *  direction). The server translates `remote-ssh` <-> `file` inside its IPC codec
 *  so its file-service stack stays a headless local stack while the client keeps
 *  addressing resources by `remote-ssh://<authority>/...`.
 *--------------------------------------------------------------------------------------------*/

import type { UriComponents } from '../base/uri.js'
import { REMOTE_SCHEME } from '../remote/remoteProtocol.js'

export interface IURITransformer {
  transformIncoming(uri: UriComponents): UriComponents
  transformOutgoing(uri: UriComponents): UriComponents
}

const URI_MID = 1

type WireUri = UriComponents & { $mid: 1 }

export function createRemoteURITransformer(remoteAuthority: string): IURITransformer {
  return {
    transformIncoming(uri: UriComponents): UriComponents {
      if (uri.scheme !== REMOTE_SCHEME) return uri
      const wire: WireUri = {
        $mid: URI_MID,
        scheme: 'file',
        ...(uri.path ? { path: uri.path } : {}),
        ...(uri.query ? { query: uri.query } : {}),
        ...(uri.fragment ? { fragment: uri.fragment } : {}),
      }
      return wire
    },
    transformOutgoing(uri: UriComponents): UriComponents {
      if (uri.scheme !== 'file') return uri
      const wire: WireUri = {
        $mid: URI_MID,
        scheme: REMOTE_SCHEME,
        authority: remoteAuthority,
        ...(uri.path ? { path: uri.path } : {}),
        ...(uri.query ? { query: uri.query } : {}),
        ...(uri.fragment ? { fragment: uri.fragment } : {}),
      }
      return wire
    },
  }
}
