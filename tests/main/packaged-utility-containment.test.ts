import { describe, expect, it } from 'vitest';
import {
  assertPackagedUtilityContainmentAdversarialControls,
  assertPackagedUtilityContainmentSources,
  findPackagedUtilityWorkerBundle,
} from '../../scripts/packaged-utility-containment.mjs';

const mainSource = String.raw`
"use strict";
const inventory = [
  "AIDRAW_E2E_UTILITY_CONTAINMENT",
  "AIDRAW_E2E_FND09_UTILITY_PROFILE",
  "fnd09-utility-containment-probe.json",
  "fnd09-forbidden-network.json",
  "FND-09 packaged raster utility crash/cancel/restart containment",
  "Utility task was cancelled."
];
function abortError() {
  const error = new Error("Utility task was cancelled.");
  error.name = "AbortError";
  return error;
}
class RasterUtilitySupervisor {
  cancel(id) {
    const queuedIndex = this.queue.findIndex((task) => task.request.id === id);
    if (queuedIndex >= 0) { this.finish(this.queue.splice(queuedIndex, 1)[0], abortError()); return; }
    if (this.current?.request.id !== id) return;
    const task = this.current;
    const worker = this.worker;
    this.current = undefined;
    this.finish(task, abortError());
    this.worker = undefined;
    worker?.kill();
    this.pump();
  }
  enqueue(request, control) {
    return new Promise((resolve, reject) => {
      const task = { request, signal: control.signal, resolve, reject };
      task.onAbort = () => this.cancel(request.id);
      control.signal?.addEventListener("abort", task.onAbort, { once: true });
      this.queue.push(task);
      this.pump();
    });
  }
  async ensureWorker() {
    if (this.worker) return this.worker;
    if (!this.starting) this.starting = Promise.resolve(this.fork()).then((worker) => {
      this.starting = undefined;
      if (this.stopped) { worker.kill(); throw new Error("stopped"); }
      this.worker = worker;
      worker.on("message", (message) => this.handleMessage(worker, message));
      worker.on("exit", (code) => this.handleExit(worker, code));
      return worker;
    });
    return this.starting;
  }
  async pump() {
    const worker = await this.ensureWorker();
    const task = this.queue.shift();
    this.current = task;
    task.timer = setTimeout(() => {
      if (this.current !== task) return;
      this.current = undefined;
      this.finish(task, new Error("timeout"));
      worker.kill();
      this.pump();
    }, task.timeoutMs);
    worker.postMessage(task.request);
  }
  handleMessage(worker, message) { this.finish(this.current, undefined, message); }
  handleExit(worker, code) {
    if (worker !== this.worker) return;
    this.worker = undefined;
    if (this.current) {
      const task = this.current;
      this.current = undefined;
      this.finish(task, new Error("Raster utility exited unexpectedly with code " + code + "."));
    }
    this.pump();
  }
  finish(task, error, response) {
    if (task.timer) clearTimeout(task.timer);
    task.signal?.removeEventListener("abort", task.onAbort);
    if (error) task.reject(error);
    else if (response) task.resolve(response);
    else task.reject(new Error("Raster utility completed without a result."));
  }
  runE2eContainmentProbe(mode, control = {}) {
    if (process.env.NODE_ENV !== "test") throw new Error("The utility containment probe is unavailable outside isolated packaged QA.");
    const request = { id: "probe", kind: "containment-probe", mode };
    return this.enqueue(request, control);
  }
  stop() { this.stopped = true; }
}
const engineRuntime = { rasterUtilities: new RasterUtilitySupervisor() };
async function runScenario(engine, configuration) {
  let retained;
  try {
    const crashTask = engine.rasterUtilities.runE2eContainmentProbe("crash");
    const crashing = engine.rasterUtilities.status();
    const queuedAfterCrash = engine.rasterUtilities.exportDocument(document, "png", { scale: 1 });
    await rejected(crashTask);
    await queuedAfterCrash;
    const afterCrash = engine.rasterUtilities.status();
    if (afterCrash.pid === crashing.pid) throw new Error("not replaced");
    const controller = new AbortController();
    const hangingTask = engine.rasterUtilities.runE2eContainmentProbe("hang", { signal: controller.signal });
    const cancelling = engine.rasterUtilities.status();
    const queuedAfterCancel = engine.rasterUtilities.exportDocument(document, "png", { scale: 1 });
    controller.abort();
    const cancellationError = await rejected(hangingTask);
    if (cancellationError.name !== "AbortError") throw new Error("not cancelled");
    await queuedAfterCancel;
    const afterCancel = engine.rasterUtilities.status();
    const result = { workerPidsDistinct: new Set([crashing.pid, afterCrash.pid, afterCancel.pid]).size === 3 };
    if (!result.workerPidsDistinct) throw new Error("not distinct");
    retained = result;
  } catch (error) { retained = { failed: true, error }; }
  return retained;
}
if (fnd09UtilityContainmentE2e) {
  void runScenario(engineRuntime, fnd09UtilityContainmentE2e)
    .catch((error) => process.stderr.write("FND-09 utility containment probe failed: " + error.message));
}
`;

