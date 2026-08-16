import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Relative, so the built app works from ANY directory it is copied into — including the
  // evidence root beside the dashboard.json it reads. An absolute base would tie the build
  // to one deployment path and break exactly the "just copy it next to the data" story.
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  // `geoqa server` serves apps/ui/dist — no HMR. `pnpm ui:dev` is the hot console; it
  // proxies the API to the already-running server so a cookie from :4180 still works
  // (cookies ignore port on localhost).
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4180",
      "/dashboard.json": "http://127.0.0.1:4180",
      "/health": "http://127.0.0.1:4180",
    },
  },
});
