import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

// shortcut: React lint plugin requires ESLint 9; upgrade when ESLint 10 peer support is verified.

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores([".next/**", "out/**", "coverage/**", "next-env.d.ts"]),
  {
    files: ["src/domain/**/*.ts", "src/engine/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: ["react", "react-dom", "react-dom/*", "next", "next/*", "@supabase/*"],
      }],
    },
  },
]);
