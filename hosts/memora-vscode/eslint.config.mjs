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
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'src/**/__tests__/**',
    ],
  },
];
