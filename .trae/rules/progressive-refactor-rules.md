---
alwaysApply: false
description: 渐进式重构规范——覆盖"领域容器提取"与"职责拆分"两类模式，指导上帝类/上帝对象的安全拆分
version: v1.0
date: 2026-07-28
---

# 渐进式重构规范

> 来源：HEAL-10（appState 领域拆分三步）+ HEAL-11（UIManager 上帝类重构第一步）方法论提炼。
> 目标：为"字段数超阈值"或"职责数超阈值"的上帝类/上帝对象提供安全、可验证、可回溯的拆分规范。

## 1. 触发判定（何时启动）

**硬阈值触发**（任一满足即应启动评估）：

| 维度 | 阈值 | 典型信号 |
|------|------|---------|
| 字段数 | 单类/单对象 ≥ 15 字段 | 修改时需翻大量无关字段；构造函数 ≥ 100 行 |
| 职责数 | 单类 ≥ 5 职责 | 类名与实际承担职责不符；测试需 mock 大量不相关依赖 |
| 修改成本 | 单次改动需触碰 ≥ 10 处无关代码 | 每次新功能都要绕过一堆无关字段 |

**软阈值观察**（不强制启动，标记监控）：

- 文件长度 > 1000 行但功能内聚（门面必然产物）→ 保留监控，不强制拆分
- 字段数 8-14 但职责清晰 → 等待自然生长触发

**禁止**：

- ❌ 阈值未达即启动拆分（过度工程）
- ❌ 阈值已达但理由是"看着乱"（需有具体修改成本证据）

## 2. 两种重构模式

### 2.1 模式 A：领域容器提取

**适用场景**：字段数超阈值，但字段可按功能域分组，组内字段内聚。

**特征**：
- 字段保留在原对象（容器化，不迁移业务逻辑）
- 提取的是"状态容器"类，仅持有字段 + cleanup/nullify
- 业务逻辑仍保留在原文件（main.ts / UIManager + mixin）

**典型示例**：appState 23 字段 → AgentRuntime(9) + WindowService(4) + QuickInputService(2) + 应用级字段(8)

### 2.2 模式 B：职责拆分

**适用场景**：职责数超阈值，职责之间正交（不共享状态/不互相调用）。

**特征**：
- 将单个大类拆为多个独立 Controller
- 每个Controller 持有自己的状态和逻辑
- 原 Host 接口契约可能需调整（需评估调用方影响面）

**典型示例**：PanelRouter（6 职责）→ PanelRouter + WindowControlsController + AuxSidebarManager + GlobalShortcutDispatcher

### 2.3 模式选择标准

```
字段内聚度高（共享数据源/外部依赖重合） → 模式 A（容器提取）
职责正交（不共享状态/调用路径独立）      → 模式 B（职责拆分）
两者兼有                                 → 先 A 后 B（先容器化降字段数，再按职责拆容器）
```

## 3. 方案设计先行

**强制流程**：先写方案文档，再改代码。方案文档路径 `docs/方案-{任务ID}-{简述}-{YYYYMMDD}.md`。

### 3.1 方案文档必备章节

```markdown
# {任务ID} {简述} 方案

## 一、现状分析
- 演进路径（从当前状态到目标状态）
- 调研结论（是否真的需要拆分）
- 本轮提取范围（表格列出字段/职责 + 类型 + 职责）
- 不提取的归档（表格列出 + 理由）

## 二、目标类设计
- 类定义代码块（含字段注释 + cleanup/nullify 方法）
- 与现有模式的对比表（如适用）

## 三、改动文件清单
- 表格：文件 | 变更类型 | 改动点

## 四、不提取的归档
- 每项附归档理由（未达阈值/跨域/契约稳定性等）

## 五、后续演进路径
- 阶段拆分图（本轮 → 阶段 2 → ... → 终态）

## 六、验证计划
- 类型检查 / 全量测试 / 集成模式验证点

## 七、实施完成（提交后补写）
- 验证结果（实际数据）
- 实际修改文件清单
- 额外修复（如发现遗留问题）
- 后续演进
```

