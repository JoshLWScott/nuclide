/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow strict-local
 * @format
 */

import type {ConsoleIO} from './ConsoleIO';
import type {ParsedVSAdapter} from './DebuggerAdapterFactory';
import type {
  DebuggerInterface,
  VariablesInScope,
  BreakpointSetResult,
} from './DebuggerInterface';
import * as DebugProtocol from 'vscode-debugprotocol';
import type {AdapterExitedEvent} from 'nuclide-debugger-common/VsDebugSession';
import type {
  SourceBreakpoint,
  FunctionBreakpoint,
} from './BreakpointCollection';
import type {Preset} from './ConfigFile';

import BackTraceCommand from './BackTraceCommand';
import Breakpoint from './Breakpoint';
import BreakpointCollection from './BreakpointCollection';
import BreakpointCommand from './BreakpointCommand';
import CommandDispatcher from './CommandDispatcher';
import ContinueCommand from './ContinueCommand';
import DownCommand from './DownCommand';
import EnterCodeCommand from './EnterCodeCommand';
import FrameCommand from './FrameCommand';
import SourceFileCache from './SourceFileCache';
import idx from 'idx';
import nuclideUri from 'nuclide-commons/nuclideUri';
import nullthrows from 'nullthrows';
import StepCommand from './StepCommand';
import NextCommand from './NextCommand';
import Thread from './Thread';
import ThreadsCommand from './ThreadsCommand';
import VariablesCommand from './VariablesCommand';
import ListCommand from './ListCommand';
import PrintCommand from './PrintCommand';
import RunCommand from './RunCommand';
import ThreadCollection from './ThreadCollection';
import UpCommand from './UpCommand';

import invariant from 'assert';
import VsDebugSession from 'nuclide-debugger-common/VsDebugSession';

type Capabilities = {
  ...DebugProtocol.Capabilities,
  supportsReadyForEvaluationsEvent?: ?boolean,
};

type SessionState =
  | 'INITIALIZING' // waiting for initialized event from adapter
  | 'CONFIGURING' // waiting for user to issue 'run' command after setting initial breakpoints
  | 'RUNNING' // program is running
  | 'STOPPED' // program has hit a breakpoint
  | 'TERMINATED'; // program is gone and not coming back

export default class Debugger implements DebuggerInterface {
  _capabilities: Capabilities = {};
  _console: ConsoleIO;
  _debugSession: ?VsDebugSession;
  _logger: log4js$Logger;
  _activeThread: ?number;
  _threads: ThreadCollection = new ThreadCollection();
  _sourceFiles: SourceFileCache;
  _state: SessionState = 'INITIALIZING';
  _breakpoints: BreakpointCollection = new BreakpointCollection();
  _adapter: ?ParsedVSAdapter;
  _attachMode: boolean = false;
  _preset: ?Preset;
  _readyForEvaluations: boolean = false;
  _muteOutputCategories: Set<string>;
  _attached: boolean = false;
  _configured: boolean = false;
  _stoppedAtBreakpointId: ?number = null;

  constructor(
    logger: log4js$Logger,
    con: ConsoleIO,
    preset: ?Preset,
    muteOutputCategories: Set<string>,
  ) {
    this._logger = logger;
    this._console = con;
    this._sourceFiles = new SourceFileCache(
      this._getSourceByReference.bind(this),
    );
    this._preset = preset;
    this._muteOutputCategories = muteOutputCategories;
  }

  registerCommands(dispatcher: CommandDispatcher): void {
    dispatcher.registerCommand(new BackTraceCommand(this._console, this));
    dispatcher.registerCommand(new ThreadsCommand(this._console, this));
    dispatcher.registerCommand(new StepCommand(this));
    dispatcher.registerCommand(new NextCommand(this));
    dispatcher.registerCommand(new VariablesCommand(this._console, this));
    dispatcher.registerCommand(new BreakpointCommand(this._console, this));
    dispatcher.registerCommand(new ContinueCommand(this));
    dispatcher.registerCommand(new ListCommand(this._console, this));
    dispatcher.registerCommand(new PrintCommand(this._console, this));
    dispatcher.registerCommand(new RunCommand(this));
    dispatcher.registerCommand(new EnterCodeCommand(this._console, this));
    dispatcher.registerCommand(new FrameCommand(this._console, this));
    dispatcher.registerCommand(new UpCommand(this._console, this));
    dispatcher.registerCommand(new DownCommand(this._console, this));
  }

