import type { WorkbookSnapshot } from "./contracts.ts";
import { parseSnapshot, requireCondition } from "./validation.ts";

export function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(child => freeze(child));
    Object.freeze(value);
  }
  return value;
}

// Object keys are canonical; arrays retain explicit display order.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    requireCondition(Number.isFinite(value), "Cannot serialize a nonfinite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  requireCondition(typeof value === "object", "Cannot serialize this value.");
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map(key => JSON.stringify(key) + ":" + canonicalJson(record[key])).join(",") + "}";
}

export function captureSnapshot(value: unknown): WorkbookSnapshot {
  return freeze(parseSnapshot(value));
}

export function serializeSnapshot(value: unknown): string {
  return canonicalJson(parseSnapshot(value));
}

export function deserializeSnapshot(serialized: string): WorkbookSnapshot {
  return captureSnapshot(JSON.parse(serialized));
}
