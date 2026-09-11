import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

export default defineConfig({
  plugins: [{
    name: "preserve-transport-notices",
    generateBundle() {
      for (const name of ["LICENSE", "LICENSES/LGPL-3.0.txt", "LICENSES/GPL-3.0.txt", "THIRD_PARTY_NOTICES.md"]) {
        this.emitFile({ type: "asset", fileName: name, source: readFileSync(name, "utf8") });
      }
    },
  }],
  build: { target: "es2022", sourcemap: false },
  test: { environment: "jsdom", include: ["tests/**/*.test.ts"], restoreMocks: true },
});