  // launch is for launching a process from scratch when we need a new
  // session
  launch(adapter: ParsedVSAdapter): Promise<void> {
    this._adapter = adapter;
    this._breakpoints = new BreakpointCollection();
    return this.relaunch();
  }

  // relaunch is for when we want to restart the current process
  // without tearing down the session. some adapters can do this
  // automatically
  async relaunch(): Promise<void> {
    const adapter = this._adapter;
    if (adapter == null) {
      throw new Error('There is nothing to relaunch.');
    }

    try {
      this._state = 'INITIALIZING';

      this._configured = false;
      this._attached = false;

      await this.closeSession();
      await this.createSession(adapter);

      invariant(adapter.action === 'attach' || adapter.action === 'launch');
      this._attachMode = adapter.action === 'attach';

      const session = this._ensureDebugSession(true);

      if (this._attachMode) {
        const attachArgs = nullthrows(
          this._adapter,
        ).adapter.transformAttachArguments(adapter.attachArgs);
        await session.attach(attachArgs);
        this._attached = true;
        return this._pauseAfterAttach();
      }

      await session.launch(
        nullthrows(this._adapter).adapter.transformLaunchArguments(
          adapter.launchArgs,
        ),
      );
    } catch (err) {
      process.stderr.write(`Failed to debug target: ${err.message}\r\n`);
      process.exit(0);
    }
  }

  async _onInitialized(): Promise<void> {
    const adapter = this._adapter;
    invariant(adapter != null);

    // In attach mode, we don't have a separate configuation mode --
    // we just let the attach finish and then force a stop
    // Some adapters claim to support stopping on attach, but the ones
    // supported so far don't do it reliably.
    if (this._attachMode) {
      return this._configurationDone();
    }

    this._state = 'CONFIGURING';
    this._startConfigurationInput();
  }

  async _configurationDone(): Promise<void> {
    const session = this._ensureDebugSession(true);
    this._state = 'RUNNING';

    await this._resetAllBreakpoints();

    // this needs to be sent last for adapters that don't support configurationDone
    await session.setExceptionBreakpoints({filters: []});

    if (this._capabilities.supportsConfigurationDoneRequest) {
      try {
        await session.configurationDone();
      } catch (err) {
        process.stderr.write(`Failed to debug target: ${err.message}\r\n`);
        process.exit(0);
      }
    }

    await this._cacheThreads();
    if (this._attachMode) {
      this._configured = true;
      return this._pauseAfterAttach();
    }

    this._console.stopInput();
  }

  async _pauseAfterAttach(): Promise<void> {
    if (this._configured && this._attached) {
      const session = this._ensureDebugSession(true);
      let threadId: ?number = nullthrows(this._adapter).adapter.asyncStopThread;
      if (threadId == null) {
        const threads = this._threads.allThreads;
        if (threads.length !== 0) {
          threadId = threads[0].id();
        }
      }

      if (threadId == null) {
        // nowhere to stop right now.
        this._console.stopInput();
        return;
      }

      await session.pause({threadId});
    }
  }

  async run(): Promise<void> {
    if (this._attachMode) {
      throw new Error('Cannot run an attached process; already attached.');
    }

    this._stoppedAtBreakpointId = null;

    if (this._state === 'STOPPED') {
      this.relaunch();
      return;
    }

    if (this._state !== 'CONFIGURING') {
      throw new Error('There is nothing to run.');
    }

    return this._configurationDone();
  }

