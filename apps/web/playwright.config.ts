import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e", fullyParallel: false, workers: 1, retries: 0, forbidOnly: true,
  timeout: 120000, expect: { timeout: 10000 }, reporter: "list",
  use: { channel: "chrome", headless: true, trace: "off", screenshot: "off", video: "off", actionTimeout: 10000, navigationTimeout: 15000 },
});
