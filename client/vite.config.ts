import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "127.0.0.1",
    // Port + API proxy target are env-configurable (default to the primary dev
    // values) so a second sandbox can run alongside the first, e.g.
    //   CLIENT_PORT=5373 API_PROXY_TARGET=http://127.0.0.1:3003 npm run dev -w client
    port: Number(process.env.CLIENT_PORT) || 5273,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.API_PROXY_TARGET || "http://127.0.0.1:3001",
        changeOrigin: true,
      },
      "/auth": {
        target: process.env.API_PROXY_TARGET || "http://127.0.0.1:3001",
        changeOrigin: true,
      },
    },
  },
});