  breakInto(): void {
    const adapter = nullthrows(this._adapter).adapter;
    // if there is a focus thread from before, stop that one, else pick
    // a thread or use the adapter-specified default
    let threadId: ?number = null;
    if (this._threads.focusThread != null) {
      threadId = this._threads.focusThread.id();
    } else if (adapter.asyncStopThread != null) {
      threadId = adapter.asyncStopThread;
    } else if (this._threads.allThreads.length !== 0) {
      threadId = this._threads.allThreads[0].id();
    }

    if (threadId == null) {
      return;
    }

    this._ensureDebugSession().pause({threadId});
  }

  getThreads(): ThreadCollection {
    this._ensureDebugSession();
    return this._threads;
  }

  getActiveThread(): Thread {
    this._ensureDebugSession();
    return nullthrows(this._threads.focusThread);
  }

  async getStackTrace(
    thread: number,
    levels: number,
  ): Promise<DebugProtocol.StackFrame[]> {
    const {
      body: {stackFrames},
    } = await this._ensureDebugSession().stackTrace({
      threadId: thread,
      levels,
    });
    return stackFrames;
  }

  async setSelectedStackFrame(
    thread: Thread,
    frameIndex: number,
  ): Promise<void> {
    const frames = await this.getStackTrace(thread.id(), frameIndex + 1);
    if (frames[frameIndex] == null) {
      throw new Error(
        `There are only ${frames.length} frames in the thread's stack trace.`,
      );
    }
    thread.setSelectedStackFrame(frameIndex);
  }

  async getCurrentStackFrame(): Promise<?DebugProtocol.StackFrame> {
    this._ensureDebugSession();
    const thread = this.getActiveThread();
    const selectedFrame = thread.selectedStackFrame();
    const frames = await this.getStackTrace(thread.id(), selectedFrame + 1);

    return frames[selectedFrame];
  }

  async stepIn(): Promise<void> {
    await this._ensureDebugSession().stepIn({
      threadId: this.getActiveThread().id(),
    });
  }

  async stepOver(): Promise<void> {
    await this._ensureDebugSession().next({
      threadId: this.getActiveThread().id(),
    });
  }

  async continue(): Promise<void> {
    try {
      // we stop console input once execution has restarted, but some adapters
      // send output before that happens. since the continued notification is
      // async, the debugger will treat that output as if it happened while
      // the command prompt is up, and reprint the prompt after it. really,
      // any output that happens while we're trying to continue should see that
      // input is stopped.
      this._console.stopInput();
      const session = this._ensureDebugSession(true);
      this._stoppedAtBreakpointId = null;

      // if we are attaching and still in configuration, this is where we'll
      // send configuration done.
      if (this._state === 'CONFIGURING') {
        if (this._attachMode) {
          return this._configurationDone();
        }
        throw new Error('There is not yet a running process to continue.');
      }

      if (this._state === 'STOPPED') {
        await session.continue({
          threadId: this.getActiveThread().id(),
        });

        return;
      }

      if (this._state === 'TERMINATED') {
        throw new Error('Cannot continue; process is terminated.');
      }

      throw new Error(`Continue called from unexpected state ${this._state}`);
    } catch (error) {
      this._console.startInput();
      throw error;
    }
  }

  async getVariablesByScope(
    selectedScope: ?string,
  ): Promise<VariablesInScope[]> {
    const session = this._ensureDebugSession();

    const activeThread = this.getActiveThread();
    const stack = await this.getStackTrace(
      activeThread.id(),
      activeThread.selectedStackFrame() + 1,
    );
    const frameId = this._stackFrameId(
      stack,
      activeThread.selectedStackFrame(),
    );
    if (frameId == null) {
      return [];
    }

    const {
      body: {scopes},
    } = await session.scopes({frameId});

    let queries: DebugProtocol.Scope[];

    if (selectedScope != null) {
      queries = scopes.filter(scope => scope.name === selectedScope);
      if (queries.length === 0) {
        throw new Error(
          `There is no scope named '${selectedScope}' in the current context.`,
        );
      }
    } else {
      queries = scopes.filter(scope => !scope.expensive);
    }

    const executers = queries.map(async scope => {
      const {
        body: {variables},
      } = await session.variables({
        variablesReference: scope.variablesReference,
      });
      return [scope.variablesReference, variables];
    });

    const results = await Promise.all(executers);
    const resultsByVarRef = new Map(results);

    return scopes.map(scope => {
      return {
        expensive: scope.expensive,
        scopeName: scope.name,
        variables: resultsByVarRef.get(scope.variablesReference),
      };
    });
  }

