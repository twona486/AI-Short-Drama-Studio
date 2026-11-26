import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import path from 'node:path'
import electron from 'vite-plugin-electron/simple'

/** Packaged builds must not inline this machine's .env keys or endpoints. */
const packEnvDir = path.join(__dirname, 'scripts/pack-env')

function stripMachineEnvOnPack(): Plugin {
  return {
    name: 'strip-machine-env-on-pack',
    configResolved(config) {
      if (config.command !== 'build') return
      for (const key of Object.keys(config.env)) {
        if (key.startsWith('VITE_')) config.env[key] = ''
      }
    }
  }
}

// https://vitejs.dev/config/
export default defineConfig(({ command }) => ({
  base: './',
  envDir: command === 'build' ? packEnvDir : __dirname,
  build: {
    sourcemap: false
  },
  plugins: [
    stripMachineEnvOnPack(),
    vue(),
    electron({
      main: {
        entry: 'electron/main.ts',
        onstart({ startup }) {
          const profile = process.env.DRAMA_FLOW_DEV_USER_DATA_DIR
          return startup(profile ? ['.', '--no-sandbox', `--user-data-dir=${profile}`] : undefined)
        },
        vite: {
          build: {
            rollupOptions: {
              // Node loads ws and handles its optional native modules at runtime.
              external: ['node:sqlite', '@grpc/grpc-js', 'flatbuffers', 'protobufjs', 'ws']
            }
          }
        }
      },
      preload: {
        input: path.join(__dirname, 'electron/preload.ts'),
        vite: {
          build: {
            rollupOptions: {
              output: {
                format: 'cjs',
                entryFileNames: 'preload.cjs',
                inlineDynamicImports: true
              }
            }
          }
        }
      }
    })
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    port: 5173,
    host: '0.0.0.0',
    // FFmpeg.wasm의 SharedArrayBuffer를 사용하려면 교차 출처 격리가 필요하다.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    },
    fs: {
      // public 폴더의 파일을 제공할 수 있도록 허용한다.
      strict: false
    }
  },
  preview: {
    port: 4173,
    host: '0.0.0.0',
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  },
  // FFmpeg 코어 WASM 파일이 Vite의 변환을 거치지 않게 한다.
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util', '@ffmpeg/core']
  }
  // FFmpeg 코어의 UMD 로더는 importScripts를 사용하므로
  // 모듈 워커를 사용하면 코어를 불러올 수 없다.
}))