### 3.2 方案设计原则

- **领域驱动分组**：按功能域分组，不按字段数机械拆分
- **内聚度判定**：优先提取共享数据源、外部依赖少、职责封闭的字段组
- **依赖注入分析**：若字段构造依赖 Host 反向注入（如 `this as Host`），初始化仍保留在原构造函数

## 4. 纯状态容器原则（模式 A 专用）

**核心约束**：提取的类只持有字段，不持有业务逻辑。

| 维度 | 容器类（提取后） | 原对象（main.ts / UIManager） |
|------|----------------|------------------------------|
| 字段 | 容器内字段 | 替换为 `container.field` 路径访问 |
| 业务逻辑 | ❌ 不持有 | ✅ 保留 |
| 初始化 | `!:` definite assignment，原构造函数赋值 | 原构造函数调整路径 |
| 清理 | `cleanup()`（UI 组件）/ `nullify()`（主进程状态） | 原对象集中调用 |
| 依赖注入 | 无（纯字段容器） | 反向注入（如 `this as Host`）仍可行 |

**字段语法**：统一使用 `!:` definite assignment（`null! as Type` 不被 vite:oxc 支持）。

**禁止**：

- ❌ 在容器类中添加业务方法（应保留在原对象或 mixin）
- ❌ 在容器类中持有其他容器的引用（跨 Service 通过外部访问）
- ❌ 提取时夹带"顺便优化"（违反单一改动原则）

## 5. 渐进式提取原则

### 5.1 单轮一个领域

- 每轮只提取一个功能域，验证集成模式
- 第一轮是"模式验证轮"，需特别谨慎
- 后续轮次按"自然生长"触发（涉足该域时顺势提取）

### 5.2 不提取的归档（3 次阈值）

**判定流程**：

```
该逻辑/字段是否被 ≥ 3 处调用？
├─ 是 → 可提取/可下沉
└─ 否 → 归档，等达到阈值再提取
```

**例外**：跨 Service 依赖、契约稳定性、时序问题可不提取（需在方案文档说明理由）。

### 5.3 跨 Service 依赖处理

- 通过 `appState.serviceA.field` 路径访问（跨 Service 外部依赖）
- 用 `if` 守卫延迟读取避免时序问题（如 `if (appState.serviceA?.field)`）
- 不通过构造函数注入（避免 Service 间循环依赖）

## 6. 接口兼容性处理

### 6.1 契约接口同步

- 公共接口（如 MinimalIpcState / IpcContext）需同步更新字段路径
- 调用方通过 `state.container.field` 访问（替代原 `state.field`）
- 评估 Host 接口契约稳定性（模式 B 涉及契约变更时影响面更大）

### 6.2 sugar API 保留（模式 B 专用）

- 原 Host 接口方法名保留作为 sugar API
- 内部委托到新的 Controller
- 调用方零改动（嫁接而非并列，详见 §2.2 架构哲学）

## 7. 测试同步策略

### 7.1 断言路径调整

- `mock.field.method` → `mock.container.field.method`
- 全量扫描测试文件中的旧路径，确保无遗漏

### 7.2 mock 机制升级

- 若引入容器层级（`mock.container.field`），原 Proxy 需支持深度嵌套
- 推荐：递归 Proxy 实现，每层既是 `vi.fn()`（可调用）又是 Proxy（属性访问返回同类 Proxy）

```typescript
// 深度嵌套 mock 实现示例
function createDeepMock(): ReturnType<typeof vi.fn> & Record<string, any> {
  const fn = vi.fn();
  const cache = new Map<string, any>();
  return new Proxy(fn, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || ['then', 'catch', 'finally'].includes(prop as string)) {
        return Reflect.get(target, prop, receiver);
      }
      if (MOCK_API_PROPS.has(prop)) return Reflect.get(target, prop, receiver);
      if (!cache.has(prop)) cache.set(prop, createDeepMock());
      return cache.get(prop);
    },
  }) as any;
}
```

