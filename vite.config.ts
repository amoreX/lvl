import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_URL || `http://localhost:${env.PORT || 4321}`;

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': apiTarget,
        '/task-pages': apiTarget,
      },
    },
    build: {
      outDir: 'dist/web',
    },
  };
});
