import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  outputFileTracingIncludes: { "/api/workbook": ["./certs/supabase-prod-ca-2021.crt"] },
  turbopack: { root: process.cwd() },
};

export default config;