const workerSource = String.raw`
"use strict";
const inventory = ["containment-probe", "hang", "The utility containment probe is unavailable outside isolated packaged QA.", "process.crash"];
function validateRequest(value) {
  if (value.kind === "containment-probe") {
    if (value.mode !== "crash" && value.mode !== "hang") throw new Error("bad mode");
    if (process.env.NODE_ENV !== "test" || process.env.AIDRAW_E2E_UTILITY_CONTAINMENT !== "1") {
      throw new Error("The utility containment probe is unavailable outside isolated packaged QA.");
    }
  }
  return value;
}
process.parentPort.on("message", (event) => {
  void (async () => {
    const request = validateRequest(event.data);
    if (request.kind === "containment-probe") {
      if (request.mode === "crash") setTimeout(() => process.crash(), 100);
      if (request.mode === "crash" || request.mode === "hang") await new Promise(() => undefined);
      await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
      process.parentPort.postMessage({ id: request.id, ok: true, kind: request.kind });
    }
  })();
});
`;

const allMarkers = [
  'AIDRAW_E2E_UTILITY_CONTAINMENT',
  'AIDRAW_E2E_FND09_UTILITY_PROFILE',
  'fnd09-utility-containment-probe.json',
  'fnd09-forbidden-network.json',
  'FND-09 packaged raster utility crash/cancel/restart containment',
  'Utility task was cancelled.',
  'containment-probe',
  'hang',
  'The utility containment probe is unavailable outside isolated packaged QA.',
  'process.crash',
];

function expectAllMarkers(candidateMain: string, candidateWorker: string): void {
  for (const marker of allMarkers) expect(candidateMain.includes(marker) || candidateWorker.includes(marker), marker).toBe(true);
}

const discardCallback = (source: string): string => `function discard(callback) { void callback; }\ndiscard(() => {\n${source}\n});`;
const invokeCallback = (source: string): string => `function invoke(callback) { callback(); }\ninvoke(() => {\n${source}\n});`;
const parkInClass = (source: string, tail = ''): string => `class ParkedSubject { install() {\n${source}\n} }\n${tail}`;
const guardWithLexicalShadow = (source: string): string => `let runtimeGate = true;\nfunction unrelated() { const runtimeGate = false; }\nif (runtimeGate) {\n${source}\n}`;

