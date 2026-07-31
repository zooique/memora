---
alwaysApply: false
description: "错误处理策略统一：按层 + 按边界分类（内核降级 / IPC 契约 / 主进程 throw / 渲染进程 reportError），不追求全局单一策略"
---

# ADR-020 · 错误处理策略统一：按层 + 按边界分类

> **状态**：✅ 已接受
> **日期**：2026-07-31
> **来源**：AUDIT-ARCH-2 任务推进（错误处理策略不统一，部分 throw / 部分 return error / 部分 log+降级）
> **依赖**：[ADR-006](./ADR-006-security-model.md)（安全模型）、[coding-convention-rules §2](../rules/coding-convention-rules.md)（异常处理）、[architecture_philosophy_rules §7](../rules/architecture_philosophy_rules.md)（降级优先）

## 背景

### 现状数据（2026-07-31 实测）

宿主层（hosts/memora-sprite/src）错误处理策略分散：

| 维度 | 次数 | 文件数 | 分布 |
|------|------|--------|------|
| `throw new XxxError()` | 34 | 18 | 主进程 IPC handler + sprite 层 |
| `{success: false}` IPC 模式 | 168 | 30 | IPC handler + web routes |
| `reportError()` 统一日志 | 177 | 39 | 渲染进程（已统一） |
| `catch` 块总量 | 255 | 79 | 全宿主层 |
| `return null/undefined` 降级 | 43 | 16 | 宿主 electron 层 |
| IPC handler 中 `toError()` | 21 | 4 | 仅 4/10 个 IPC handler 文件使用 |
| `createIpcErrorHandler` | — | 3 | 仅 memory/settings/persona orchestrator |

内核层（src/）：`throw` 仅 3 次（projectRegistry.ts），`return null/undefined` 36 次——内核以降级为主。

### 核心矛盾

| # | 矛盾 | 冲突点 |
|---|------|--------|
| 1 | 内核 vs 宿主策略不一致 | 内核 return null 降级（库哲学，不中断调用方）；宿主 throw（应用哲学，显式失败）。调用方忘记检查 null → 错误被静默吞掉 |
| 2 | IPC handler 内部格式不统一 | 168 次 `{success:false}` 中仅 21 次用 toError() 包装，其余 147 次直接 `error.message`——当 error 不是 Error 实例时 message 为 undefined |
| 3 | throw vs return error 同层并存 | 同一 IPC handler 内既有 throw（被 catch 后转 `{success:false}`），又有直接 `return {success:false}`——调用方需同时处理两种失败路径 |
| 4 | 降级 vs 显式失败哲学冲突 | 43 处 `return null/undefined` 静默降级，与 throw "显式失败"哲学直接冲突——调用方无法区分"无数据"和"出错" |

### 现有基础设施（4 层已建好，本 ADR 不重复造轮子）

| 层 | 工具 | 位置 | 状态 |
|----|------|------|------|
| shared | `toError()` unknown→Error | `shared/toError.ts` | ✅ 已建 |
| shared | `ErrorCode` 枚举 | `shared/errorCodes.ts` | ✅ 已建 |
| shared | `formatErrorMessage()` 分类映射 | `shared/errorMessages.ts` | ✅ 已建 |
| sprite | `SpriteError` 结构化错误类 | `sprite/errors.ts` | ✅ 已建 |
| 主进程 | `ErrorHandler` 统一处理器 | `electron/errorHandler.ts` | ✅ 已建 |
| 渲染进程 | `reportError` + `createIpcErrorHandler` | `renderer/helpers/errorHelpers.ts` | ✅ 已建 |

**问题不是"缺工具"，而是"工具使用不统一"。本 ADR 的产出是规则，不是新工具。**

## 决策

### 核心原则：按层 + 按边界分类，不追求全局单一策略

不同层有不同的消费者和稳定性要求，单一策略会破坏现有架构契约。规则按"层 × 边界"分类：

| 层/边界 | 策略 | 规则 |
|---------|------|------|
| **内核** | return null + logger.warn | 保持现状。内核是库，不中断调用方。降级时必须 log |
| **IPC 边界** | `{success:false, error: string}` | error 字段必须通过 `toError(e).message` 提取，禁止直接 `error.message` |
| **主进程非 IPC** | throw SpriteError | 携带 ErrorCode，ErrorHandler.handle 统一兜底 |
| **渲染进程** | reportError + createIpcErrorHandler | 推广 createIpcErrorHandler 到所有 orchestrator |
| **宿主降级** | 禁止 return null 静默吞错 | 必须 throw 或 return Result 类型；降级需显式 log |

