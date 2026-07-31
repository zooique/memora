# MIND2-D7 + D8 source 聚合纯函数提取方案

> 同轮处理：D7（contextAwareness.ts sourceCounts 重复遍历）+ D8（patternDetector.ts getSourceDistribution 提取到共享 helpers）。
> 两项是「按 source 聚合统计」模式的内聚提取，D7 的 countBySource 可作为 D8 helpers 的底层依赖。

## 一、现状分析

### 1.1 问题定位

**MIND-D7**：`contextAwareness.ts` 两方法各自构建 `sourceCounts` Map，重复遍历同批数据：
- `deriveCoherence()`（行 178-181）：构建 sourceCounts 后只取 maxCount
- `getDominantSource()`（行 217-220）：构建 sourceCounts 后取 maxSource
- 两处 4 行模式完全相同，共 8 行重复

**MIND-D8**：`patternDetector.ts` 的 `getSourceDistribution()`（行 365-380）是私有方法，仅本文件调用（2 处：行 289/291）。但「按 source 聚合统计」模式与 D7 跨控制器重复：
- D7 需要「source → 计数」
- D8 需要「source → 占比」（计数 / total）
- D8 的占比计算可基于 D7 的计数结果派生

### 1.2 提取范围

| 函数 | 位置 | 职责 | 调用方 |
|------|------|------|--------|
| `countBySource(memories)` | 新建 `sprite/controllers/helpers.ts` | source → 计数 Map | contextAwareness.ts（D7）+ helpers.ts 内部（D8） |
| `getSourceDistribution(memories)` | 新建 `sprite/controllers/helpers.ts` | source → 占比 Map | patternDetector.ts（D8） |

**依赖关系**：`getSourceDistribution` 内部调用 `countBySource`，避免重复遍历。

### 1.3 不提取的归档

| 项 | 理由 |
|----|------|
| contextAwareness.ts 的 `deriveDepth()` | 基于 content.length 而非 source 聚合，模式不同，不提取 |
| patternDetector.ts 的 `sourceLabel()` | 是 MIND-D6 的范围（映射表嫁接），本轮不处理 |
| 其他控制器（affectController/rapportController 等） | 未发现 source 聚合模式，不提取 |

## 二、目标设计

### 2.1 新建 helpers.ts

```typescript
// sprite/controllers/helpers.ts

import type { Memory } from 'memora';

/**
 * 按来源统计记忆数量
 *
 * 提取自 contextAwareness.ts（MIND-D7）和 patternDetector.ts（MIND-D8）的共享聚合模式。
 * 返回 source → 出现次数 的 Map。
 *
 * @param memories 记忆列表
 */
export function countBySource(memories: Memory[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of memories) {
    counts.set(m.source, (counts.get(m.source) ?? 0) + 1);
  }
  return counts;
}

/**
 * 计算来源分布占比
 *
 * 提取自 patternDetector.ts（MIND-D8），基于 countBySource 派生占比。
 * 返回 source → 占比（0-1） 的 Map。
 *
 * @param memories 记忆列表
 */
export function getSourceDistribution(memories: Memory[]): Map<string, number> {
  const total = memories.length;
  if (total === 0) return new Map();

  const counts = countBySource(memories);
  const distribution = new Map<string, number>();
  for (const [source, count] of counts) {
    distribution.set(source, count / total);
  }
  return distribution;
}
```

### 2.2 contextAwareness.ts 改造

```typescript
// 顶部新增 import
import { countBySource } from './helpers.js';

// deriveCoherence() 行 178-181 替换为：
const sourceCounts = countBySource(memories);

// getDominantSource() 行 217-220 替换为：
const sourceCounts = countBySource(memories);
```

### 2.3 patternDetector.ts 改造

```typescript
// 顶部新增 import
import { getSourceDistribution } from './helpers.js';

// 删除 private getSourceDistribution() 方法（行 360-380）
// 行 289/291 的 this.getSourceDistribution(...) 改为 getSourceDistribution(...)
```

## 三、改动文件清单

| 文件 | 变更类型 | 改动点 |
|------|---------|--------|
| `sprite/controllers/helpers.ts` | **新建** | countBySource + getSourceDistribution 共享纯函数 |
| `sprite/controllers/contextAwareness.ts` | 修改 | import + 两处 sourceCounts 改为 countBySource 调用 |
| `sprite/controllers/patternDetector.ts` | 修改 | import + 删除私有 getSourceDistribution + 调用点改 import |

## 四、验证计划

- 宿主 typecheck 0 错误
- 宿主全量测试通过（基线 4604）
- 重点验证 contextAwareness / patternDetector 相关测试

## 五、实施完成

### 5.1 验证结果

- **宿主 typecheck**：0 错误
- **全量测试**：4604 项全部通过（零回归）
- **覆盖率**：helpers.ts 91.66% 语句覆盖 / 75% 分支覆盖 / 100% 函数覆盖
- **重点验证**：contextAwareness.test.ts + patternDetector.test.ts 全部通过

### 5.2 实际修改文件清单

| 文件 | 变更类型 | 改动点 |
|------|---------|--------|
| `sprite/controllers/helpers.ts` | **新建** | countBySource + getSourceDistribution 共享纯函数（48 行） |
| `sprite/controllers/contextAwareness.ts` | 修改 | 新增 import + deriveCoherence/getDominantSource 两处 4 行重复遍历 → countBySource 调用（-8 行 +2 行 import +2 行注释） |
| `sprite/controllers/patternDetector.ts` | 修改 | 新增 import + 删除私有 getSourceDistribution 方法（-22 行）+ 两处调用点改为 import 函数 |

### 5.3 设计原则落地

- **纯函数无状态**：helpers.ts 不持有任何状态，不依赖 this 上下文
- **底层依赖复用**：getSourceDistribution 内部调用 countBySource，避免重复遍历
- **向后兼容**：contextAwareness/patternDetector 外部契约不变，仅内部实现改为委托共享函数
- **单轮一个领域**：仅处理「按 source 聚合统计」模式，未夹带其他重构（sourceLabel 嫁接属 D6 范围，留待批次 3）
