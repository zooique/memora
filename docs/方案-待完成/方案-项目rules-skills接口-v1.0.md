# 方案：项目 Rules/Skills 接口 — addRule() API

> 来源：问诊（项目 rules/skills 如何接入 agent 记忆管线）日期：2026-06-04 版本：v1.0 核心矛盾：文件接口已存在 ←→ 缺少程序化注入 API

## 1. 现状分析

### 1.1 已存在的文件接口

宿主项目通过 `configDir` 参数接入：

```
AgentOptions.configDir = './agent-config'
  ├── agent-config/rules/      → MemoryLoader 启动扫描 → SQLite（type: rule）
  ├── agent-config/skills/     → SkillManager 两层扫描 → 不进 SQLite
  └── agent-config/personas/ → PersonaManager 扫描 → SQLite（type: personality）
```

`~/.memora/global/rules/` 和 `~/.memora/global/skills/`
提供 Agent 级跨项目配置。

### 1.2 缺失的程序化接口

| 已有 API               | 类型 | 缺失 API          |
| ---------------------- | ---- | ----------------- |
| `agent.registerTool()` | 工具 | —                 |
| —                      | 规则 | `agent.addRule()` |
| —（文件扫描已够）      | 技能 | 不需要            |

## 2. 设计：addRule()

### 2.1 签名

```typescript
addRule(memory: Memory): Promise<void>
```

### 2.2 行为

1. 校验 `memory.type === 'rule'`
2. 校验 `memory.permanence` ∈
   `{ 'always', 'domain' }`（rules 不应是 topic/on-demand）
3. 写入 SQLite：`memoryIndex.upsert(memory)`
4. 如果 AgentLoop 已启动 → 追加到 bootstrapMemories
5. 写入文件：`fileStore.write(memory)`（保持冷热一致）

### 2.3 与 registerTool() 的对称性

| 维度     | registerTool()               | addRule()               |
| -------- | ---------------------------- | ----------------------- |
| 作用域   | ToolExecutor.customTools Map | MemoryIndex（SQLite）   |
| 持久化   | 否（内存）                   | 是（SQLite + 文件）     |
| 可见性   | LLM tool_call                | bootstrap system prompt |
| 重复注册 | 抛错                         | idempotent（upsert）    |

## 3. 不做的事

| 方向           | 原因                                               |
| -------------- | -------------------------------------------------- |
| `addSkill()`   | 技能不进 SQLite，是"怎么做"的配置。文件扫描已完备  |
| `addPersona()` | `PersonaManager.load()` + `switchPersona()` 已覆盖 |
| 删除文件接口   | 文件接口是"万物皆记忆"的基础——记忆本体在文件中     |

## 4. 实施任务

| ID    | 任务                                          | 改动量 | 涉及文件      |
| ----- | --------------------------------------------- | ------ | ------------- |
| Q-701 | Agent.addRule() 公共方法                      | ~25 行 | agent.ts      |
| Q-702 | 测试：addRule 写入 + bootstrap 刷新 + 校验    | ~30 行 | agent.test.ts |
| Q-703 | src/index.ts：无新增导出（Memory 类型已导出） | 0 行   | —             |

总计：~55 行，2 个文件，1 个新方法。