### 7.3 验证必要条件

- 类型检查 0 错误（`tsc --noEmit`）
- 全量测试通过（不新增失败用例）
- lefthook pre-commit + commit-msg 守门通过

## 8. 炼化归元收尾

**强制流程**：代码修改完成后，必须完成以下收尾步骤才能提交。

### 8.1 文档同步

| 文档 | 操作 |
|------|------|
| 方案文档 | 补写"七、实施完成"章节（验证结果 + 实际修改文件清单 + 额外修复 + 后续演进） |
| `tasks/待完成任务.md` | 移除本轮任务条目；更新"最后评估"行 |
| `tasks/已完成任务.md` | 添加本轮任务完整记录（修复内容 + 设计原则 + 修改文件清单 + 验证结果 + 后续演进） |

### 8.2 剪枝去痕

- 删除变更痕迹注释（如 `// HEAL-10C 遗留`、`// 原路径：xxx`）
- 评估未提取逻辑是否仍需保留（避免"为了未来"的死代码）
- 不做"顺便优化"（违反单一改动原则）

### 8.3 git 提交

**提交信息格式**（遵循 commitlint）：

```
{type}({scope}): {任务ID} — {简述}

- {改动点 1}
- {改动点 2}
...

验证：{typecheck 结果}，{测试结果}

Refs: {任务来源说明}
```

- `type`：refactor（重构）/ fix（修复）/ feat（新增功能）
- `scope`：sprite / kernel / docs 等
- 单行 ≤ 100 字符，body 每行 ≤ 100 字符
- 多行 body 用多个 `-m` 参数传递（PowerShell here-string 在长参数下易失效）

## 9. 禁止事项汇总

- ❌ 跳过方案设计直接改代码
- ❌ 单轮提取多个领域（违反渐进式原则）
- ❌ 提取未达 3 次阈值的逻辑（过度抽象）
- ❌ 在容器类中夹带业务逻辑（违反纯状态容器原则）
- ❌ 提取时顺便优化无关代码（违反单一改动原则）
- ❌ 修改后跳过全量测试验证
- ❌ 跳过炼化归元收尾直接提交
- ❌ 使用 `null! as Type` 字段语法（不被 vite:oxc 支持）
- ❌ 在跨 Service 依赖中使用构造函数注入（导致循环依赖）

## 10. 案例索引

> 以下案例已应用本规范，可作为参考。

| 任务 ID | 模式 | 提取内容 | 案例文档 |
|---------|------|---------|---------|
| HEAL-10 | A（容器提取） | AgentRuntime（9 字段） | [方案-HEAL-10-appState领域拆分-20260727.md](../../docs/方案-HEAL-10-appState领域拆分-20260727.md) |
| HEAL-10B | A（容器提取） | WindowService（4 字段） | [方案-HEAL-10B-WindowService提取-20260727.md](../../docs/方案-HEAL-10B-WindowService提取-20260727.md) |
| HEAL-10C | A（容器提取） | QuickInputService（2 字段） | [方案-HEAL-10C-QuickInputService提取-20260728.md](../../docs/方案-HEAL-10C-QuickInputService提取-20260728.md) |
| HEAL-11 | A（容器提取） | PerceptionCoordinator（3 字段） | [方案-HEAL-11-PerceptionCoordinator提取-20260728.md](../../docs/方案-HEAL-11-PerceptionCoordinator提取-20260728.md) |
| HEAL-12 | B（职责拆分） | PanelRouter → 4 Controller | [方案-HEAL-12-PanelRouter职责拆分-20260728.md](../../docs/方案-HEAL-12-PanelRouter职责拆分-20260728.md) |
| HEAL-15 | 命名一致性重构 | renderer 侧 Controller → Orchestrator | [方案-HEAL-15-renderer侧Controller重命名Orchestrator-20260728.md](../../docs/方案-HEAL-15-renderer侧Controller重命名Orchestrator-20260728.md) |