  async getVariablesByReference(
    ref: number,
  ): Promise<DebugProtocol.Variable[]> {
    const session = this._ensureDebugSession();
    const {
      body: {variables},
    } = await session.variables({variablesReference: ref});
    return variables;
  }

  getStoppedAtBreakpointId(): ?number {
    return this._stoppedAtBreakpointId;
  }

  async setSourceBreakpoint(
    path: string,
    line: number,
  ): Promise<BreakpointSetResult> {
    // NB this call is allowed before the program is launched
    const session = this._ensureDebugSession(true);
    const index = this._breakpoints.addSourceBreakpoint(path, line);

    let message = 'Breakpoint pending until program starts.';

    if (this._state !== 'CONFIGURING') {
      const breakpoint = await this._setSourceBreakpointsForPath(
        session,
        path,
        index,
      );
      message = breakpoint == null ? null : breakpoint.message;
    }

    return {index, message};
  }

  async _setSourceBreakpointsForPath(
    session: VsDebugSession,
    path: string,
    indexOfInterest: ?number,
  ): Promise<?DebugProtocol.Breakpoint> {
    const localBreakpoints = this._breakpoints.getAllEnabledBreakpointsForSource(
      path,
    );

    const request = {
      source: {path},
      breakpoints: localBreakpoints.map(x => ({line: x.line})),
    };

    const {
      body: {breakpoints: adapterBreakpoints},
    } = await session.setBreakpoints(request);

    const paired = localBreakpoints.map((_, i) => [_, adapterBreakpoints[i]]);

    for (const [debuggerBreakpoint, adapterBreakpoint] of paired) {
      this._updateBreakpoint(debuggerBreakpoint, adapterBreakpoint);
    }

    const breakpoint = paired.find(_ => _[0].index === indexOfInterest);
    return breakpoint == null ? null : breakpoint[1];
  }

  async setFunctionBreakpoint(func: string): Promise<BreakpointSetResult> {
    if (!this._capabilities.supportsFunctionBreakpoints) {
      throw new Error(
        `The ${
          nullthrows(this._adapter).type
        } debugger does not support function breakpoints.`,
      );
    }

    // NB this call is allowed before the program is launched
    const session = this._ensureDebugSession(true);
    const index = this._breakpoints.addFunctionBreakpoint(func);

    let message = 'Breakpoint pending until program starts.';

    if (this._state !== 'CONFIGURING') {
      const breakpoint = await this._setFunctionBreakpoints(session, index);
      message = breakpoint == null ? null : breakpoint.message;
    }

    return {index, message};
  }

  async _setFunctionBreakpoints(
    session: VsDebugSession,
    indexOfInterest: number,
  ): Promise<?DebugProtocol.Breakpoint> {
    const funcBreakpoints = this._breakpoints.getAllEnabledFunctionBreakpoints();

    const request = {
      breakpoints: funcBreakpoints.map(bpt => ({
        name: bpt.func,
      })),
    };

    const response = await session.setFunctionBreakpoints(request);

    const {
      body: {breakpoints: adapterBreakpoints},
    } = response;

    const paired = funcBreakpoints.map((_, i) => [_, adapterBreakpoints[i]]);

    for (const [debuggerBreakpoint, adapterBreakpoint] of paired) {
      this._updateBreakpoint(debuggerBreakpoint, adapterBreakpoint);
    }

    const breakpoint = paired.find(_ => _[0].index === indexOfInterest);
    return breakpoint == null ? null : breakpoint[1];
  }

  _stackFrameId(stack: DebugProtocol.StackFrame[], depth: number): ?number {
    return idx(stack, _ => _[depth].id);
  }

