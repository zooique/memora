// VSCode 宿主独立 ESLint 配置
// 根 eslint.config.mjs 排除了 hosts/**，宿主需自建质量门
// 目标：捕获死导入、未使用变量、类型不安全等常见问题
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'prefer-const': 'warn',
      eqeqeq: ['warn', 'always'],
      // 防腐：宿主文件体量红线（HOST-SPLIT-1 第 0 步）。
      // 阈值 1000 **不是本仓新造的数**——同源自 .trae/rules/generic/progressive-refactor-rules.md §1
      // 「软观察阈值 = 文件 > 1000 行」，此处只是把该软阈值机械化成闸门。
      // 口径 = 物理行（**不加** skipBlankLines / skipComments）：与规则同口径，
      // 避免「有效行 / 物理行」两套数并存造成第二判据。
      'max-lines': ['error', { max: 1000 }],
    },
  },
  // 存量超标清单（HOST-SPLIT-1 第 0 步 · 2026-10-21 闭环为「只降不升」闸）。
  // 集中式配置 ≠ 文件内 disable：清单在配置里可见、可审计、可收敛；
  // ❌ 严禁在超标文件内写 `/* eslint-disable max-lines */`——那会把债务埋进文件、
  //    永久不可见且无人回收（内核侧 agent.ts/loop.ts 走的就是集中豁免，形态对齐）。
  //
  // 两类分野（勿一刀切）：
  // - TARGET/观察 → **按文件具体 max = 基线**：行数只降不升，涨回即 lint 红。
  //   瘦身达标（≤1000）后把该条删掉，回到上一块通用 1000 闸；中途减完一段也可**调低 max**。
  // - DOC/DATA → 维持 off：物理行**不是**这两个文件的债务判据（protocol.ts 71% 是契约注释、
  //   chatStyles.ts 主体是一个模板字符串），给它们套下降闸会逼「削契约注释」凑数 = 造伤。
  //   标注为 DOC/DATA 而非 TARGET，即防误拆。
  //
  // 数字三件套（描述性计数纪律）：
  // - **取数口径 = 本闸门自报**：把该条 max 临时改成 1 跑 `npm run lint`，报错消息
  //   「File has N lines」即该文件基线（与闸门判定同源，杜绝手数/ wc 第二口径）。
  // - 时点：2026-10-21 实测。
  // - 重算指引：瘦身提交后按上法刷新该条 max 调低；**禁止只更新数字不改行数**（无判据作用的
  //   描述性行数已从注释清除，此处仅留闸门阈值）。
  {
    files: ['src/webview/scripts/chatView.ts'], // TARGET（单闭包，178 个内层函数）
    rules: { 'max-lines': ['error', { max: 7789 }] },
  },
  {
    files: ['src/webview/panels/chatPanel.ts'], // TARGET（类体 / 多字段 / 多方法）
    rules: { 'max-lines': ['error', { max: 4546 }] },
  },
  {
    files: ['src/webview/panels/settingsPanel.ts'], // TARGET（一 class 扛 5 个 tab）
    rules: { 'max-lines': ['error', { max: 2089 }] },
  },
  {
    files: ['src/extension/host/fileChangeView.ts'], // TARGET
    rules: { 'max-lines': ['error', { max: 1322 }] },
  },
  {
    files: ['src/webview/scripts/rolesView.ts'], // 观察（超 1000，先冻结基线）
    rules: { 'max-lines': ['error', { max: 1149 }] },
  },
  {
    files: ['src/shared/protocol.ts'], // DOC（契约注释型，物理行非判据 → off）
    rules: { 'max-lines': 'off' },
  },
  {
    files: ['src/webview/styles/chatStyles.ts'], // DATA（纯数据模板字符串 → off）
    rules: { 'max-lines': 'off' },
  },
  // 宿主根的构建脚本与配置也在门内——
  // 上一块只匹配 `src/**/*.ts`，而 `esbuild.config.mjs` 恰恰是产出「用户实际运行的
  // dist/extension/extension.js」的那支脚本。门禁边界画在「源码可测性」而非「运行物」，
  // 与内核的 scripts/*.mjs 缺口同根，故同批补齐。
  {
    files: ['*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'prefer-const': 'warn',
      eqeqeq: ['warn', 'always'],
    },
  },
  // 宿主根的 TS 配置（vitest.config.ts）——同理，同样在门内
  {
    files: ['*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      'prefer-const': 'warn',
      eqeqeq: ['warn', 'always'],
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'src/**/__tests__/**'],
  },
];
