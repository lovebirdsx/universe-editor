/* Test stub for monaco's deep standaloneServices ESM path. The real module pulls
 * in the entire monaco runtime (and a .css import) which happy-dom can't load.
 * MonacoLoader only calls StandaloneServices.initialize(overrides) to lock our
 * override services in, so a no-op satisfies every test path. The override-init
 * regression test vi.mock()s this specifier to assert call ordering.
 */

export const StandaloneServices = {
  initialize: (_overrides: unknown): unknown => undefined,
}
