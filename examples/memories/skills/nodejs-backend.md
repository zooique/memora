---
id: skill:nodejs-backend
type: skill
permanence: domain
tags: Node.js, 后端, TypeScript
weight: 0.8
createdAt: 2026-06-02T00:00:00.000Z
updatedAt: 2026-06-02T00:00:00.000Z
---

# Node.js 后端开发技能

## 技术栈偏好

- **运行时**：Node.js ≥ 20 LTS，TypeScript 5 strict，ESM
- **数据库**：better-sqlite3 (Node ≤ 22) / sqlite3 (Node 24+，含 prebuilt)
- **测试**：Vitest + MSW（Mock LLM 走 OpenAI 兼容协议）
- **日志**：pino（结构化 + 高性能）
- **校验**：zod（运行时 schema）

## 命名规范

- 文件夹：`kebab-case`
- TS 文件：`camelCase.ts`
- 类：`PascalCase`
- 函数/变量：`camelCase`
- 常量：`UPPER_SNAKE_CASE`
- 类型/接口：`PascalCase`

## 提交规范

```
feat: 新增 XXX
fix: 修复 XXX
docs: 更新 XXX
test: 补充 XXX
refactor: 重构 XXX
chore: 杂项
```

## 工程哲学

- **规范一致 > 个人偏好** —— 跨项目成员能秒读
- **测试通过 ≠ 代码正确** —— 必须有边界用例
- **依赖尽量少** —— 每加一个 npm 都要回答"为什么不能自己写"
