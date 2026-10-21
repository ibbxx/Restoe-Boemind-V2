import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import test from "node:test";
import { runtimeConfiguration } from "../src/server/runtime-configuration.ts";

const remote = {
  DATABASE_URL: "postgres://procurement_app_login.example:password@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
};

test("remote database trusts the bundled CA and requires certificate verification", () => {
  const { ssl } = runtimeConfiguration(remote);
  assert(ssl);
  assert.equal(ssl.rejectUnauthorized, true);
  const certificate = new X509Certificate(ssl.ca);
  assert.equal(certificate.ca, true);
  assert.equal(certificate.verify(certificate.publicKey), true);
});

test("loopback database remains usable without TLS", () => {
  assert.equal(runtimeConfiguration({ ...remote,
    DATABASE_URL: "postgres://localhost:5432/postgres", SUPABASE_URL: "http://localhost:54321",
  }).ssl, false);
});

test("remote database still rejects disabled TLS verification", () => {
  assert.throws(() => runtimeConfiguration({ ...remote, NODE_TLS_REJECT_UNAUTHORIZED: "0" }), /TLS verification must remain enabled/);
});
