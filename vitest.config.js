import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "cloudflare:sockets": fileURLToPath(new URL("./test/helpers/sockets-stub.js", import.meta.url)) },
  },
  test: { include: ["test/**/*.test.js"] },
});
