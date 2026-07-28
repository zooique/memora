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
    // 全局环境变量：测试时跳过 PowerShell 调用（inputInjector.readElectronFocusedWindowTitle）
    // 避免 captureActiveWindow 在测试环境真实调用 PowerShell 绕过 mock，导致断言失败
    env: {
      MEMORA_SKIP_PS1: '1',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      // 跳过预清理：覆盖写入不删旧文件，避免本地开发重跑时沙箱安全删除批量拦截
      clean: false,
      cleanOnRerun: false,
      // 覆盖率阈值：实测达标值（2026-07-28），强制保持质量基线
      thresholds: {
        statements: 80,
        branches: 70,
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
