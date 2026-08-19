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
      memora: {
        rules: {
          // 封死「编辑纪律债」根因：插入新符号却没搬迁旧 JSDoc，
          // 导致 TS/IDE 只取紧邻的最后一个块，前者文档永失效（历史审查 #4-#7）。
          'no-consecutive-jsdoc': {
            meta: {
              type: 'problem',
              docs: {
                description:
                  '禁止相邻两个 JSDoc 注释块（后者会劫持前者的文档归属，历史审查 #4-#7 根因）',
              },
              schema: [],
              messages: {
                consecutive:
                  '检测到相邻两个 JSDoc 注释块：后块会覆盖前者的文档归属。请将前者 JSDoc 移交给正确符号，或删除空壳注释。',
              },
            },
            create(context) {
              const sourceCode = context.sourceCode;
              return {
                'Program:exit'() {
                  const comments = sourceCode.getAllComments();
                  // 首个代码 token 的位置（getTokens(ast) 不含前导注释；规避 getFirstToken() 底层崩溃）
                  const tokens = sourceCode.getTokens(sourceCode.ast);
                  const firstCodePos = tokens.length > 0 ? tokens[0].range[0] : sourceCode.getText().length;
                  for (let i = 0; i < comments.length - 1; i += 1) {
                    const a = comments[i];
                    const b = comments[i + 1];
                    const isJSDoc = (c) => c.type === 'Block' && c.value.startsWith('*');
                    // 豁免文件前导注释区：license/模块头 JSDoc 紧邻首个符号 JSDoc 是广泛接受的惯例
                    if (a.range[1] <= firstCodePos) continue;
                    if (isJSDoc(a) && isJSDoc(b)) {
                      const between = sourceCode.getText().slice(a.range[1], b.range[0]);
                      if (between.trim() === '') {
                        context.report({ loc: b.loc, messageId: 'consecutive' });
                      }
                    }
                  }
                },
              };
            },
          },
        },
      },
    },
    rules: {
      // TypeScript 严格规则
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      // 防回归：相邻两个 JSDoc 块（后者劫持前者文档）
      'memora/no-consecutive-jsdoc': 'error',
      // 通用规则
      'no-console': 'off', // 宿主 CLI 工具允许 console（hosts/ 已被 ignore，此处兜底）
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always'],
      // B2 防腐（2026-08-19）：内核生产文件行数红线，防再膨胀到 3000 行级。
      // 仅卡增量：存量超标文件（agent.ts/loop.ts，B1 瘦身目标）与测试目录豁免，
      // 不制造 disable 负债区。瘦身达标后可收紧此线。
      'max-lines': ['error', { max: 2000, skipBlankLines: true, skipComments: true }],
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
  // B2 防腐：max-lines 豁免（测试文件允许较长；agent.ts/loop.ts 为 B1 瘦身目标，达标前豁免）
  {
    files: ['src/**/__tests__/**/*.ts'],
    rules: {
      'max-lines': 'off',
    },
  },
  {
    files: ['src/agent/agent.ts', 'src/agent/loop.ts'],
    rules: {
      'max-lines': 'off',
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