### 决策 1：内核错误体系（保持现状，明确边界）

内核继续使用 `MemoraError` 体系（`src/utils/errors.ts`），4 大类：ConfigError / NetworkError / LlmError / ToolError。

**约束**：
- 内核是库，错误策略以"不中断调用方"为主——通过 return null/undefined + logger.warn 降级
- 当错误不可降级时（如配置缺失、权限拒绝），throw MemoraError
- 内核不依赖宿主的 SpriteError，保持领域无关

### 决策 2：宿主错误体系（SpriteError + ErrorCode 枚举）

宿主继续使用 `SpriteError`（`sprite/errors.ts`）+ `ErrorCode` 枚举（`shared/errorCodes.ts`）。

**为什么宿主不直接用内核 MemoraError**：
- 内核 MemoraError 是 4 大类（config/network/llm/tool），面向 AgentLoop 反思重试
- 宿主 SpriteError 是 9 大类（含 WINDOW_CREATE_FAILED / STORAGE_ERROR / VALIDATION_ERROR 等），面向用户友好提示
- 两者职责不同，强行统一会引入跨层耦合（违反 [backend_layers_rules](../rules/backend_layers_rules.md) 核心库 vs 宿主边界）

**ErrorHandler 是主进程统一入口**：
- `electron/errorHandler.ts` 的 `ErrorHandler.handle()` 是主进程错误处理的统一兜底
- 通过鸭子类型读取 `error.code`，兼容 SpriteError + StorageError（两者均携带 code: ErrorCode 字段但互不继承）
- `extractErrorCode` 字符串推断是 @deprecated 降级路径，新增错误必须用 `throw new SpriteError(ErrorCode.XXX, msg)` 显式指定

### 决策 3：IPC 边界契约（强制 toError 包装）

所有 IPC handler 返回 `{success: false, error}` 时，error 字段必须通过 `toError(e).message` 提取。

```typescript
// ✅ 正确：toError 包装，error 字段类型稳定为 string
try {
  const result = await someOperation();
  return { success: true, data: result };
} catch (e) {
  return { success: false, error: toError(e).message };
}

// ❌ 错误：直接 error.message，当 e 不是 Error 实例时为 undefined
catch (e) {
  return { success: false, error: (e as Error).message };
}
```

**理由**：
- IPC 序列化会丢失 Error 类原型链，渲染进程收到的 error 是普通对象
- `toError()` 处理 5 种 unknown 类型（Error/string/含 message 对象/普通对象/基础类型），保证返回值有 message
- 现有 147 处未用 toError 的 IPC handler 是技术债，按"碰到了就改"渐进对齐（不单独排期）

### 决策 4：主进程 throw vs return error 统一

主进程非 IPC 代码（sprite 层、electron 非 handler 层）统一用 `throw new SpriteError(ErrorCode.XXX, msg)`。

**禁止**：
- 同一函数内既有 throw 又有 `return {success:false}` —— 调用方需同时处理两种失败路径
- `return null/undefined` 静默吞错 —— 必须 throw 或 return Result 类型

**例外**（保留 return null 的合法场景）：
- 查询类操作"无数据"是合法业务结果（如 `getMemoryById` 未找到记录）—— 此时应 return null，但调用方必须显式检查
- 降级场景符合 [architecture_philosophy_rules §7 降级优先](../rules/architecture_philosophy_rules.md)（P1-P4 优先级）—— 降级时必须 logger.warn

### 决策 5：渲染进程错误处理推广 createIpcErrorHandler

渲染进程已统一用 `reportError()`（177 次/39 文件），但 `createIpcErrorHandler` 仅 3 个 orchestrator 使用。

**推广路径**（与 MIND-L3 联动）：
- MIND-L3 触发条件②已写入：AUDIT-ARCH-2 推进时顺带触及 orchestrator 定位
- 新增 orchestrator 时强制使用 createIpcErrorHandler
- 现有 panel 直接调用 IPC 的 43 次（13 文件）按"碰到了就改"渐进迁移

### 决策 6：渐进式推进，不一次性重构

| 阶段 | 内容 | 触发条件 |
|------|------|---------|
| Phase 1 | ADR 文档产出（本文件） | 立即 |
| Phase 2 | 147 处未用 toError 的 IPC handler 对齐 | 碰到了就改（阈值驱动） |
| Phase 3 | 43 处 return null 评估是否改为 throw | 出现因 null 吞错导致的 bug 时 |
| Phase 4 | createIpcErrorHandler 推广到所有 orchestrator | 与 MIND-L3 联动 |

