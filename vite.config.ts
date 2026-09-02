import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    {
      // 루트 index.html 의 리다이렉트 블록은 **개발/브랜치-루트 서빙 전용**이다.
      // 빌드 산출물에 그대로 들어가면 dist/index.html 이 자기 자신을 다시 ./dist/ 로
      // 넘겨 404 가 난다 (실측). 빌드 때는 도려낸다.
      name: 'strip-pages-redirect',
      apply: 'build',
      transformIndexHtml(html: string): string {
        return html.replace(/<!--PAGES_REDIRECT_START-->[\s\S]*?<!--PAGES_REDIRECT_END-->\n?/, '')
      },
    },
  ],
  // 상대 경로 — 산출물이 어느 하위 경로에 놓여도 동작한다.
  //   Pages 소스가 "GitHub Actions" 면 /GunBalatro/ 에, 아직 브랜치-루트 모드면
  //   /GunBalatro/dist/ 에 서빙된다. 절대 base 는 둘 중 하나에서 반드시 404 가 난다.
  base: './',
  build: {
    target: 'es2020',
    assetsInlineLimit: 4096,
    rollupOptions: { output: { manualChunks: { three: ['three'] } } },
  },
  server: { host: true, port: 5173 },
})
