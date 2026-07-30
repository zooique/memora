---
alwaysApply: false
description: "UIManager Mixin 拆分模式：applyMixins + uiDelegations/ 委托群，用于带状态实例方法的横向拆分"
---

# ADR-SP-016 · UIManager Mixin 拆分模式

> **状态**：✅ 已接受（2026-07-12，迭代 5 ui.ts 拆分沉淀）
> **依赖**：[ADR-SP-015](./ADR-SP-015-panel-manager-composition.md)（PanelManager 组合模式）、[ADR-017](./ADR-017-natural-growth-redefinition.md)（自然生长分层原则）

## 背景

迭代 5 前 ui.ts 达 1751 行（全仓库最厚），超目标 75%。[ADR-SP-015](./ADR-SP-015-panel-manager-composition.md) 的 PanelManager 组合模式适用于"单一职责边界清晰、可独立成类"的逻辑提取（如 ClipboardManager、DateNavManager），但 ui.ts 中大量方法是**带状态实例方法**——它们访问 UIManager 的私有字段、调用其他实例方法、与 UI 状态紧耦合。强行提取为独立 Manager 类会：

1. 需要将大量私有字段公开或通过接口暴露，破坏封装
2. 委托成本高（每个方法调用需经过 UIManager → Manager → UIManager 回调）
3. Manager 间共享状态需额外传递，增加复杂度

经模块重思评估（迭代 5），推荐 **Mixin 模式**：UIManager 保持单一类，但方法按业务域分散到 `uiDelegations/` 委托群，通过 `applyMixins()` 在运行时注入。

## 决策

**UIManager 的带状态实例方法采用 Mixin 模式拆分：方法按业务域分散到 `helpers/uiDelegations/` 委托群，通过 `applyMixins()` 运行时注入到 UIManager 原型。**

### 1. Mixin 模式 vs PanelManager 组合模式

| 维度 | PanelManager 组合模式（ADR-SP-015） | Mixin 模式（本 ADR） |
|------|--------------------------------------|----------------------|
| **关系** | has-a（UIManager 持有 Manager 实例） | is-a（方法注入到 UIManager 原型） |
| **适用方法** | 单一职责、可独立成类、少量状态 | 带状态实例方法、跨域协作、紧耦合 UIManager |
| **状态管理** | Manager 自管理私有状态 | 共享 UIManager 实例状态（this 指向 UIManager） |
| **依赖注入** | 构造函数注入 Host 接口 / leaf 组件 | 无需注入，直接访问 this 字段 |
| **测试** | 可独立单测（Mock 注入） | 需通过 UIManager 实例间接测试 |
| **委托成本** | 每个方法需 UIManager 透传委托 | 无委托，方法直接在 UIManager 上 |

**选择原则**：能用 PanelManager 组合模式就用组合模式（封装性好、可独立测试）；只有当方法高度依赖 UIManager 私有状态、提取为独立类成本过高时，才用 Mixin 模式。

### 2. uiDelegations/ 委托群组织规范

委托群按**业务域**聚合，不按功能类型分组：

| 委托群文件 | 业务域 | 典型方法 |
|-----------|--------|----------|
| `chatDelegations.ts` | 对话面板 | 消息发送/流式渲染/中断 |
| `dashboardDelegations.ts` | 仪表盘面板 | 概览/运行指标/记忆源健康 |
| `memoryDelegations.ts` | 记忆面板 | 列表/详情/视图切换/关系图谱 |
| `miscDelegations.ts` | 杂项 | 窗口控制/面板路由/全局快捷键 |
| `personaThemeDelegations.ts` | 角色主题 | 角色切换/主题应用 |
| `settingsModalDelegations.ts` | 设置模态框 | Provider/快捷键/隐私设置 |

**拆分原则**：

- 每个委托群聚焦一个业务域，域内方法高内聚
- 委托群间低耦合，避免交叉引用
- 单个委托群不超过 ~300 行（超出时考虑子拆分或回流 PanelManager 模式）

### 3. applyMixins() 实现约定

```typescript
// helpers/applyMixins.ts
import type { UIManager } from '../ui.js';
import { chatDelegations } from './uiDelegations/chatDelegations.js';
// ... 其他委托群

const delegations = [
  chatDelegations,
  dashboardDelegations,
  memoryDelegations,
  miscDelegations,
  personaThemeDelegations,
  settingsModalDelegations,
];

export function applyMixins(target: any): void {
  for (const delegation of delegations) {
    Object.assign(target, delegation);
  }
}
```

**调用时机**：UIManager 构造函数末尾调用 `applyMixins(this)`，在持有所有 PanelManager 实例之后。

**约束**：

- 委托群中的方法通过 `this` 访问 UIManager 实例（TypeScript 需声明 `this: UIManager`）
- 委托群是纯对象（`const xxxDelegations = { methodA() {...}, methodB() {...} }`），不是类
- 方法名不得与 UIManager 原有方法冲突（`applyMixins` 会覆盖同名方法）

### 4. 何时重新评估

| 触发条件 | 评估方向 |
|----------|----------|
| 单个委托群超过 ~300 行 | 考虑子拆分或回流为 PanelManager 组合模式 |
| 委托群间出现交叉引用 | 重新划分业务域边界 |
| UIManager 超过 ~1200 行 | 评估是否有方法可回流为 PanelManager 组合模式 |
| 测试覆盖率低于 50% | 优先补测委托群（通过 UIManager 间接覆盖） |

## 替代方案

| 方案 | 放弃原因 |
|------|---------|
| 强行用 PanelManager 组合模式拆分所有方法 | 私有字段暴露 + 委托成本高 + Manager 间状态传递复杂 |
| 用 React/Vue 组件框架替代 | 与 Electron 原生渲染进程架构不匹配，引入重依赖 |
| 保持 ui.ts 单体不拆分 | 1751 行已严重影响可读性和可维护性 |
| 用继承拆分（UIManager extends ChatUI extends BaseUI） | 继承层次僵化，方法定位困难 |

## 影响

- **ui.ts 拆分**：1751→904 行，方法分散到 6 个委托群文件
- **测试策略**：委托群需通过 UIManager 实例间接测试（覆盖率目标 50%+）
- **新增方法归属**：带状态实例方法 → uiDelegations/；独立职责逻辑 → PanelManager 组合模式
- **目录归属**：委托群必须放在 `helpers/uiDelegations/`，applyMixins 放在 `helpers/`

## 年轮修订

### v0.1（2026-07-12）· 迭代 5 ui.ts 拆分沉淀

**初始版本**：基于 ui.ts 1751→904 行拆分的实践经验提炼。

**沉淀依据**：
- 迭代 5：applyMixins + 6 委托群提取（chat/dashboard/memory/misc/personaTheme/settingsModal）
- 对比 ADR-SP-015 PanelManager 组合模式，明确两种模式的适用边界
- 迭代 6 的 3 Panel 拆分（settings/memory/chat helper 提取）验证了两种模式的并存价值
