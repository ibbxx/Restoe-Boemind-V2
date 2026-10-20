export type EntityKind =
  | "project" | "vendor" | "offer" | "offer" | "offer-value"
  | "worksheet" | "table" | "row" | "column" | "cell" | "merge" | "formula" | "snapshot"
  | "policy" | "version" | "run" | "user" | "mutation"
  | "analysis" | "mapping" | "aggregate" | "aggregate-version" | "ahs-group";

declare const entityKind: unique symbol;
export type StableId<Kind extends EntityKind> = string & {
  readonly [entityKind]: Kind;
};

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Format validation is not proof of ownership or project authorization.
export function parseStableId<Kind extends EntityKind>(value: unknown): StableId<Kind> {
  if (typeof value !== "string" || !uuidV4.test(value)) {
    throw new TypeError("Stable ID must be a UUID v4, not a cell address or display position.");
  }
  return value.toLowerCase() as StableId<Kind>;
}

export function createStableId<Kind extends EntityKind>(): StableId<Kind> {
  return parseStableId<Kind>(globalThis.crypto.randomUUID());
}