  async getSourceLines(
    source: DebugProtocol.Source,
    start: number,
    length: number,
  ): Promise<string[]> {
    // If `source' contains a non-zero sourceReference, then the adapter
    // supports returning source data; otherwise, we use the given
    // path as a local file system path.
    //
    let lines: string[] = [];
    const sourceReference = source.sourceReference;

    if (sourceReference != null && sourceReference !== 0) {
      lines = await this._sourceFiles.getFileDataBySourceReference(
        sourceReference,
      );
    } else if (source.path != null) {
      lines = await this._sourceFiles.getFileDataByPath(source.path);
    }

    if (start > lines.length) {
      return [];
    }

    const end = Math.min(start + length - 1, lines.length);
    return lines.slice(start - 1, end);
  }

  getAllBreakpoints(): Breakpoint[] {
    return this._breakpoints.getAllBreakpoints();
  }

  getBreakpointByIndex(index: number): Breakpoint {
    return this._breakpoints.getBreakpointByIndex(index);
  }

  async setAllBreakpointsEnabled(enabled: boolean): Promise<void> {
    this._breakpoints.getAllBreakpoints().forEach(bp => bp.setEnabled(enabled));
    return this._resetAllBreakpoints();
  }

  async setBreakpointEnabled(index: number, enabled: boolean): Promise<void> {
    const session = this._ensureDebugSession();
    const breakpoint = this._breakpoints.getBreakpointByIndex(index);
    const path = breakpoint.path;

    if (breakpoint.enabled === enabled) {
      return;
    }

    breakpoint.setEnabled(enabled);

    if (path != null) {
      try {
        await this._setSourceBreakpointsForPath(session, path, index);
      } catch (error) {
        breakpoint.setEnabled(!enabled);
        throw error;
      }
      return;
    }

    await this._resetAllFunctionBreakpoints();
  }

  async toggleAllBreakpoints(): Promise<void> {
    this._breakpoints
      .getAllBreakpoints()
      .forEach(bp => bp.setEnabled(!bp.enabled));
    return this._resetAllBreakpoints();
  }

  async toggleBreakpoint(index: number): Promise<void> {
    const session = this._ensureDebugSession();
    const breakpoint = this._breakpoints.getBreakpointByIndex(index);
    const path = breakpoint.path;

    breakpoint.setEnabled(!breakpoint.enabled);

    if (path != null) {
      try {
        await this._setSourceBreakpointsForPath(session, path, index);
      } catch (error) {
        breakpoint.setEnabled(!breakpoint.enabled);
        throw error;
      }
      return;
    }

    await this._resetAllFunctionBreakpoints();
  }

  async deleteAllBreakpoints(): Promise<void> {
    const session = this._ensureDebugSession();
    const promises = this._breakpoints
      .getAllBreakpointPaths()
      .map(path => session.setBreakpoints({source: {path}, breakpoints: []}));

    await Promise.all(promises);
    await session.setFunctionBreakpoints({
      breakpoints: [],
    });

    this._breakpoints.deleteAllBreakpoints();
  }

  async deleteBreakpoint(index: number): Promise<void> {
    const session = this._ensureDebugSession();
    const breakpoint = this._breakpoints.getBreakpointByIndex(index);
    const path = breakpoint.path;

    this._breakpoints.deleteBreakpoint(index);

    if (path != null) {
      const pathBreakpoints = this._breakpoints.getAllEnabledBreakpointsForSource(
        path,
      );

      await session.setBreakpoints({
        source: {path},
        breakpoints: pathBreakpoints.map(x => {
          return {line: x.line};
        }),
      });
    }
  }

  async evaluateExpression(
    expression: string,
  ): Promise<DebugProtocol.EvaluateResponse> {
    const session = this._ensureDebugSession(true);

    let args = {expression, context: 'repl'};

    if (this._state === 'RUNNING') {
      const frame = await this.getCurrentStackFrame();
      if (frame != null) {
        args = {...args, frameId: frame.id};
      }
    }

    return session.evaluate(args);
  }

