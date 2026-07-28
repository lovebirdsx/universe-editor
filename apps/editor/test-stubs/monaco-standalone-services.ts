/* Test stub for monaco's deep standaloneServices ESM path. The real module pulls
 * in the entire monaco runtime (and a .css import) which happy-dom can't load.
 * MonacoLoader only calls StandaloneServices.initialize(overrides) to lock our
 * override services in; the hover guard additionally resolves the root
 * IInstantiationService via StandaloneServices.get — the stub hands back a
 * no-op createInstance (the guard only feeds it a placeholder ctor).
 */

export const StandaloneServices = {
  initialize: (_overrides: unknown): unknown => undefined,
  get: (_serviceId: unknown): unknown => ({
    createInstance: (ctor: new (...args: unknown[]) => unknown, ...args: unknown[]) =>
      new ctor(...args),
  }),
}
