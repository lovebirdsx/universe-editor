/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  Source: https://github.com/microsoft/vscode/blob/main/src/vs/base/common/functional.ts
 *--------------------------------------------------------------------------------------------*/

/**
 * Given a function, returns a function that is only calling that function once.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export function createSingleCallFunction<T extends Function>(
  this: unknown,
  fn: T,
  fnDidRunCallback?: () => void,
): T {
  // eslint-disable-next-line @typescript-eslint/no-this-alias
  const _this = this
  let didCall = false
  let result: unknown

  return function (...args: unknown[]) {
    if (didCall) {
      return result
    }

    didCall = true
    if (fnDidRunCallback) {
      try {
        result = fn.apply(_this, args)
      } finally {
        fnDidRunCallback()
      }
    } else {
      result = fn.apply(_this, args)
    }

    return result
  } as unknown as T
}
