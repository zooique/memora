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
  // 存量超标豁免清单（HOST-SPLIT-1，逐个瘦身达标后**逐条删除本块对应行**）。
  // 集中式豁免 ≠ 文件内 disable：清单在配置里可见、可审计、可收敛；
  // ❌ 严禁在超标文件内写 `/* eslint-disable max-lines */`——那会把债务埋进文件、
  //    永久不可见且无人回收（内核侧 agent.ts/loop.ts 走的就是集中豁免，形态对齐）。
  // 性质标注：TARGET = 拆分目标｜DOC = 注释型（有效行远低于物理行，非拆分目标）｜DATA = 纯数据
  {
    files: [
      'src/webview/scripts/chatView.ts', // TARGET 7789 行（单闭包，178 个内层函数）
      'src/webview/panels/chatPanel.ts', // TARGET 4962 行（类体 4211 行 / 38 字段 / 126 方法）
      'src/webview/styles/chatStyles.ts', // DATA   2563 行（第 15→2563 行仅一个模板字符串）
      'src/webview/panels/settingsPanel.ts', // TARGET 2089 行（一 class 扛 5 个 tab）
      'src/shared/protocol.ts', // DOC    1703 行（有效行仅 461，71% 是契约注释）
      'src/extension/host/fileChangeView.ts', // TARGET 1322 行
      'src/webview/scripts/rolesView.ts', // 观察   1149 行（变异验证已实测：摘本行即报 1149>1000，EXIT=1）
    ],
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
