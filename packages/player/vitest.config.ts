import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath (not URL.pathname): on Windows .pathname yields "/D:/..." with a
// leading slash, which breaks resolve() and the alias below.
const coreRoot = resolve(fileURLToPath(new URL("../core/src", import.meta.url)));

export default defineConfig({
  resolve: {
    alias: {
      "@hyperframes/core/runtime/composition-length": resolve(
        coreRoot,
        "runtime/compositionLength.ts",
      ),
      "@hyperframes/core/studio-preview-mark": resolve(coreRoot, "studioPreviewMark.ts"),
      "@hyperframes/core/composition-contract": resolve(coreRoot, "compositionContract.ts"),
      "@hyperframes/parsers/composition-contract": resolve(
        coreRoot,
        "../../parsers/src/compositionContract.ts",
      ),
      "@hyperframes/core/slideshow": resolve(coreRoot, "slideshow/index.ts"),
      "@hyperframes/core/runtime/protocol": resolve(coreRoot, "runtime/protocol.ts"),
    },
  },
  test: {
    environment: "happy-dom",
    environmentOptions: {
      happyDOM: { settings: { handleDisabledFileLoadingAsSuccess: true } },
    },
    setupFiles: ["./src/slideshow/test-setup.ts"],
    // Node 25 turns on its own localStorage, which shadows happy-dom's and has no clear().
    execArgv: Object.getOwnPropertyDescriptor(globalThis, "localStorage")
      ? ["--no-experimental-webstorage"]
      : [],
  },
});
