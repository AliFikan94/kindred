import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Relative base: the app is static and can be served from any path (IPFS, a subfolder, a bucket).
export default defineConfig({ base: './', plugins: [react()], build: { target: 'es2022', sourcemap: true } });