  async createSession(adapter: ParsedVSAdapter): Promise<void> {
    this._console.stopInput();

    this._threads = new ThreadCollection();

    this._debugSession = new VsDebugSession(
      process.pid.toString(),
      this._logger,
      adapter.adapterInfo,
      {host: 'cli', adapter: adapter.type, isRemote: false},
    );

    this._initializeObservers();

    invariant(this._debugSession != null);
    const {body} = await this._debugSession.initialize({
      adapterID: 'fbdbg',
      pathFormat: 'path',
      linesStartAt1: true,
      columnsStartAt1: true,
      clientID: 'nuclide-cli',
    });

    this._capabilities = {};
    if (body != null) {
      // $FlowFixMe should be able to just assign here
      this._capabilities = ((body: any): Capabilities);
    }
    this._readyForEvaluations = true;

    // $FlowFixMe
    const extraBody: any = body;
    if (extraBody.supportsReadyForEvaluationsEvent === true) {
      this._readyForEvaluations = false;
    }
  }

  async _resetAllBreakpoints(): Promise<void> {
    const session = this._ensureDebugSession();

    const sourceBreakpoints = this._breakpoints.getAllEnabledBreakpointsByPath();

    const sourceBreakpointSets = Array.from(sourceBreakpoints).map(
      async ([path, breakpointLines]) => {
        const lines: DebugProtocol.SourceBreakpoint[] = breakpointLines.map(
          _ => ({line: _.line}),
        );

        const source: DebugProtocol.Source = {
          path,
        };

        const {
          body: {breakpoints: breakpointsOut},
        } = await session.setBreakpoints({
          source,
          breakpoints: lines,
        });

        breakpointLines.forEach((local, i) => {
          this._updateBreakpoint(local, breakpointsOut[i]);
        });
      },
    );

    await Promise.all(
      sourceBreakpointSets.concat(this._resetAllFunctionBreakpoints()),
    );
  }

  async _resetAllFunctionBreakpoints(): Promise<void> {
    const session = this._ensureDebugSession();
    const funcBreakpoints = this._breakpoints.getAllEnabledFunctionBreakpoints();

    if (
      !this._capabilities.supportsFunctionBreakpoints ||
      funcBreakpoints.length === 0
    ) {
      return;
    }

    const {
      body: {breakpoints: funcBreakpointsOut},
    } = await session.setFunctionBreakpoints({
      breakpoints: funcBreakpoints.map(bpt => ({
        name: bpt.func,
      })),
    });

    funcBreakpoints.forEach((local, i) => {
      this._updateBreakpoint(local, funcBreakpointsOut[i]);
    });
  }

  _updateBreakpoint(
    local: SourceBreakpoint | FunctionBreakpoint,
    remote: DebugProtocol.Breakpoint,
  ) {
    const index = local.index;

    const id = remote.id;
    if (id != null) {
      this._breakpoints.setBreakpointId(index, id);

      const verified = remote.verified;
      if (verified != null) {
        this._breakpoints.setBreakpointVerified(index, verified);
      }
    } else {
      // if we didn't get an id back from the adapter, we can't match
      // breakpoint events, so we'll never get to mark anything verified.
      // just assume it's verified.
      this._breakpoints.setBreakpointVerified(index, true);
    }

    // If it's a function breakpoint and we got back a source location,
    // save it
    if (local.func != null && remote.source) {
      const path = remote.source.path;
      const line = remote.line;

      if (path != null && line != null) {
        this._breakpoints.setPathAndFile(index, path, line);
      }
    }

    // If we failed to set the breakpoint, and we didn't get a message why,
    // concot one.
    if (!remote.verified && (remote.message == null || remote.message === '')) {
      remote.message =
        'Could not set this breakpoint. The module may not have been loaded yet.';
    }
  }

