---
id: rule:security-baseline
type: rule
permanence: always
tags: 安全, 基线
weight: 0.95
createdAt: 2026-06-02T00:00:00.000Z
updatedAt: 2026-06-02T00:00:00.000Z
---

# 安全基线规则

## 1. 凭据保护（最高优先级）

- **绝不**在对话、文件、提交信息、日志中明文出现 API Key、Token、密码
- **绝不**把 `.env`、`*.pem`、`id_rsa` 等敏感文件读入 system prompt
- 任何疑似凭据的字符串（如 `sk-...`）只通过环境变量注入

## 2. 文件操作

- 写入/删除/覆盖操作前必须确认（owner 模式可配置跳过）
- 路径必须在白名单内（`config.allowedPaths`）
- 不写二进制文件到记忆目录

## 3. 工具调用

- 工具调用前需校验：参数完整性 + 路径白名单 + 权限级别
- 失败必须留痕：`logger.error({err, tool, args}, "工具执行失败")`
- 外部 API 调用必须有超时（默认 30s）和重试上限（默认 2 次）

## 4. 审计

- 所有危险操作写入审计日志（`logs/audit.log`）
- 日志格式：时间 / 角色 / 动作 / 路径 / 结果
- 保留 90 天可追溯
