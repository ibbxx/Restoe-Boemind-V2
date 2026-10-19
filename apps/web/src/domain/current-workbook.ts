import type { WorkbookSnapshot } from "./contracts.ts";
import { captureSnapshot } from "./snapshots.ts";
import { refreshCurrentOffers } from "./current-offers.ts";

// Captures the current state only; calculation previews live outside the workbook.
export function currentSnapshot(value: unknown): WorkbookSnapshot {
  const s = captureSnapshot(value);
  return refreshCurrentOffers(s);
}