  _initializeObservers(): void {
    const session = this._ensureDebugSession(true);

    session.observeInitializeEvents().subscribe(() => {
      try {
        this._onInitialized();
      } catch (error) {
        this._console.outputLine('Failed to initialize debugging session.');
        this._console.outputLine(error.message);
        this.closeSession();
      }
    });

    session
      .observeOutputEvents()
      .filter(
        x =>
          x.body.category != null &&
          !this._muteOutputCategories.has(x.body.category),
      )
      .subscribe(this._onOutput.bind(this));

    session.observeContinuedEvents().subscribe(this._onContinued.bind(this));

    session.observeStopEvents().subscribe(this._onStopped.bind(this));

    session.observeThreadEvents().subscribe(this._onThread.bind(this));

    session
      .observeExitedDebugeeEvents()
      .subscribe(this._onExitedDebugee.bind(this));

    session
      .observeTerminateDebugeeEvents()
      .subscribe(this._onTerminatedDebugee.bind(this));

    session
      .observeAdapterExitedEvents()
      .subscribe(this._onAdapterExited.bind(this));

    session
      .observeBreakpointEvents()
      .subscribe(this._onBreakpointEvent.bind(this));

    session.observeCustomEvents().subscribe(e => {
      if (e.event === 'readyForEvaluations') {
        this._onReadyForEvaluations();
      }
    });
  }

  async closeSession(): Promise<void> {
    if (this._debugSession == null) {
      return;
    }

    await this._debugSession.disconnect();
    this._threads = new ThreadCollection();
    this._debugSession = null;
    this._activeThread = null;

    // $TODO perf - there may be some value in not immediately flushing
    // and keeping the cache around if we reattach to the same target,
    // using watch to see if the file has changed in the meantime
    this._sourceFiles.flush();
  }

  _onOutput(event: DebugProtocol.OutputEvent): void {
    const text = idx(event, _ => _.body.output) || '';
    this._console.output(text);
  }

  _onContinued(event: DebugProtocol.ContinuedEvent) {
    const {
      body: {threadId, allThreadsContinued},
    } = event;

    if (allThreadsContinued === true) {
      this._threads.markAllThreadsRunning();
    } else if (threadId != null) {
      this._threads.markThreadRunning(threadId);
    }

    // only turn the console off if all threads have started up again
    if (this._threads.allThreadsRunning()) {
      this._console.stopInput();
    }
  }

  async _onStopped(event: DebugProtocol.StoppedEvent) {
    const {
      body: {description, threadId, allThreadsStopped, breakpointId},
    } = event;

    this._stoppedAtBreakpointId = breakpointId;

    const firstStop = this._threads.allThreadsRunning();
    if (firstStop && description != null) {
      this._console.outputLine(`Stopped: ${description}`);
    }

    if (allThreadsStopped === true) {
      this._threads.markAllThreadsStopped();
      this._threads.allThreads.map(_ => _.clearSelectedStackFrame());
    } else if (threadId != null) {
      this._threads.markThreadStopped(threadId);
      nullthrows(
        this._threads.getThreadById(threadId),
      ).clearSelectedStackFrame();
    } else {
      // the call didn't actually contain information about anything stopping.
      this._console.outputLine('stop event with no thread information.');
    }

    // for now, set the focus thread to the first thread that stopped
    if (firstStop) {
      if (threadId != null) {
        this._threads.setFocusThread(threadId);
      } else {
        const firstStopped = this._threads.firstStoppedThread();
        invariant(firstStopped != null);
        this._threads.setFocusThread(firstStopped);
      }

      try {
        const topOfStack = await this._getTopOfStackSourceInfo(
          nullthrows(this._threads.focusThreadId),
        );

        if (topOfStack != null) {
          this._console.outputLine(
            `${topOfStack.name}:${topOfStack.frame.line} ${topOfStack.line}`,
          );
        }
      } catch (err) {
        this._console.outputLine(
          `failed to get source at stop point: ${err.message}`,
        );
      }

      this._state = 'STOPPED';
      this._console.startInput();
    }
  }

  _onThread(event: DebugProtocol.ThreadEvent) {
    const {
      body: {reason, threadId},
    } = event;

    if (reason === 'started') {
      // to avoid a race, create a thread immediately. then call _cacheThreads,
      // which will query gdb and update the description
      this._threads.addThread(new Thread(threadId, `thread ${threadId}`));
      this._cacheThreads();
      return;
    }

    if (reason === 'exited') {
      this._threads.removeThread(threadId);
    }
  }

  _onReadyForEvaluations(): void {
    this._readyForEvaluations = true;
    this._startConfigurationInput();
  }

