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
      'eqeqeq': ['warn', 'always'],
    },
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
    ignores: [
      'dist/**',
      'node_modules/**',
      'src/**/__tests__/**',
    ],
  },
];
