'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import type {ServerConnection} from '../../nuclide-remote-connection/lib/ServerConnection';
import type {RemoteFile} from '../../nuclide-remote-connection/lib/RemoteFile';

import {getLogger} from '../../nuclide-logging';
import invariant from 'assert';
import {CompositeDisposable, TextBuffer} from 'atom';
import {track} from '../../nuclide-analytics';

const logger = getLogger();

// Do not attempt to diff files larger than this limit.
const DIFF_FILE_SIZE_LIMIT = 10000;

class NuclideTextBuffer extends TextBuffer {
  _connection: ServerConnection;
  fileSubscriptions: CompositeDisposable;
  /* $FlowFixMe */
  file: ?RemoteFile;
  conflict: boolean;
  _exists: boolean;

  // This is a counter that will be incremented after every successful save request.
  // We use this to accurately detect changes on disk - conflicts should not be reported
  // if any saves finished while fetching the updated contents.
  _saveID: number;

  constructor(connection: ServerConnection, params: any) {
    super(params);
    this._exists = true;
    this._connection = connection;
    this._saveID = 0;
    this.setPath(params.filePath);
    const encoding: string = (atom.config.get('core.fileEncoding'): any);
    this.setEncoding(encoding);
  }

  // Atom 1.4.0+ serializes TextBuffers with the ID generated by `getId`. When
  // a buffer is deserialized, it is looked up in the buffer cache by this key.
  // The logic there is setup to create a new buffer when there is a cache miss.
  // However, when there is no key, it's not looked up in cache, but rather by
  // its path. This behavior ensures that when a connection is reestablished,
  // a buffer exists with that path. See https://github.com/atom/atom/pull/9968.
  getId(): string {
    return '';
  }

  setPath(filePath: string): void {
    if (!this._connection) {
      // If this._connection is not set, then the superclass constructor is still executing.
      // NuclideTextBuffer's constructor will ensure setPath() is called once this.constructor
      // is set.
      return;
    }
    if (filePath === this.getPath()) {
      return;
    }
    if (filePath) {
      this.file = this.createFile(filePath);
      if (this.file !== null) {
        const file = this.file;
        file.setEncoding(this.getEncoding());
        this.subscribeToFile();
      }
    } else {
      this.file = null;
    }
    this.emitter.emit('did-change-path', this.getPath());
  }

  createFile(filePath: string): RemoteFile {
    return this._connection.createFile(filePath);
  }

  async saveAs(filePath: string): Promise<void> {
    if (!filePath) {
      throw new Error('Can\'t save buffer with no file path');
    }

    let success;
    this.emitter.emit('will-save', {path: filePath});
    this.setPath(filePath);
    try {
      const file = this.file;
      invariant(file, 'Cannot save an null file!');
      const toSaveContents = this.getText();
      await file.write(toSaveContents);
      this.cachedDiskContents = toSaveContents;
      this._saveID++;
      this.conflict = false;
      this.emitModifiedStatusChanged(false);
      this.emitter.emit('did-save', {path: filePath});
      success = true;
    } catch (e) {
      // Timeouts occur quite frequently when the network is unstable.
      // Demote these to 'error' level.
      const logFunction = (/timeout/i).test(e.message) ? logger.error : logger.fatal;
      logFunction('Failed to save remote file.', e);
      atom.notifications.addError(`Failed to save remote file: ${e.message}`);
      success = false;
    }

    track('remoteprojects-text-buffer-save-as', {
      'remoteprojects-file-path': filePath,
      'remoteprojects-save-success': success.toString(),
    });
  }

  updateCachedDiskContentsSync(): void {
    throw new Error('updateCachedDiskContentsSync isn\'t supported in NuclideTextBuffer');
  }

  async updateCachedDiskContents(flushCache?: boolean, callback?: () => mixed): Promise<void> {
    try {
      await super.updateCachedDiskContents(flushCache, callback);
      this._exists = true;
    } catch (e) {
      this._exists = false;
      throw e;
    }
  }

  // Override of TextBuffer's implementation.
  // Atom tries to diff contents even for extremely large files, which can
  // easily cause the editor to lock.
  // TODO(hansonw): Remove after https://github.com/atom/text-buffer/issues/153 is resolved.
  setTextViaDiff(newText: string): void {
    if (this.getText().length > DIFF_FILE_SIZE_LIMIT || newText.length > DIFF_FILE_SIZE_LIMIT) {
      this.setText(newText);
    } else {
      super.setTextViaDiff(newText);
    }
  }

  subscribeToFile(): void {
    if (this.fileSubscriptions) {
      this.fileSubscriptions.dispose();
    }
    const file = this.file;
    invariant(file, 'Cannot subscribe to no-file');
    this.fileSubscriptions = new CompositeDisposable();

    this.fileSubscriptions.add(file.onDidChange(async () => {
      const isModified = this._isModified();
      this.emitModifiedStatusChanged(isModified);
      if (isModified) {
        this.conflict = true;
      }
      const previousContents = this.cachedDiskContents;
      const previousSaveID = this._saveID;
      await this.updateCachedDiskContents();
      // If any save requests finished in the meantime, previousContents is not longer accurate.
      // The most recent save request should trigger another change event, so we'll check for
      // conflicts when that happens.
      // Otherwise, what we wrote and what we read should match exactly.
      if (this._saveID !== previousSaveID || previousContents === this.cachedDiskContents) {
        this.conflict = false;
        return;
      }
      if (this.conflict) {
        this.emitter.emit('did-conflict');
      } else {
        this.reload();
      }
    }));

    this.fileSubscriptions.add(file.onDidDelete(() => {
      this._exists = false;
      const modified = this.getText() !== this.cachedDiskContents;
      this.wasModifiedBeforeRemove = modified;
      if (modified) {
        this.updateCachedDiskContents();
      } else {
        this.destroy();
      }
    }));

    this.fileSubscriptions.add(file.onDidRename(() => {
      this.emitter.emit('did-change-path', this.getPath());
    }));

    this.fileSubscriptions.add(file.onWillThrowWatchError(errorObject => {
      this.emitter.emit('will-throw-watch-error', errorObject);
    }));
  }

  _isModified(): boolean {
    if (!this.loaded) {
      return false;
    }
    if (this.file) {
      if (this._exists) {
        return this.getText() !== this.cachedDiskContents;
      } else {
        return this.wasModifiedBeforeRemove ? !this.isEmpty() : false;
      }
    } else {
      return !this.isEmpty();
    }
  }
}

module.exports = NuclideTextBuffer;
