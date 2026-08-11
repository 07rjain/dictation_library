import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4174",
  },
  webServer: {
    command: "node scripts/browser-test-server.mjs",
    port: 4174,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit-safari", use: { ...devices["Desktop Safari"] } },
    { name: "chromium-android", use: { ...devices["Pixel 7"] } },
  ],
});
