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
    // 覆盖边界 = 内核 src/ + protocolGuard 守卫。protocolGuard 是纯源码解析（无宿主运行时
    // 依赖），保留在根路径供内核门禁独立守协议 SSOT（shared/protocol.ts）。
    // 宿主测试（含 webview jsdom）一律归宿主 vitest 独立跑（host:test），
    // 不在此 include —— 双 include 会让 webview 全套被跑两遍、根门禁被其
    // 30s 重放用例拖慢/超时（chatView R3/R4 flake）。
    // webview 的 jsdom 环境由**需要 DOM 的测试文件**在自身头部声明 `@vitest-environment jsdom`
    // （移除 environmentMatchGlobs 后，per-file 声明是唯一来源）。
    // ⚠️ **实测并非「全部已声明」**：webview/** 下仍有一批纯逻辑测试文件不带该声明 → 按宿主
    // 配置默认跑 node。已逐个核验它们**零 DOM 引用**，故与 jsdom 相比**无功能差异**。
    // **缺声明不存在静默风险**：届时访问 DOM 会直接 ReferenceError 报红（失败响亮而非静默），
    // 因此**不额外加守卫生效**（重复保护）。**新增依赖 DOM 的用例必须自带该声明**，
    // 否则将以「document is not defined」失败。
    include: [
      'src/**/__tests__/**/*.test.ts',
      'hosts/memora-vscode/src/shared/__tests__/protocolGuard.test.ts',
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
        // 实测基线（`vitest run --coverage`，列序 = Stmts / Branch / Funcs / Lines）：
        //   90.30 / 84.78 / 92.27 / 91.52 —— 四项阈值均低于实际值，留缓冲防日常波动。
        // 0% 文件（agent/types.ts, llm/types.ts, memory/*Interface.ts 等）为纯类型/接口文件，无运行时代码
        lines: 80,
        // 覆盖率阈值的**判据 SSOT = 本文件**（机器只执行此处的量）。`.trae/rules/generic/testing_rules.md`
        // 与本处同源对齐；冲突时**以本文件为准并回填文档**，不得反向。
        // 反向（以文档为准）不成立：「文档是配置的描述，而非独立目标」——
        // 引文说文档是描述，若结论说文档是权威，**引文与结论反向**，属自相矛盾。
        // functions 取 88：88 是 testing_rules.md 标注的「1.0 发布阈值」（**意图来源**，
        // 非本处推导）；实测 92.27%，置 88 后仍有约 4.3 点缓冲。
        // 已知不齐：functions 缓冲（≈4.3）明显小于另三项（≈10）——成因是它按「恢复原始意图」而非
        // 「按实测留量」定值。若要统一口径，须作为「改判据」动作带观测 + 退出条件后再动，不顺手改。
        functions: 88,
        branches: 75,
        statements: 80,
      },
    },
  },
});
