/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared diagnostic-stream (stderr) decoder. stdout typically carries a UTF-8
 *  wire protocol, but stderr can come from the Windows `cmd.exe` shim, which
 *  emits the console's OEM code page (e.g. GBK/936 on zh-CN). Decoding those as
 *  UTF-8 produces mojibake. We try strict UTF-8 first (covers a child's own Node
 *  stderr) and fall back to gb18030, which round-trips any byte sequence and is
 *  a superset of the GBK family. Previously duplicated in AcpHost / ExtensionHost.
 *--------------------------------------------------------------------------------------------*/

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true })
const OEM_FALLBACK = makeFallbackDecoder()

function makeFallbackDecoder(): InstanceType<typeof TextDecoder> {
  try {
    return new TextDecoder('gb18030')
  } catch {
    return new TextDecoder('utf-8')
  }
}

/** Decode a raw stderr chunk: strict UTF-8 first, gb18030 fallback on failure. */
export function decodeDiagnostic(buf: Buffer): string {
  try {
    return UTF8_STRICT.decode(buf)
  } catch {
    return OEM_FALLBACK.decode(buf)
  }
}
