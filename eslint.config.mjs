// ESLint 9 flat config
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    files: ['**/*.ts'],
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
      // TypeScript 严格规则
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      // 通用规则
      'no-console': 'off', // 宿主 CLI 工具允许 console（hosts/ 已被 ignore，此处兜底）
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  // HC-12：内核纯逻辑库 src/ 禁止直接使用 console（应走 logger）
  // 覆盖上面的 'off'，强制 src/ 生产代码通过 logging/logger.ts 统一日志
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-console': 'error',
    },
  },
  // 例外：logging/ 是 logger 底层实现（console fallback）；__tests__/ 测试 mock console 合理
  {
    files: ['src/logging/**/*.ts', 'src/**/__tests__/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'public/**',
      '*.config.js',
      '*.config.ts',
      // 宿主项目：各自拥有独立的构建与 lint 配置，根项目不扫描
      'hosts/**',
    ],
  },
];
