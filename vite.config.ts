import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';
import path from 'node:path';
import { readFileSync, rmSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, 'package.json'), 'utf8')) as { version: string };

/**
 * 빌드할 때마다 dist-electron 을 비운다.
 * main 묶음은 이름에 해시가 붙어(main-XXXX.js) 빌드마다 새 파일이 생기는데, vite-plugin-electron 은
 * main·preload 가 같은 폴더를 쓰기 때문에 폴더를 비우지 않는다. 그대로 두면 옛 묶음이 쌓이고,
 * electron-builder 가 `dist-electron/**` 를 통째로 설치본에 넣는다(v0.12.1 설치본에 옛 묶음 24개·9MB).
 * 개발 서버(serve)에서는 preload.cjs 를 지우면 안 되므로 build 에서만 돈다.
 */
function cleanDistElectron() {
  return {
    name: 'clean-dist-electron',
    apply: 'build' as const,
    buildStart() {
      rmSync(path.resolve(import.meta.dirname, 'dist-electron'), { recursive: true, force: true });
    },
  };
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    cleanDistElectron(),
    react(),
    // vite-plugin-electron 1.x + Vite 8(Rolldown):
    // - 묶음 옵션은 `rolldownOptions`에 쓴다. `rollupOptions`로 쓰면 플러그인 기본값(rolldownOptions)과 합쳐질 때 버려진다.
    // - electron·Node 내장 모듈은 플러그인이 알아서 external 로 둔다. 출력 폴더 기본값은 dist-electron.
    // - preload 는 기본이 CJS·한 파일(codeSplitting: false)이다. 파일 이름만 main.ts 가 찾는 preload.cjs 로 맞춘다
    //   (package.json 이 "type": "module" 이라 기본 이름은 preload.mjs).
    electron({
      main: {
        entry: 'electron/main.ts',
      },
      preload: {
        input: 'electron/preload.ts',
        vite: {
          build: {
            rolldownOptions: {
              output: {
                entryFileNames: 'preload.cjs',
              },
            },
          },
        },
      },
      renderer: {},
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      '@core': path.resolve(import.meta.dirname, './src/core'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
