import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' keeps the build relocatable, so it works both at the domain root
// and under a GitHub Pages project path (/repo/). Hash routing avoids any
// need for the 404.html rewrite trick.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    // duckdb-wasm + graphic-walker are heavyweight; keep them out of the
    // entry chunk so the grid paints before any WASM loads.
    chunkSizeWarningLimit: 4000,
  },
});
