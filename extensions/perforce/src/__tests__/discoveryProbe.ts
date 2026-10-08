/**
 * Discovery cross-checks the root `p4 info` reports against the client spec's
 * FIXED `Root` (`p4 -c <client> client -o`) before adopting it, and FAILS CLOSED
 * when it cannot read one — every unreadable spec disables the provider (see
 * `clientDiscovery.ts`). A spawn mock that answers only `p4 info` therefore
 * leaves `PerforceClient.create` returning undefined and every client the test
 * builds is null.
 *
 * So a spawn mock must answer this probe too, with the same root its `info`
 * answer reports: the tests model a single-Root client, whose spec says exactly
 * what `p4 info` says. `clientSpecReply(root)` is that answer; call it from the
 * mock's handler when `isClientSpecProbe(argv)` is true.
 */
export function isClientSpecProbe(argv: readonly string[]): boolean {
  return argv.includes('client') && argv.includes('-o')
}

/** `p4 -ztag client -o` output: the spec's fixed `Root` (capitalized key). */
export function clientSpecReply(root: string): string {
  return `... Root ${root}\n... Options noallwrite noclobber nocompress unlocked nomodtime rmdir\n\n`
}
