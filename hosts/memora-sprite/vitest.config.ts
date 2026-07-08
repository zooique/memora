import { defineConfig } from 'vitest/config';

// Vitest 配置（精灵宿主项目）
// - globals: 全局 API（describe/it/expect 免 import）
// - environment: node（渲染进程测试通过 @vitest-environment jsdom 注解覆盖）
// - coverage: 覆盖率阈值配置，强制保持质量基线
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      // 覆盖率阈值：与内核 1.0 对标，保持质量基线
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 75,
        lines: 80,
      },
      // 排除类型定义文件和纯接口文件（无运行时代码）
      exclude: [
        'src/**/*.d.ts',
        'src/**/types.ts',
        'src/**/*Interface.ts',
        'src/**/index.ts',
        'src/electron/preload.ts',
        'src/electron/main.ts',
        'src/electron/esmShim.ts',
        'src/__tests__/**',
      ],
    },
  },
});
