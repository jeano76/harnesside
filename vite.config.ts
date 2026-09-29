import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/**
 * 웹 번들 설정 (§1.5).
 *
 * 산출물은 `dist/web/` — `dist/server/` 와 나란히 두는 이유: 서버는 `tsc` 가,
 * 브라우저는 `vite` 가 만든다. 섞으면 한쪽 빌드가 다른 쪽을 지운다.
 */
export default defineConfig({
  root: resolve(import.meta.dirname, "src/web"),
  base: "/",
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, "dist/web"),
    emptyOutDir: true,
    // GPU off 모드에서 소프트웨어 래스터가 비용을 갖는다(§4.7.4). 소스를 맵으로
    // 남기면 번들이 2배로 느려진다 → production 소스맵은 끈다.
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      output: {
        // Monaco 는 lazy load 라(§1.5) 여기서는 아직 없다. 향후 추가 시 manualChunks 로 분리.
        manualChunks: undefined,
      },
    },
  },
  server: {
    port: 5317,
    proxy: {
      // dev 중에는 Vite 서버가 뜨고, API/WS 는 harnesside 서버로 넘긴다.
      "/api": "http://127.0.0.1:7317",
      "/ws": { target: "ws://127.0.0.1:7317", ws: true },
    },
  },
});
