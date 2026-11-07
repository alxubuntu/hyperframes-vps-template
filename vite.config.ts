import { defineConfig, loadEnv } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, process.cwd(), ""));
  return {
    plugins: [tanstackStart(), viteReact()],
    // HyperFrames' lint entry uses extensionless ESM imports that Node cannot resolve directly.
    ssr: { noExternal: ["@hyperframes/core"] },
  };
});
