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
    // 强制颜色，避免跨终端差异（只设 FORCE_COLOR：它与 NO_COLOR 同设时 Node 会为每个 worker
    // 打印一行「NO_COLOR is ignored due to FORCE_COLOR」告警 → 每文件一行重复噪音、淹没真实
    // 告警；且 Node 既定语义就是 FORCE_COLOR 优先，再给 NO_COLOR 属冗余。
    // 仅设 FORCE_COLOR 时着色（ANSI 转义）保留、该告警归零。
    env: {
      FORCE_COLOR: '1',
    },
  },
});
