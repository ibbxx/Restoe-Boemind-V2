import { operationalGraph } from "./inu-solver.ts";
import type { SolverResultMessage, SolverRunMessage } from "./solver-runner.ts";

if (typeof self !== "undefined") {
  self.onmessage = (event: MessageEvent<SolverRunMessage>) => {
    const { sequence, snapshot, configuration } = event.data;
    try {
      const { solver } = operationalGraph(snapshot, configuration);
      const response: SolverResultMessage = { sequence, solver };
      self.postMessage(response);
    } catch {
      const response: SolverResultMessage = { sequence, solver: undefined };
      self.postMessage(response);
    }
  };
}
