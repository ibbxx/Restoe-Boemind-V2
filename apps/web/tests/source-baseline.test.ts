import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { it } from "node:test";

it("guards the immutable source workbook identity, not formula correctness", () => {
  const workbook = readFileSync(new URL("../../../AHAS Sistem.xlsx", import.meta.url));
  assert.equal(createHash("sha256").update(workbook).digest("hex"),
    "efe4f10792453d8407bb47539b7f7aea015332faf6cabdbeb22a530a9e5e1abc",
  );
});

it.todo("EV-005: 22860 versus independently reported 25170 needs sign-off before it becomes an acceptance oracle");
