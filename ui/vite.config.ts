import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Relative, so the built app works from ANY directory it is copied into — including the
  // evidence root beside the dashboard.json it reads. An absolute base would tie the build
  // to one deployment path and break exactly the "just copy it next to the data" story.
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
});
