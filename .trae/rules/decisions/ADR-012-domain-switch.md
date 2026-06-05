---
alwaysApply: false
description: 已废弃——领域切换功能由角色自动匹配替代
---

# ADR-012 · 领域切换（已废弃）

> **状态**：❌ 已废弃 **废弃日期**：2026-06-05
> **替代方案**：[ADR-011 v2](./ADR-011-multi-project.md) 单 Agent 模型 +
> PersonaManager 角色自动匹配

## 废弃原因

1. **DomainManager 已删除**：`src/memory/domain-manager.ts`
   及其测试已在 Agent 设定减法中移除
2. **角色替代领域**：同一领域可有多个角色（如小说领域有作家、编辑、市场策划），角色比领域更灵活
3. **与单 Agent 模型冲突**：领域切换会卸载旧领域记忆，违反"记忆跨项目持久化"原则

## 替代方案

- **角色自动匹配**：PersonaManager 通过话题关键词自动匹配角色（如"写小说"→ 作家角色）
- **手动切换**：`agent.switchPersona(name)` + auto/manual 模式
- **项目级规则**：子项目的 `.memora/rules/` 和 `.memora/skills/`
  自动加载，无需领域概念

## 历史参考

原 ADR-012 v1 内容（已不适用）：

- DomainManager + 领域模板 + `/domain` 命令
- 领域记忆存放于 `.memora/domains/{domain-name}/`
- 切换时卸载旧领域记忆、加载新领域记忆
