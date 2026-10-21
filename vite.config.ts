import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `base` is configurable for nested static hosts (e.g. GitHub Pages: BASE_PATH=/repo-name/).
// `--mode artifact` emits one self-contained HTML file for embedding in a Claude Artifact.
export default defineConfig(({ mode }) => ({
  base: process.env.BASE_PATH ?? './',
  plugins: mode === 'artifact' ? [viteSingleFile()] : [],
  build: {
    outDir: mode === 'artifact' ? 'dist-artifact' : 'dist',
    target: 'es2022',
    sourcemap: mode !== 'artifact',
    chunkSizeWarningLimit: 1500,
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
}));
