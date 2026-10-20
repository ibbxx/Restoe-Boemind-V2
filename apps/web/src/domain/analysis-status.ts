export const ANALYSIS_STATUSES = ["DRAFT", "ACTIVE", "HOLD", "COMPLETED", "CANCELLED"] as const;
export type AnalysisStatus = typeof ANALYSIS_STATUSES[number];
export const analysisStatusLabel: Record<AnalysisStatus, string> = {
  DRAFT: "Draft", ACTIVE: "Aktif", HOLD: "Hold", COMPLETED: "Selesai", CANCELLED: "Dibatalkan",
};
