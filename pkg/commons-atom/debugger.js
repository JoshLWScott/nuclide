/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 *
 * @flow
 * @format
 */

import type {DebuggerService} from 'atom-ide-ui';

import consumeFirstProvider from './consumeFirstProvider';

export function getDebuggerService(): Promise<DebuggerService> {
  return consumeFirstProvider('nuclide-debugger.remote');
}