## 理由

| 考虑 | 说明 |
|------|------|
| **不追求全局单一策略** | 内核是库（降级优先），宿主是应用（显式失败），渲染进程是浏览器环境（IPC 不可用时降级到 console）。单一策略会破坏 [architecture_philosophy_rules §7](../rules/architecture_philosophy_rules.md) 降级优先原则 |
| **复用现有基础设施** | toError / ErrorCode / SpriteError / ErrorHandler / reportError / createIpcErrorHandler 均已建好，本 ADR 只定规则，不造新工具 |
| **IPC 边界强制 toError** | IPC 序列化丢失原型链，直接 `error.message` 在 unknown 类型下为 undefined。toError 5 分支处理保证类型稳定 |
| **不强行统一 MemoraError 和 SpriteError** | 两者职责不同（内核面向 AgentLoop 反思 / 宿主面向用户提示），强行统一引入跨层耦合 |
| **渐进式推进** | 147 处 IPC handler + 43 处 return null 是历史代码，一次性重构影响面大、风险高。阈值驱动符合项目"自然生长"哲学 |

## 替代方案

| 方案 | 放弃原因 |
|------|---------|
| 全局统一用 throw + MemoraError | 破坏内核降级优先原则（§7）；MemoraError 4 大类不含宿主业务错误码（WINDOW_CREATE_FAILED 等） |
| 全局统一用 return Result 类型 | Result 类型是函数式编程范式，与项目 OOP + throw 风格冲突；需改造 255 处 catch 块，ROI 极低 |
| 强行合并 MemoraError 和 SpriteError | 违反 [backend_layers_rules](../rules/backend_layers_rules.md) 核心库 vs 宿主边界——内核不应依赖宿主错误类 |
| 一次性重构 147 处 IPC handler | 影响面大、无业务价值驱动、测试成本高；阈值驱动更符合自然生长 |

## 影响

### 对现有规则的影响

- **[coding-convention-rules §2 异常处理](../rules/coding-convention-rules.md)**：本 ADR 是 §2 的跨层细化。§2 是通用规则（区分业务异常与系统异常、不吞异常），本 ADR 补充"按层 × 按边界"的具体策略
- **[architecture_philosophy_rules §7 降级优先](../rules/architecture_philosophy_rules.md)**：本 ADR 与 §7 一致——内核降级是 P1-P4 优先级的体现，宿主 throw 是 P0 不可降级的体现

### 对代码的影响

- **新增 IPC handler**：必须用 `toError(e).message` 提取 error 字段
- **新增主进程非 IPC 代码**：必须用 `throw new SpriteError(ErrorCode.XXX, msg)`
- **新增渲染进程错误处理**：必须用 `reportError()` 或 `createIpcErrorHandler`
- **历史代码**：按阈值驱动渐进对齐，不强制立即修改

### 对任务的影响

- **AUDIT-ARCH-2**：从「需要决策」迁移至「已完成」（ADR 产出即闭环）
- **L3-C-IPC-1**（37 次 `{success:false, error}` 重复）：归入 Phase 2，阈值驱动
- **MIND-L3**：触发条件②已写入，与本 ADR 联动推进

## 何时回顾

- 当内核出现浏览器消费者（如 Web 版宿主）时，重新评估内核 return null 降级策略是否需要改为 throw
- 当出现因 IPC error 字段类型不稳定导致的渲染进程 bug 时，加速 Phase 2 推进
- 当 MemoraError 和 SpriteError 出现职责重叠时，评估是否提取共同基类
- 当 MIND-L3 启动模块重思时，联动评估 Phase 4 createIpcErrorHandler 推广

## 引用

- 现状数据来源：[待完成任务.md AUDIT-ARCH-2](../../tasks/待完成任务.md)
- 相关代码：[errorHelpers.ts](../../hosts/memora-sprite/src/electron/renderer/helpers/errorHelpers.ts) `reportError` / `createIpcErrorHandler`
- 相关代码：[errorHandler.ts](../../hosts/memora-sprite/src/electron/errorHandler.ts) `ErrorHandler` 主进程统一处理器
- 相关代码：[sprite/errors.ts](../../hosts/memora-sprite/src/sprite/errors.ts) `SpriteError` 结构化错误类
- 相关代码：[shared/toError.ts](../../hosts/memora-sprite/src/shared/toError.ts) unknown→Error 转换
- 相关代码：[src/utils/errors.ts](../../src/utils/errors.ts) 内核 `MemoraError` 体系
