/**
 * 插件独立测试配置 — vitest
 *
 * 插件开发期复用仓库根的 vitest 依赖（hosts/memora-vscode 无独立 node_modules），
 * 但从本目录运行以隔离插件自身的测试范围（不干扰内核 src/ 的覆盖率统计）。
 *
 * 运行方式（在 hosts/memora-vscode 下）：
 *   npx --prefix ../.. vitest run
 *   或： node --import ../../node_modules/tsx/dist/loader.mjs ../../node_modules/vitest/vitest.mjs run
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    // 强制颜色，避免跨终端差异
    env: {
      FORCE_COLOR: '1',
      NO_COLOR: '',
    },
  },
});