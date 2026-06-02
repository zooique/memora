/**
 * commitlint 配置
 * 提交信息规范：<type>(<scope>): <subject>
 * 详见 .trae/rules/project-rules.md §5
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',     // 新功能
        'fix',      // 修复
        'docs',     // 文档
        'style',    // 格式（不影响代码运行的变动）
        'refactor', // 重构（即不是新增功能，也不是修改 bug）
        'test',     // 测试
        'chore',    // 构建过程或辅助工具的变动
        'perf',     // 性能优化
        'ci',       // CI 配置
        'revert',   // 回滚
        'wip',      // 进行中的工作
      ],
    ],
    'type-case': [0, 'never'],     // type 大小写不强制
    'subject-empty': [2, 'never'], // subject 不能为空
    'subject-full-stop': [0, 'never'], // subject 末尾不强制句号
    'subject-case': [0, 'never'],  // subject 允许中文（项目规范要求中文）
    'header-max-length': [1, 'always', 100], // 限制 header 长度
  },
};
