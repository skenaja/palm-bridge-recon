import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Data files live in web/public/data/ and are served verbatim at /data/*.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist' },
});
