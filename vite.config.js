import {defineConfig, loadEnv} from 'vite';
import {streetCachePlugin} from './server/streetCachePlugin.js';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, process.cwd(), ['VITE_', 'GOOGLE_MAPS_SERVER_API_KEY', 'STREET_']);
  return {
    plugins: [streetCachePlugin({apiKey: env.GOOGLE_MAPS_SERVER_API_KEY || env.VITE_GOOGLE_MAPS_API_KEY, enabled: env.STREET_DISK_CACHE !== '0'})],
    server: {
      port: 5173, strictPort: true,
      watch: {ignored: ['**/.cache/**']},
      fs: {deny: ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**', '**/.cache/**']},
    },
    build: {target: 'es2022', rollupOptions: {output: {manualChunks: id => id.includes('/node_modules/three/') ? 'three' : undefined}}},
  };
});
