import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'CONTROLLER_');
  const target = env.CONTROLLER_API_URL || 'http://127.0.0.1:8787';
  const url = new URL(target);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('CONTROLLER_API_URL must be a credential-free localhost origin.');
  }
  const proxy = {
    '^/api/incidents(?:/[^/?]+)?(?:\\?.*)?$': {
      target, changeOrigin: false,
      bypass(req: { method?: string }) {
        if (req.method !== 'GET') return false;
      },
    },
    // Read-only views of the agent feed. The run trigger is never proxied.
    '^/api/settings(?:\\?.*)?$': { target, changeOrigin: false },
    '^/api/watch(?:\\?.*)?$': {
      target, changeOrigin: false,
      bypass(req: { method?: string }) {
        if (req.method !== 'GET') return false;
      },
    },
    '^/api/agent/runs(?:/[a-z0-9-]+(?:/events)?)?(?:\\?.*)?$': {
      target, changeOrigin: false,
      bypass(req: { method?: string }) {
        if (req.method !== 'GET') return false;
      },
    },
  };
  return {
    plugins: [react()],
    server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy },
  };
});
