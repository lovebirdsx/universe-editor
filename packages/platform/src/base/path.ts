/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Kernel path helpers — re-export of `@universe-editor/primitives` plus nothing.
 *
 *  The implementations live in the leaf (shared with the extension SDK's bundle,
 *  which cannot reach the kernel's identity services). Re-exported by name — not
 *  `export *` — on purpose: the barrel turns everything here into platform's
 *  public API, and the leaf also carries helpers that are *not* kernel API
 *  (`normalizeSlashes`, whose strip-all semantics contradict this file's
 *  strip-one baseline).
 *
 *  Feed these an explicit platform (`HostPlatform` is structurally identical to
 *  the leaf's `PlatformName`); `normalizePlatform` stays in `host/hostService.ts`.
 *--------------------------------------------------------------------------------------------*/

export {
  arePathsEqual,
  basename,
  dirname,
  expandHomeDir,
  extname,
  getPathComparisonKey,
  isAbsolutePath,
  isCaseInsensitive,
  joinPath,
  normalizeDriveLetter,
  normalizeFsPath,
  pathSeparator,
  relativePath,
  relativePathUnder,
  toDisplayPath,
} from '@universe-editor/primitives'
