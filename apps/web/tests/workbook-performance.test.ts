import assert from "node:assert/strict";
import test from "node:test";
import { afterWorkbookPaint, measureWorkbookTask } from "../src/ui/workbook-performance.ts";

test("calculation waits for a paint opportunity and cancels obsolete work", t => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0, calls = 0;
  const originalRequest = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const originalCancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback); return frameId;
  } });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: (id: number) => { frames.delete(id); } });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const frame = () => { const [id, callback] = frames.entries().next().value!; frames.delete(id); callback(0); };
  try {
    const cancelFirst = afterWorkbookPaint(() => { calls++; });
    t.mock.timers.tick(1); assert.equal(calls, 0);
    frame(); t.mock.timers.tick(1); assert.equal(calls, 0);
    frame(); t.mock.timers.tick(1); assert.equal(calls, 1);
    cancelFirst();
    const cancelBeforeFrame = afterWorkbookPaint(() => { calls++; });
    cancelBeforeFrame(); assert.equal(frames.size, 0);
    const cancelBetweenFrames = afterWorkbookPaint(() => { calls++; });
    frame(); cancelBetweenFrames(); assert.equal(frames.size, 0);
    const cancelBeforeCalculation = afterWorkbookPaint(() => { calls++; });
    frame(); frame(); cancelBeforeCalculation();
    t.mock.timers.tick(1); assert.equal(calls, 1);
  } finally {
    if (originalRequest) Object.defineProperty(globalThis, "requestAnimationFrame", originalRequest);
    else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    if (originalCancel) Object.defineProperty(globalThis, "cancelAnimationFrame", originalCancel);
    else Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
  }
});

test("workbook timing preserves values/errors and retains one sample per stage", () => {
  const value = { status: "unchanged" };
  assert.equal(measureWorkbookTask("normalize", () => value), value);
  const error = new Error("Invalid input");
  assert.throws(() => measureWorkbookTask("normalize", () => { throw error; }), cause => cause === error);
  const entries = performance.getEntriesByName("procurement:normalize", "measure");
  assert.equal(entries.length, 1);
  assert(Number.isFinite(entries[0]!.duration) && entries[0]!.duration >= 0);
  performance.clearMeasures("procurement:normalize");
});
