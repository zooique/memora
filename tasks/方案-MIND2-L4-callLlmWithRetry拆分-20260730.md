# MIND2-L4 callLlmWithRetry 职责拆分方案

## 一、现状分析

### 1.1 演进路径

`callLlmWithRetry`（134 行）混合 6 职责：
1. 重试策略（attempt 循环 + 指数退避）
2. abort 检查（signal.aborted）
3. 流式累积（for await chunk + fullContent +=）
4. 指标统计（metricLlmCallCount++ / metricTotalInputTokens）
5. 错误分类（isAbortError / streamStarted 判断）
6. span 管理（startSpan / recordException / end）

### 1.2 调研结论：不修（状态耦合的必然产物）

经深入分析，这 6 职责是**状态耦合**的，不是"上帝类"式的职责混合：

| 职责 | 状态依赖 | 拆分后问题 |
|------|---------|-----------|
| 重试策略 | 需读 streamStarted 判断是否可重试 | 需传入状态回调，复杂度不降反升 |
| 流式累积 | 需 yield chunk（generator 特性）| 不能提取到普通函数（generator 不能委托 yield 给非 generator） |
| abort 检查 | 穿插在重试循环 + 流式累积中 | 拆分后需在多处重复检查 |
| 指标统计 | 依赖 attempt 次数 + 成功/失败 | 拆分后需回传统计数据 |
| 错误分类 | 只有 3 分支（abortError/streamStarted/maxRetries）| 3 行代码提取成函数增加跳转 |
| span 管理 | 依赖重试结果（recordException/end）| 拆分后需回传 span 引用 |

**关键约束**：`callLlmWithRetry` 是 `AsyncGenerator`，`yield` 贯穿整个流程。
拆分子函数后，`yield` 需用 `yield*` 委托或子函数返回数据由主函数 yield——前者要求子函数也是 generator，后者增加状态传递。

### 1.3 与 progressive-refactor-rules 的对照

| 规则条款 | 适用情况 |
|---------|---------|
| §1 字段数 ≥ 15 | ❌ 不适用（5 个局部变量，未达阈值） |
| §1 职责数 ≥ 5 | ✅ 达到（6 职责） |
| §1 修改成本 ≥ 10 处 | ❌ 不适用（单文件内函数） |
| §1 软阈值观察 | ✅ 适用（功能内聚，状态耦合必然产物） |

**结论**：职责数达阈值，但状态耦合度高，拆分收益递减。按 §1 软阈值观察
「文件长度 > 1000 行但功能内聚 → 保留监控，不强制拆分」精神，判定**不修**。

### 1.4 归档理由

1. **状态耦合**：6 职责共享 fullContent/streamStarted/aborted 等状态，拆分后需大量状态传递
2. **generator 约束**：yield 贯穿流程，子函数必须是 generator 或回传数据
3. **收益递减**：errorClassifier 只有 3 分支，retryPolicy 需 2 个回调，拆分后复杂度不降
4. **风险递增**：重试逻辑是核心路径，拆分易引入隐蔽 bug（如重试时 state 未重置）

## 二、不提取的归档

| 项 | 理由 |
|----|------|
| retryPolicy 提取 | 需传入 streamStarted 状态 + 2 个回调（retry chunk / delay await），复杂度不降 |
| streamAccumulator 提取 | 已有 accumulateStream，但此处需 yield + abort + toolCalls，不适用 |
| errorClassifier 提取 | 只有 3 分支（abortError/streamStarted/maxRetries），3 行代码，提取增加跳转 |
| span 管理提取 | 依赖重试结果，拆分后需回传 span 引用 |

## 三、后续演进路径

```
本轮：判定不修（状态耦合的必然产物）
  ↓
观察期：若未来 callLlmWithRetry 继续膨胀（>200 行）或修改频繁引入 bug，
  可考虑提取"重试延迟+abort 等待"为独立 generator 子函数（yield* 委托）
  ↓
终态：保持单函数，靠注释 + 局部变量清晰命名维持可读性
```

## 四、验证计划

无需验证（判定不修）。

## 五、实施完成

### 5.1 结论
判定不修。归档为"状态耦合的必然产物"。

### 5.2 实际修改文件清单
无代码修改。仅更新待完成任务文档。

### 5.3 后续演进
保持监控。若未来膨胀 >200 行或频繁引入 bug，再考虑提取重试延迟 generator。