  _startConfigurationInput(): void {
    if (this._readyForEvaluations && this._state === 'CONFIGURING') {
      this._console.startInput();
    }
  }

  _onExitedDebugee(event: DebugProtocol.ExitedEvent) {
    this._state = 'TERMINATED';

    this._console.outputLine(
      `Target exited with status ${event.body.exitCode}`,
    );

    const adapter = this._adapter;
    invariant(adapter != null);

    if (!this._attachMode) {
      this._console.startInput();
      this.relaunch();
      return;
    }

    process.exit(0);
  }

  _onTerminatedDebugee(event: DebugProtocol.TerminatedEvent) {
    // Some adapters will send multiple terminated events.
    if (this._state !== 'RUNNING') {
      return;
    }

    this._state = 'TERMINATED';

    this._console.outputLine('The target has exited.');

    const adapter = this._adapter;
    invariant(adapter != null);

    if (!this._attachMode) {
      this._console.startInput();
      this.relaunch();
      return;
    }

    process.exit(0);
  }

  _onAdapterExited(event: AdapterExitedEvent) {
    // If we're initializing, this is expected - relaunch() is tearing down
    // the adapter to build a new one.
    if (this._state === 'INITIALIZING') {
      return;
    }

    this._state = 'TERMINATED';

    const adapter = this._adapter;
    invariant(adapter != null);

    if (!this._attachMode) {
      this._console.startInput();
      this.relaunch();
      return;
    }

    process.exit(0);
  }

  async _cacheThreads(): Promise<void> {
    invariant(
      this._debugSession != null,
      '_cacheThreads called without session',
    );

    const {body} = await this._debugSession.threads();
    const threads = (body.threads != null ? body.threads : []).map(
      _ => new Thread(_.id, _.name),
    );

    this._threads.updateThreads(threads);
  }

  _onBreakpointEvent(event: DebugProtocol.BreakpointEvent): void {
    const {
      body: {
        reason,
        breakpoint: {id, verified},
      },
    } = event;

    if (id != null && (reason === 'new' || reason === 'changed')) {
      try {
        const breakpoint = this._breakpoints.getBreakpointById(id);
        breakpoint.setVerified(verified);
      } catch (error) {
        this._console.outputLine('Failed to verify breakpoint.');
      }
    }
  }

  async _getTopOfStackSourceInfo(
    threadId: number,
  ): Promise<?{
    line: string,
    name: string,
    frame: DebugProtocol.StackFrame,
  }> {
    // $TODO paths relative to project root?
    const frames = await this.getStackTrace(threadId, 1);
    const source = Debugger._sourceFromTopFrame(frames);
    if (source == null) {
      return null;
    }

    const frame = frames[0];
    const lines = await this.getSourceLines(source, frames[0].line, 1);

    let name: string;

    if (source.path != null) {
      const path = nuclideUri.resolve(source.path);
      name = nuclideUri.split(path).pop();
    } else if (source.name != null) {
      name = source.name;
    } else {
      // the spec guarantees that name is always defined on return, so
      // we should never get here.
      return null;
    }

    return {
      line: lines.length > 0 ? lines[0] : '',
      name,
      frame,
    };
  }

  static _sourceFromTopFrame(
    frames: DebugProtocol.StackFrame[],
  ): ?DebugProtocol.Source {
    return idx(frames, _ => _[0].source) || null;
  }

  async _getSourceByReference(sourceReference: number): Promise<string> {
    try {
      const {
        body: {content},
      } = await this._ensureDebugSession().source({
        sourceReference,
      });
      return content;
    } catch (err) {
      return `Failed to retrieve source: ${err.message}`;
    }
  }

  _ensureDebugSession(allowBeforeLaunch: boolean = false): VsDebugSession {
    if (this._debugSession == null) {
      throw new Error('There is no active debugging session.');
    }

    if (
      (this._state === 'INITIALIZING' || this._state === 'CONFIGURING') &&
      !allowBeforeLaunch
    ) {
      const err = new Error(
        "The program is not yet running (use 'run' to start it).",
      );
      throw err;
    }

    return this._debugSession;
  }
}
