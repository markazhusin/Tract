import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  plugins: [basicSsl()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Один origin (HTTPS) — иначе с https://IP:5173 браузер режет fetch на http://IP:8877
    proxy: {
      '/peer': { target: 'http://127.0.0.1:8877', changeOrigin: true },
      '/peers': { target: 'http://127.0.0.1:8877', changeOrigin: true },
      '/signal': { target: 'http://127.0.0.1:8877', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:8877', changeOrigin: true },
      '/identity': { target: 'http://127.0.0.1:8877', changeOrigin: true },
      '/inbox': { target: 'http://127.0.0.1:8877', changeOrigin: true },
      '/profile': { target: 'http://127.0.0.1:8877', changeOrigin: true },
      '/contacts': { target: 'http://127.0.0.1:8877', changeOrigin: true },
      '/groups': { target: 'http://127.0.0.1:8877', changeOrigin: true },
      '/admin': { target: 'http://127.0.0.1:8877', changeOrigin: true },
      '/events': { target: 'http://127.0.0.1:8877', changeOrigin: true },
      '/messaging': { target: 'http://127.0.0.1:8877', changeOrigin: true }
    }
  },
  publicDir: 'public'
});
