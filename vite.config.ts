import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte(), viteSingleFile()],
  server: {
    proxy: {
      "/icgem": {
        target: "https://icgem.gfz.de",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/icgem/, ""),
      },
    },
  },
});
