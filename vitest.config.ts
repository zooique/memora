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
    // 内核测试 + protocolGuard 守卫（纯源码解析无宿主运行时依赖）
    // webview 测试（chatView 等）需 jsdom 环境，用 test.files 条件匹配
    include: [
      'src/**/__tests__/**/*.test.ts',
      'hosts/memora-vscode/src/shared/__tests__/protocolGuard.test.ts',
      'hosts/memora-vscode/src/webview/__tests__/**/*.test.ts',
    ],
    // jsdom 环境：webview 测试用 DOM API（document / dispatchEvent），其他保持 node
    environmentMatchGlobs: [
      ['hosts/memora-vscode/src/webview/**', 'jsdom'],
    ],
    // ── 并发确定性策略（SSOT：见 docs/测试并发确定性与flake判定SOP.md）──
    // 文件级并发保持开启（fileParallelism=true 即 vitest 默认，此处显式声明策略意图）：
    // 跨文件并发加速本地/CI，代价是已知跨文件共享态 flake（agent.test.ts > memory.snapshot().working）。
    // 团队既定立场：并发红不归因代码、不靠禁用并发让测试过；flake 走判定 SOP（单独重跑该文件 → 必要时 --no-file-parallelism 全量）。
    // 切勿为消除 flake 改代码或默认禁用并发（2x 慢），详见 SOP 文档「禁区」。
    fileParallelism: true,
    // 强制 picocolors 输出 ANSI 颜色码（系统 NO_COLOR=1 会禁用颜色，测试环境需覆盖）
    env: {
      FORCE_COLOR: '1',
      NO_COLOR: '',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/**/*.d.ts', 'src/index.ts', 'hosts/**', 'hosts/memora-vscode/src/**'],
      thresholds: {
        // 实测基线（2026-09-16，`vitest run --coverage`，列序 = Stmts / Branch / Funcs / Lines）：
        //   90.30 / 84.78 / 92.27 / 91.52 —— 四项阈值均低于实际值，留缓冲防日常波动。
        // 0% 文件（agent/types.ts, llm/types.ts, memory/*Interface.ts 等）为纯类型/接口文件，无运行时代码
        lines: 80,
        // 覆盖率阈值的**判据 SSOT = 本文件**（机器只执行此处的量）。`.trae/rules/testing_rules.md` §3
        // 与本处同源对齐；冲突时**以本文件为准并回填文档**，不得反向。
        // 原注释的错法（已于 2026-09-16 订正）：引「文档是配置的描述，而非独立目标」推出「故以文档为准」——
        // 引文说文档是描述，结论却说文档是权威，**引文与结论反向**，属自相矛盾。
        // functions 由 83 恢复到 88：88 是 testing_rules.md §3 标注的「1.0 发布阈值」（**意图来源**，
        // 非本处推导），83 系 99edf24c 的漂移；实测 92.27%，置 88 后仍有约 4.3 点缓冲。
        // 已知不齐：functions 缓冲（≈4.3）明显小于另三项（≈10）——成因是它按「恢复原始意图」而非
        // 「按实测留量」定值。若要统一口径，须作为「改判据」动作带观测 + 退出条件后再动，不顺手改。
        functions: 88,
        branches: 75,
        statements: 80,
      },
    },
  },
});
