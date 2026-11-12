import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The native wallet fetches a localhost app's public permission manifest from
// its webview. Keep loopback development origins and allow that exact origin.
const localWalletCors = {
  origin: ['tauri://localhost', /^https?:\/\/(?:(?:[^:]+\.)?localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/]
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: { cors: localWalletCors },
  preview: { cors: localWalletCors },
  build: {
    outDir: 'build'
  }
})
