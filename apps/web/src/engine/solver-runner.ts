import type { WorkbookSnapshot } from "../domain/contracts.ts";
import type { EngineConfiguration } from "./contracts.ts";
import type { SolverResult } from "./inu-solver.ts";
import { operationalGraph } from "./inu-solver.ts";

export interface SolverRunMessage {
  readonly sequence: number;
  readonly snapshot: WorkbookSnapshot;
  readonly configuration: EngineConfiguration;
}

export interface SolverResultMessage {
  readonly sequence: number;
  readonly solver: SolverResult | undefined;
}

export class SolverManager {
  #currentSequence = 0;
  #worker: Worker | null = null;

  constructor(customWorker?: Worker) {
    if (customWorker) {
      this.#worker = customWorker;
    } else if (typeof window !== "undefined" && typeof Worker !== "undefined") {
      try {
        this.#worker = new Worker(new URL("./inu-solver.worker.ts", import.meta.url));
      } catch {
        this.#worker = null;
      }
    }
  }

  get currentSequence() {
    return this.#currentSequence;
  }

  requestSolve(
    snapshot: WorkbookSnapshot,
    configuration: EngineConfiguration,
    onResult: (result: SolverResult | undefined) => void
  ): () => void {
    const sequence = ++this.#currentSequence;

    if (this.#worker) {
      this.#worker.onmessage = (event: MessageEvent<SolverResultMessage>) => {
        // Discard expired worker results
        if (event.data.sequence === this.#currentSequence) {
          onResult(event.data.solver);
        }
      };
      this.#worker.postMessage({ sequence, snapshot, configuration });
    } else {
      const res = operationalGraph(snapshot, configuration);
      if (sequence === this.#currentSequence) {
        onResult(res.solver);
      }
    }

    return () => {
      // Invalidate pending worker result
      if (this.#currentSequence === sequence) {
        this.#currentSequence++;
      }
    };
  }

  // Directly simulates an expired/stale message arriving from a worker
  dispatchWorkerMessage(message: SolverResultMessage, onResult: (result: SolverResult | undefined) => void): boolean {
    if (message.sequence === this.#currentSequence) {
      onResult(message.solver);
      return true;
    }
    // Stale result discarded
    return false;
  }

  terminate() {
    this.#worker?.terminate();
    this.#worker = null;
  }
}
