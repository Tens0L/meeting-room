import { defineConfig } from "vite";

// GitHub Pages のサブパスに置く場合は VITE_BASE=/meeting-room/ を指定してビルドする
export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  server: { port: 5173 },
});
