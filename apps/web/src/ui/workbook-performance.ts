type WorkbookTiming = "load" | "normalize" | "worksheet-render" | "calculation" | "save-input" | "save-serialize" | "save-request" | "save-response" | "save" | "save-render";

// Keep only the latest sample per stage; never put workbook data or identifiers in traces.
export function recordWorkbookTiming(stage: WorkbookTiming, started: number) {
  const name = `procurement:${stage}`;
  performance.clearMeasures(name);
  performance.measure(name, { start: started, end: performance.now() });
}

export function measureWorkbookTask<T>(stage: WorkbookTiming, work: () => T): T {
  const started = performance.now();
  try { return work(); }
  finally { recordWorkbookTiming(stage, started); }
}

export function afterWorkbookPaint(work: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => { timer = setTimeout(work, 0); });
  });
  return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
}
