import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    global: "window",
  },
  resolve: {
    alias: {
      buffer: "buffer/",
    },
  },
  server: {
    host: "0.0.0.0",
    port: 43121,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:43122",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});
