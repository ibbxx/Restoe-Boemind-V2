import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createStableId, parseStableId } from "../src/domain/ids.ts";
import { isProfitMueOperational, parseProfile, PROFILES } from "../src/domain/profiles.ts";
import type { CellInput } from "../src/domain/contracts.ts";

describe("stable IDs", () => {
  it("creates distinct UUIDs without a row position or vendor label", () => {
    const ids = Array.from({ length: 100 }, () => createStableId<"cell">());
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.equal(parseStableId<"cell">(id), id);
  });

  it("normalizes an external UUID representation without changing identity", () => {
    const value = "550E8400-E29B-41D4-A716-446655440000";
    assert.equal(parseStableId<"project">(value), value.toLowerCase());
  });

  for (const value of [undefined, null, 0, {}, [], "", "A1", "row-1", "vendor-name",
    " 550e8400-e29b-41d4-a716-446655440000", "550e8400-e29b-11d4-a716-446655440000",
  ]) {
    it("rejects an invalid external ID: " + JSON.stringify(value), () => {
      assert.throws(() => parseStableId<"cell">(value), TypeError);
    });
  }
});

describe("profile invariants", () => {
  it("recognizes both profile codes", () => {
    assert.deepEqual(PROFILES, ["INU", "SOLAR_BAWAH"]);
    for (const profile of PROFILES) assert.equal(parseProfile(profile), profile);
  });

  for (const value of [undefined, null, "inu", "SOLAR", "", 0]) {
    it("rejects an unknown profile: " + JSON.stringify(value), () => {
      assert.throws(() => parseProfile(value), TypeError);
    });
  }

  it("makes Profit MUE operational only on INU", () => {
    assert.equal(isProfitMueOperational("INU"), true);
    assert.equal(isProfitMueOperational("SOLAR_BAWAH"), false);
  });
});

it("retains explicit zero separately from an unset raw input", () => {
  const unset: CellInput = { kind: "UNSET" };
  const zero: CellInput = { kind: "NUMERIC_TEXT", text: "0" };
  assert.notDeepEqual(zero, unset);
  assert.deepEqual(JSON.parse(JSON.stringify(zero)), zero);
});
