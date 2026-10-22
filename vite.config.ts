import { defineConfig, defaultClientConditions } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `base` is configurable for nested static hosts (e.g. GitHub Pages: BASE_PATH=/repo-name/).
// `--mode artifact` emits one self-contained HTML file for embedding in a Claude Artifact.
export default defineConfig(({ mode }) => ({
  base: process.env.BASE_PATH ?? './',
  plugins: mode === 'artifact' ? [viteSingleFile()] : [],
  // onnxruntime-web's official "extern wasm" build: transformers.js fetches the ~27 MB ONNX Runtime
  // WASM from jsDelivr at runtime (only when on-device 3D is used) instead of bundling it.
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions] },
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
