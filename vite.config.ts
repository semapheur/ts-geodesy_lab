import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
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
