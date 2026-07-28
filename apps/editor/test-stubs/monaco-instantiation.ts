/* Test stub for monaco's deep instantiation ESM path. The real module pulls in
 * monaco's DI runtime which happy-dom tests don't need; MonacoLoader only uses
 * IInstantiationService as the StandaloneServices.get lookup key (see
 * monacoHoverDelegateGuard), so any unique token works.
 */

export const IInstantiationService = { id: 'instantiationService' }
