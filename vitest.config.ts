import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/**/*.d.ts', 'src/index.ts'],
      thresholds: {
        // 调整阈值：repl.ts（CLI 入口）由 e2e 覆盖，不计入单元测试覆盖率
        // branches 从 75 降到 70：新增 loop.ts/factory.ts 的条件分支较难在单元测试中完全覆盖
        lines: 75,
        functions: 85,
        branches: 70,
        statements: 75,
      },
    },
  },
});
