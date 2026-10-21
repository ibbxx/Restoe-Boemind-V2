import { parseStableId } from "../domain/ids.ts";
import { requireCondition } from "../domain/validation.ts";
import { ANALYSIS_STATUSES } from "../domain/analysis-status.ts";

export interface AnalysisListQuery {
  after?: unknown;
  before?: unknown;
  limit?: unknown;
  query?: unknown;
  status?: unknown;
  period?: unknown;
  analysisId?: unknown;
}

export function parseAnalysisList(value: AnalysisListQuery) {
  const after = value.after ? parseStableId(value.after) : null;
  const before = value.before ? parseStableId(value.before) : null;
  requireCondition(!after || !before, "Use only one pagination cursor.");
  const limit = value.limit == null ? 25 : Number(value.limit);
  requireCondition(Number.isInteger(limit) && limit >= 1 && limit <= 100, "Page size must be 1–100.");
  const query = value.query ?? "", status = value.status ?? "", period = value.period ?? "";
  requireCondition(typeof query === "string" && query.length <= 200, "Invalid analysis search.");
  requireCondition(typeof status === "string" && (!status || ANALYSIS_STATUSES.some(s => s === status)), "Invalid status filter.");
  requireCondition(typeof period === "string" && (!period || period === "NONE" || /^P[12]-(JAN|FEB|MAR|APR|MEI|JUN|JUL|AGU|SEP|OKT|NOV|DES)-\d{4}$/.test(period)), "Invalid period filter.");
  return { after, before, limit, query: query.trim(), status, period,
    analysisId: value.analysisId ? parseStableId(value.analysisId) : null };
}
