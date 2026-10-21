export const ANALYSIS_STATUSES = ["DRAFT", "HOLD", "COMPLETED", "CANCELLED"] as const;
export type AnalysisStatus = typeof ANALYSIS_STATUSES[number];
export const analysisStatusLabel: Record<AnalysisStatus, string> = {
  DRAFT: "Draft", HOLD: "Hold", COMPLETED: "Selesai", CANCELLED: "Dibatalkan",
};
