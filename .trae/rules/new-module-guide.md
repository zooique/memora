---
alwaysApply: false
description: 新增模块的标准流程（防止随意加模块破坏架构）
version: v0.2
date: 2026-07-13
---

# 新增模块指南

## 何时新增模块

✅ **应该新增**：

- 新增一类业务能力（如：日历、邮件、代码分析）
- 跨多个现有模块的协调逻辑
- 独立的第三方 SDK 适配

❌ **不应该新增**：

- 一个函数（放 `utils/`）
- 一个新工具（放 `agent/tools/` 而非新建模块）
- 临时调试代码（用完即删）

## 新增流程

### 1. 决策检查清单

在新建 `src/<new-module>/` 前，回答：

- [ ] 这个模块的核心矛盾是什么？
- [ ] 它与哪些现有模块交互？
- [ ] 它是否需要新的外部依赖？
- [ ] 它是否需要新的 ADR？
- [ ] 是否已回答 [ADR-017](./decisions/ADR-017-natural-growth-redefinition.md) 架构层 4 问（详见 [backend_layers_rules.md §判断标准](./backend_layers_rules.md)）？

如果以上任何一项不明确——**暂停，回去问用户**。

### 2. 目录结构

```
src/<new-module>/
├── index.ts            # 导出公共 API
├── types.ts            # 类型定义
├── <core>.ts           # 核心实现
└── <helpers>.ts        # 辅助函数
```

### 3. 必须的产物

- [ ] 模块入口 `index.ts`（导出公共 API，不导出内部）
- [ ] 单元测试 ≥ 80% 覆盖率
- [ ] 至少 1 个集成测试
- [ ] 在 [project-rules.md §3 目录结构](./project-rules.md) 中添加
- [ ] 在 [backend_layers_rules.md](./backend_layers_rules.md) 的职责表中添加
- [ ] 如引入新数据结构，评估是否需要 ADR（如 ADR-014 记忆关系图谱）

### 4. ADR 触发条件

以下情况**必须**写 ADR：

- 引入新的 npm 依赖（特别是大型依赖）
- 引入新的外部服务/API
- 改变现有的数据流方向
- 改变永久性分级的语义

### 5. 评审清单

提交前自检：

- [ ] 依赖方向正确（不反向依赖）
- [ ] 没有硬编码的业务领域（保持领域无关）
- [ ] 没有安全绕过（写操作经 security/ 校验）
- [ ] 没有文档偏离（设计文档与代码一致）
- [ ] 没有遗漏测试
- [ ] 没有未记录的 ADR

### 6. 新增面板的 CSS 检查项（精灵宿主）

> **来源**：[ADR-018 · CSS 作用域规范](./decisions/ADR-018-css-scoping-convention.md)

新增 `#panel-<name>` 面板时，必须完成以下 CSS 检查：

- [ ] **CSS 文件命名**：创建 `<name>.css`（如 `perception.css`），不得复用现有 CSS 文件
- [ ] **类名前缀**：所有面板专属类加 `<name>-` 前缀（如 `.perception-affect-grid`），禁止 BARE 类
- [ ] **单一真理源**：面板专属样式集中在 `<name>.css`，其他 CSS 文件不得定义同类名
- [ ] **加载顺序**：在 [index.html](../../hosts/memora-sprite/src/electron/renderer/index.html) 的 `<link>` 列表末尾追加 `<name>.css`（L2 面板层最后加载）
- [ ] **无跨面板依赖**：`<name>.css` 不得覆盖其他面板的样式（如不得定义其他面板的专属类）
- [ ] **PanelManager 对齐**：CSS 前缀与 JS Manager 类名前缀对齐（如 `perception-` 对应 `PerceptionPanelManager`）
- [ ] BEM 风格：类名采用 `.block-name-element-name--modifier-name` 连字符风格，状态类用 `.is-` 前缀

### 7. 新增 Agent Manager 检查清单

> **来源**：AUDIT-0713-5 评估（2026-07-14）——不引入 ComponentRegistry，改为固化检查清单防止遗漏

新增 `src/agent/managers/` 下专职 Manager 时，按以下 9 处修改点检查（跨 [agent.ts](../../src/agent/agent.ts) 和 [assembler.ts](../../src/agent/assembler.ts) 2 文件）：

| # | 文件 | 修改点 | 示例 |
|---|------|--------|------|
| 1 | `agent.ts` | import 语句 | `import type { XxxManager } from '@/agent/managers/xxxManager.js';` |
| 2 | `agent.ts` | 字段声明（null 初始） | `private xxxManager: XxxManager \| null = null;` |
| 3 | `assembler.ts` | import 语句 | `import { XxxManager } from '@/agent/managers/xxxManager.js';` |
| 4 | `assembler.ts` | `AssembleOutput` 接口字段 | `xxxManager: XxxManager;` |
| 5 | `assembler.ts` | `assembleComponents()` 创建逻辑（按 4 阶段依赖顺序） | `const xxxManager = new XxxManager(...);` |
| 6 | `assembler.ts` | return 对象字段 | `return { ..., xxxManager };` |
| 7 | `agent.ts` | `assembleComponents()` 调用后赋值 | `this.xxxManager = result.xxxManager;` |
| 8 | `agent.ts` | 只读 getter | `get xxx(): XxxManager \| null { return this.xxxManager; }` |
| 9 | `agent.ts` | `nullifyAllComponents()` 追加一行 | `this.xxxManager = null;` |

**带副作用的清理**（dispose/stop/close/shutdown）不进 `nullifyAllComponents()`，由 `close()` 显式调用（顺序敏感不可合并）。

**为何不引入 ComponentRegistry**：类型安全性是门面类核心价值（ADR-010），`#private` 字段无法纳入，生命周期异构需适配层，assembler 已解决装配痛点。详见 [已完成任务.md AUDIT-0713-5 评估记录](../../tasks/已完成任务.md)。
