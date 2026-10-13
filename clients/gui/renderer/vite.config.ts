import { defineConfig, type Plugin } from "vite";
import { remoteStaticAssets } from "../scripts/remote-static-assets.mjs";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const remoteShell: Plugin = {
  name: "remote-static-shell",
  apply: "build",
  enforce: "post",
  generateBundle(_options, bundle) {
    const { files } = remoteStaticAssets(bundle);
    for (const [fileName, source] of files) {
      if (fileName === "remote.html" && bundle[fileName].type === "asset")
        bundle[fileName].source = source;
      else if (!bundle[fileName]) this.emitFile({ type: "asset", fileName, source });
    }
  },
};
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), remoteShell],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        remote: fileURLToPath(new URL("./remote.html", import.meta.url)),
      },
    },
    commonjsOptions: { include: [/node_modules/, /desktop-contract\.cjs$/] },
  },
});