describe('packaged FND-09 utility containment exact emitted subject admission', () => {
  it('selects the implementation chunk instead of the Vite worker entry wrapper', () => {
    expect(findPackagedUtilityWorkerBundle([
      '/.vite/build/utility-worker.js',
      '/.vite/build/utility-worker-DaGYAr6L.js',
      '/.vite/build/main.js',
    ])).toBe('/.vite/build/utility-worker-DaGYAr6L.js');
    expect(() => findPackagedUtilityWorkerBundle(['/.vite/build/utility-worker.js'])).toThrow('bundle count is 0');
    expect(() => findPackagedUtilityWorkerBundle([
      '/.vite/build/utility-worker-one.js',
      '/.vite/build/utility-worker-two.js',
    ])).toThrow('bundle count is 2');
  });

  it('admits the maintained fixture only by its complete reviewed byte-pair identity', () => {
    expect(assertPackagedUtilityContainmentSources({
      mainSource,
      workerSource,
      expectedSubject: 'maintained-unit-fixture',
    })).toEqual({
      assurance: 'exact-emitted-subject-identity-admission',
      admittedSubject: 'maintained-unit-fixture',
      identities: {
        main: {
          bytes: 4_772,
          sha256: 'd20d5fe7d4425e4cd52de4c07d3cca5b3cdf02e90960991ec72de7a974810bf0',
        },
        worker: {
          bytes: 1_068,
          sha256: 'e75a2df63f822f505dcdcc1f6aeae9ddf6b276f6160f365526aa0d1e2ee951ab',
        },
      },
      analysisBoundary: {
        admission: 'sha256-and-byte-length-of-the-complete-extracted-main-and-worker-source-pair',
        driftPolicy: 'every-byte-change-fails-closed-until-a-fresh-review-pins-a-new-subject',
        semanticClaim: 'identity-only-not-general-javascript-control-flow-or-runtime-behavior-proof',
        currentAsarRuntimeEvidence: 'unearned',
      },
    });
  });

  it('rejects a maintained fixture when the caller requests the retained package identity', () => {
    expect(() => assertPackagedUtilityContainmentSources({
      mainSource,
      workerSource,
      expectedSubject: 'reviewed-main-worker-pair-20260822',
    })).toThrow('exact emitted subject identity mismatch for reviewed-main-worker-pair-20260822');
  });

  it('rejects inert sources even when every former marker remains', () => {
    const inertMain = `const markers = ${JSON.stringify(allMarkers)};`;
    const inertWorker = `const markers = ${JSON.stringify(allMarkers)};`;
    expectAllMarkers(inertMain, inertWorker);
    expect(() => assertPackagedUtilityContainmentSources({ mainSource: inertMain, workerSource: inertWorker }))
      .toThrow('exact emitted subject identity mismatch');
  });

  it.each([
    [
      'active cancellation termination',
      mainSource.replace('worker?.kill();\n    this.pump();', 'worker?.status();\n    this.pump();'),
      workerSource,
    ],
    [
      'timeout termination',
      mainSource.replace('worker.kill();\n      this.pump();', 'worker.status();\n      this.pump();'),
      workerSource,
    ],
    [
      'exit-driven restart',
      mainSource.replace('this.pump();\n  }\n  finish', 'this.status();\n  }\n  finish'),
      workerSource,
    ],
    [
      'worker crash action',
      mainSource,
      workerSource.replace('setTimeout(() => process.crash(), 100)', 'setTimeout(() => undefined, 100)'),
    ],
    [
      'worker hang action',
      mainSource,
      workerSource.replace('await new Promise(() => undefined)', 'await Promise.resolve()'),
    ],
    [
      'worker message admission',
      mainSource,
      workerSource.replace('process.parentPort.on("message"', 'process.parentPort.off("message"'),
    ],
    [
      'headless scenario invocation',
      mainSource.replace('void runScenario(engineRuntime, fnd09UtilityContainmentE2e)', 'void Promise.resolve()'),
      workerSource,
    ],
  ])('rejects a literal-preserving break in %s', (_label, candidateMain, candidateWorker) => {
    expectAllMarkers(candidateMain, candidateWorker);
    expect(() => assertPackagedUtilityContainmentSources({ mainSource: candidateMain, workerSource: candidateWorker }))
      .toThrow('exact emitted subject identity mismatch');
  });

  it.each([
    ['main', discardCallback(mainSource), workerSource],
    ['worker', mainSource, discardCallback(workerSource)],
    ['main in an unconstructed class', parkInClass(mainSource), workerSource],
    ['worker in an unconstructed class', mainSource, parkInClass(workerSource)],
    ['main in a constructed but uncalled method', parkInClass(mainSource, 'new ParkedSubject();'), workerSource],
    ['worker in a constructed but uncalled method', mainSource, parkInClass(workerSource, 'new ParkedSubject();')],
  ])('rejects the complete contract moved into %s', (_label, candidateMain, candidateWorker) => {
    expectAllMarkers(candidateMain, candidateWorker);
    expect(() => assertPackagedUtilityContainmentSources({ mainSource: candidateMain, workerSource: candidateWorker }))
      .toThrow('exact emitted subject identity mismatch');
  });

  it.each([
    ['main through a lexical invoking callback', invokeCallback(mainSource), workerSource],
    ['worker through a lexical invoking callback', mainSource, invokeCallback(workerSource)],
    ['main through a constructed and invoked method', parkInClass(mainSource, 'new ParkedSubject().install();'), workerSource],
    ['worker through a constructed and invoked method', mainSource, parkInClass(workerSource, 'new ParkedSubject().install();')],
    ['main behind a reachable let with an unrelated same-name false const', guardWithLexicalShadow(mainSource), workerSource],
    ['worker behind a reachable let with an unrelated same-name false const', mainSource, guardWithLexicalShadow(workerSource)],
  ])('requires fresh review even for semantically safe emitted drift: %s', (_label, candidateMain, candidateWorker) => {
    expectAllMarkers(candidateMain, candidateWorker);
    expect(() => assertPackagedUtilityContainmentSources({ mainSource: candidateMain, workerSource: candidateWorker }))
      .toThrow('exact emitted subject identity mismatch');
  });

  it('runs the complete emitted-source adversarial control matrix', () => {
    const report = assertPackagedUtilityContainmentAdversarialControls({
      mainSource,
      workerSource,
      expectedSubject: 'maintained-unit-fixture',
    });
    expect(report.assurance).toBe('exact-emitted-subject-drift-controls');
    expect(report.rejectionBoundary).toBe('complete-main-or-worker-byte-drift-from-the-reviewed-subject');
    expect(report.semanticClaim).toBe('mutation-rejection-by-exact-identity-not-general-javascript-interpretation');
    expect(report.reachabilityNegativeCasesPerChunk).toContain('unconditional-recursion');
    expect(report.structuralNegativeCases).toEqual(expect.arrayContaining([
      'cancellation-kill-decoy-receiver',
      'scenario-local-helper-late-throw',
      'cancellation-local-helper-late-loop',
      'worker-admission-local-helper-recursion',
      'worker-dispatch-throwing-getter-read',
      'enqueue-local-helper-late-throw',
      'message-settlement-local-helper-late-throw',
      'worker-dispatch-nontermination',
      'active-task-publication-removed',
      'queue-shift-replaced-with-decoy',
      'fork-replaced-with-decoy-result',
      'captured-worker-post-message-noop',
      'finish-terminal-1-noop',
      'native-Promise-resolve-overwrite',
      'native-Promise-then-overwrite',
      'AbortSignal-addEventListener-overwrite',
      'worker-request-String-event-data',
      'worker-request-arbitrary-event-data-factory',
      'validated-worker-request-reassignment',
      'crash-timer-clearInterval-cancellation',
      'crash-timer-handle-close-cancellation',
      'crash-timer-object-alias-cancellation',
      'crash-timer-helper-cancellation',
      'crash-timer-prebound-cancellation',
      'object-aliased Object.defineProperty process.crash overwrite',
      'array-aliased Object.defineProperty process.crash overwrite',
      'destructured Reflect.apply process.crash overwrite',
      'Function.prototype.apply.call process.crash overwrite',
      'destructuring assignment global process overwrite',
      'indirect eval global process overwrite',
      'Function constructor global process overwrite',
      'Promise.resolve overwrite',
      'Promise.prototype.then overwrite',
      'AbortSignal registration overwrite',
      'parentPort listener overwrite',
      'parentPort response overwrite',
      'nested Reflect.apply Function.call defineProperty',
    ]));
    expect(report.safeDriftCasesRequiringReview).toEqual(expect.arrayContaining([
      'main:direct-invoking-callback',
      'worker:safe-post-crash-timer-cancellation',
    ]));
    expect(report.unchangedReviewedSubjectReadmitted).toBe(true);
  });

  it('still rejects an incomplete fixed inventory before structural inspection', () => {
    expect(() => assertPackagedUtilityContainmentSources({
      mainSource: mainSource.replace('fnd09-utility-containment-probe.json', ''),
      workerSource,
    })).toThrow('missing FND-09 utility containment inventory');
  });
});
