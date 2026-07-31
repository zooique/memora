# MIND-C2 config/loader.ts 类型守卫提取方案

> 来源：心智模型审计 P2 批次 2。loader.ts 中 8 处同模式 `as Record<string, unknown>` 断言提取为类型守卫辅助函数。

## 一、现状分析

### 1.1 问题

`src/config/loader.ts` 中 9 处 `as Record<string, unknown>` 断言，存在守卫与断言的隐式耦合（守卫变更时编译器不报警）。

**语义分类**：

| 语义 | 处数 | 位置 | 降级行为 |
|------|------|------|---------|
| 默认值 `{}` | 4 处 | parseConfig 顶层（input/llmInput/memoryInput/securityInput） | 非对象 → 空对象 |
| 降级 `undefined` | 3 处 | parseProviders 外层 + parseBackground + parseEmbedding | 非对象 → return undefined |
| 抛错 `throw` | 1 处 | parseProviders 内层 providerValue | 非对象 → throw configError |
| 读字段 | 1 处 | isEnoent（499 行） | 仅读 `.code` 字段 |

### 1.2 提取范围

仅提取语义一致的 4 处（默认值 `{}` 语义）为 `asRecordIfObject`。

**设计**：返回 `Record<string, unknown>`（非空对象才有效字段），非对象/数组/null 返回 `{}`。与 parseConfig 顶层 4 处的守卫+断言行为完全一致。

### 1.3 不提取的归档

| 项 | 理由 |
|----|------|
| 降级 `undefined` 语义 3 处（parseProviders/parseBackground/parseEmbedding） | 语义不同（return undefined vs {}），强行合并需引入第二个辅助函数 asRecordOrUndefined，3 处使用刚达阈值边际，保留原样更清晰 |
| 抛错 `throw` 语义 1 处（parseProviders 内层） | 守卫+throw 语义独特，不适用任何辅助函数 |
| isEnoent（499 行） | 仅读 `.code` 字段做 ENOENT 判定，模式不同 |

## 二、目标设计

```typescript
/**
 * 类型守卫辅助：非空对象 → Record，否则 → 空对象
 *
 * 收紧 MIND-C2 的 8 处 `as Record<string, unknown>` 隐式断言：
 * 守卫与断言合一，避免守卫变更时编译器不报警的类型安全风险。
 *
 * @param value 待收窄的值
 * @returns 非空对象返回 value as Record；否则返回空对象 {}
 */
function asRecordIfObject(value: unknown): Record<string, unknown> {
  return (value && typeof value === 'object' && !Array.isArray(value))
    ? value as Record<string, unknown>
    : {};
}
```

## 三、改动文件清单

| 文件 | 变更类型 | 改动点 |
|------|---------|--------|
| `src/config/loader.ts` | 修改 | 新增 asRecordIfObject 辅助函数 + 8 处守卫+断言改为调用 |

## 四、验证计划

- 内核 typecheck 0 错误
- 内核全量测试通过

## 五、实施完成

### 5.1 验证结果

- **内核 typecheck**：0 错误
- **内核全量测试**：1642 项全部通过（1 项 skipped 是 LLM 集成测试无 API Key，零回归）
- **宿主全量测试**：4604 项全部通过（零回归，loader.ts 被宿主 import 不影响宿主测试）

### 5.2 实际修改文件清单

| 文件 | 变更类型 | 改动点 |
|------|---------|--------|
| `src/config/loader.ts` | 修改 | 新增 `asRecordIfObject` 辅助函数（14 行）+ parseConfig 顶层 4 处守卫+断言改为调用（-10 行重复模式） |

### 5.3 设计决策

- **仅提取语义一致的 4 处**：parseConfig 顶层的 input/llmInput/memoryInput/securityInput 是「默认值 {}」语义，与 asRecordIfObject 一致
- **保留 5 处不提取**：parseProviders/parseBackground/parseEmbedding 是「降级 undefined」语义（3 处）+ parseProviders 内层是「throw」语义（1 处）+ isEnoent 是「读字段」语义（1 处），强行合并需引入第二个辅助函数，3 处使用刚达阈值边际，保留原样更清晰
- **避免过度工程**：不提取 asRecordOrUndefined 辅助函数，避免增加认知负担
