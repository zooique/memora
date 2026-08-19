---
alwaysApply: false
description: "错误处理策略统一：按层 + 按边界分类（内核降级 / IPC 契约 / 主进程 throw / 渲染进程 reportError），不追求全局单一策略"
---

# ADR-020 · 错误处理策略统一：按层 + 按边界分类

> **状态**：✅ 已接受
> **日期**：2026-07-31
> **来源**：AUDIT-ARCH-2 任务推进（错误处理策略不统一，部分 throw / 部分 return error / 部分 log+降级）
> **依赖**：[ADR-006](./ADR-006-security-model.md)（安全模型）、[coding-convention-rules §2](../rules/coding-convention-rules.md)（异常处理）、[architecture_philosophy_rules §7](../rules/architecture_philosophy_rules.md)（降级优先）

## 核心原则：按层 + 按边界分类，不追求全局单一策略

不同层有不同的消费者和稳定性要求，单一策略会破坏现有架构契约。规则按"层 × 边界"分类：

| 层/边界 | 策略 | 规则 |
|---------|------|------|
| **内核** | return null + logger.warn | 内核是库，不中断调用方。降级时必须 log |
| **IPC 边界** | `{success:false, error: string}` | error 字段必须通过 `toError(e).message` 提取，禁止直接 `error.message` |
| **主进程非 IPC** | throw SpriteError | 携带 ErrorCode，ErrorHandler.handle 统一兜底 |
| **渲染进程** | reportError + createIpcErrorHandler | 推广 createIpcErrorHandler 到所有 orchestrator |
| **宿主降级** | 禁止 return null 静默吞错 | 必须 throw 或 return Result 类型；降级需显式 log |

## 关键决策

1. **内核错误体系（保持现状）**：继续用 `MemoraError`（`src/utils/errors.ts`），4 大类 ConfigError / NetworkError / LlmError / ToolError。内核以"不中断调用方"为主（return null + warn 降级）；不可降级才 throw；不依赖宿主的 SpriteError。
2. **宿主错误体系**：用 `SpriteError`（`sprite/errors.ts`）+ `ErrorCode`（`shared/errorCodes.ts`），9 大类面向用户友好提示。**不与内核 MemoraError 强行统一**——两者职责不同（内核面向 AgentLoop 反思重试 / 宿主面向用户提示），统一即引入跨层耦合。
3. **IPC 边界强制 toError**：`{success:false, error}` 的 error 字段必须 `toError(e).message` 提取。IPC 序列化丢失 Error 原型链，直接 `error.message` 在 unknown 时是 undefined。现有 147 处未用 toError 的是技术债，按"碰到了就改"渐进对齐。
4. **throw vs return error 统一**：主进程非 IPC 统一 `throw new SpriteError(ErrorCode.XXX, msg)`。禁止同函数既 throw 又 return `{success:false}`；禁止 return null 静默吞错（查询类"无数据"合法场景例外，但调用方必须显式检查）。
5. **渲染进程推广**：已统一 `reportError()`（177 次/39 文件），`createIpcErrorHandler` 仅 3 个 orchestrator 用，新增 orchestrator 强制使用，存量"碰到了就改"。
6. **渐进式推进，不一次性重构**：147 处 toError + 43 处 return null 是历史代码，阈值驱动对齐，符合自然生长哲学。

## 正确 / 错误示例

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

## 对现有规则的影响

- **[coding-convention-rules §2 异常处理](../rules/coding-convention-rules.md)**：本 ADR 是 §2 的跨层细化——§2 是通用规则，本 ADR 补充"按层 × 按边界"的具体策略。
- **[architecture_philosophy_rules §7 降级优先](../rules/architecture_philosophy_rules.md)**：内核降级是 P1-P4 优先级的体现，宿主 throw 是 P0 不可降级的体现。

## 何时回顾

- 内核出现浏览器消费者时，重新评估内核 return null 降级是否需要改 throw
- MemoraError 与 SpriteError 出现职责重叠时，评估是否提取共同基类
- 出现因 IPC error 字段类型不稳定导致的渲染进程 bug 时，加速 Phase 2（147 处 toError）推进

## 引用

- 相关代码：[src/utils/errors.ts](../../src/utils/errors.ts) 内核 `MemoraError` 体系
- 相关代码：[hosts/memora-sprite/src/shared/toError.ts](../../hosts/memora-sprite/src/shared/toError.ts) unknown→Error 转换
- 相关代码：[hosts/memora-sprite/src/sprite/errors.ts](../../hosts/memora-sprite/src/sprite/errors.ts) `SpriteError` 结构化错误类
- 相关代码：[hosts/memora-sprite/src/electron/errorHandler.ts](../../hosts/memora-sprite/src/electron/errorHandler.ts) `ErrorHandler` 主进程统一处理器