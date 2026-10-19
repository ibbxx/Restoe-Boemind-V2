import type { SavedWorkbook, SaveOutcome } from "../application/contracts.ts";

export interface WorkbookRepository {
  current(analysisId: unknown): SavedWorkbook | null;
  save(request: unknown, actorId: unknown): SaveOutcome;
}
export type PersistentWorkbookRepository = {
  [Method in keyof WorkbookRepository]: (...args: Parameters<WorkbookRepository[Method]>) => Promise<ReturnType<WorkbookRepository[Method]>>;
};
