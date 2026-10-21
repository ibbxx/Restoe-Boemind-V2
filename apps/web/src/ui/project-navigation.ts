import { ANALYSIS_STATUSES } from "../domain/analysis-status.ts";
import type { AnalysisStatus } from "../domain/analysis-status.ts";

export interface ProjectLocation {
  projectId: string | null;
  analysisId: string | null;
  projectQuery: string;
  analysisQuery: string;
  status: AnalysisStatus | "";
  period: string;
  after: string;
  before: string;
}

export function readProjectLocation(search: string): ProjectLocation {
  const params = new URLSearchParams(search);
  const status = params.get("status") ?? "";
  return {
    projectId: params.get("projectId") || null, analysisId: params.get("analysisId") || null,
    projectQuery: params.get("projectQuery") ?? "", analysisQuery: params.get("analysisQuery") ?? "",
    status: ANALYSIS_STATUSES.includes(status as AnalysisStatus) ? status as AnalysisStatus : "",
    period: params.get("period") ?? "",
    after: params.get("after") ?? "", before: params.get("before") ?? "",
  };
}

export function projectLocationUrl(location: ProjectLocation): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(location)) if (value) params.set(key, value);
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

export function matchesName(name: string, query: string): boolean {
  return name.toLocaleLowerCase("id-ID").includes(query.trim().toLocaleLowerCase("id-ID"));
}

export function analysisListUrl(location: ProjectLocation, analysisId?: string): string {
  const params = new URLSearchParams({ view: "analyses", projectId: location.projectId ?? "" });
  if (analysisId) params.set("analysisId", analysisId);
  else for (const [key, value] of Object.entries({ after: location.after, before: location.before,
    query: location.analysisQuery, status: location.status, period: location.period })) if (value) params.set(key, value);
  return `/api/workbook?${params}`;
}

export function matchesAnalysis(analysis: { name: string; status: AnalysisStatus; period: string | null }, filters: ProjectLocation): boolean {
  return matchesName(analysis.name, filters.analysisQuery) && (!filters.status || analysis.status === filters.status)
    && (!filters.period || (filters.period === "NONE" ? !analysis.period : analysis.period === filters.period));
}
