# MIND-D6 sourceLabel 映射嫁接方案

> 来源：心智模型审计 P2 批次 3。patternDetector 私有 sourceLabel（11 项）vs renderer SOURCE_LABELS（17 项，缺 6 项），消除双真理源。

## 一、现状分析

### 1.1 问题

**双真理源**：
- sprite 侧：`patternDetector.ts:365-380` 私有 `sourceLabel()` 方法，内联 11 项 labels
- renderer 侧：`helpers/sourceLabel.ts:38-56` 导出 `SOURCE_LABELS`，17 项

**差异**：renderer 比 sprite 多 6 项（persona/session/work-projection/quick-input/clipboard/timer）。sprite 侧遇到这 6 个 source 时返回原值（`labels[source] ?? source`），不会出错但显示不友好。

**分层约束**：sprite/controllers/ 不能 import renderer/helpers/（sprite 是后台，renderer 是 UI 层，反向依赖违反分层）。

### 1.2 嫁接路径

将 SOURCE_LABELS 下沉到 `src/shared/sourceLabels.ts`（共享层），sprite 和 renderer 都从 shared import。

**验证分层合法性**：
- shared 层被 sprite 和 renderer 共同 import（已有 toError.ts/truncate.ts 先例）
- renderer/helpers/sourceLabel.ts 改为 re-export shared 版本（向后兼容，消费点零改动）
- sprite/controllers/patternDetector.ts 删除私有 sourceLabel 方法，改 import shared 版本

### 1.3 不提取的归档

| 项 | 理由 |
|----|------|
| quickInputCompletion.ts 的 SOURCE_LABEL_MAP | 独立 4 项精简映射（insight/profile/work-projection + 默认'记忆'），补全候选场景需更短标签（'作品' vs '作品投影'），sourceLabel.ts 注释已明确不强制统一 |

## 二、目标设计

### 2.1 新建 shared/sourceLabels.ts

```typescript
// src/shared/sourceLabels.ts

/**
 * 记忆来源中文标签映射 — 纯函数工具
 *
 * 提取自 renderer/helpers/sourceLabel.ts（MIND-D6 嫁接），
 * 下沉到 shared 层供 sprite 和 renderer 共享，消除双真理源。
 */
export const SOURCE_LABELS: Readonly<Record<string, string>> = {
  profile: '个人偏好',
  insight: '洞察',
  rule: '规则',
  skill: '技能',
  guardrail: '安全',
  chat: '对话',
  file: '文件',
  work: '工作',
  memory: '记忆',
  summary: '摘要',
  note: '笔记',
  persona: '角色',
  session: '会话',
  'work-projection': '作品投影',
  'quick-input': '快速输入',
  clipboard: '剪贴板',
  timer: '定时器',
};

export function getSourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}
```

### 2.2 renderer/helpers/sourceLabel.ts 改造

改为 re-export shared 版本，保持消费点零改动：

```typescript
// renderer/helpers/sourceLabel.ts
export { SOURCE_LABELS, getSourceLabel } from '../../shared/sourceLabels.js';
```

### 2.3 sprite/controllers/patternDetector.ts 改造

```typescript
// 顶部新增 import
import { getSourceLabel } from '../../shared/sourceLabels.js';

// 删除私有 sourceLabel() 方法（行 365-380）
// 行 307 的 this.sourceLabel(source) 改为 getSourceLabel(source)
```

## 三、改动文件清单

| 文件 | 变更类型 | 改动点 |
|------|---------|--------|
| `src/shared/sourceLabels.ts` | **新建** | SOURCE_LABELS + getSourceLabel 共享真理源 |
| `src/electron/renderer/helpers/sourceLabel.ts` | 修改 | 改为 re-export shared 版本（消费点零改动） |
| `src/sprite/controllers/patternDetector.ts` | 修改 | import + 删除私有 sourceLabel 方法 + 调用点改 import |

## 四、验证计划

- 宿主 typecheck 0 错误
- 宿主全量测试通过（基线 4604）

## 五、实施完成

### 5.1 验证结果

- **宿主 typecheck**：0 错误
- **全量测试**：4604 项全部通过（零回归，relationGraph 力导向布局测试单独重跑 89 项全部通过，确认并发运行的 flaky test 与本次改动无关）
- **重点验证**：patternDetector.test.ts + sourceColor.test.ts + insightsRenderer.test.ts + dashboardPanelManager.test.ts 全部通过

### 5.2 实际修改文件清单

| 文件 | 变更类型 | 改动点 |
|------|---------|--------|
| `src/shared/sourceLabels.ts` | **新建** | SOURCE_LABELS + getSourceLabel 共享真理源（17 项完整映射） |
| `src/electron/renderer/helpers/sourceLabel.ts` | 修改 | 改为 re-export shared 版本（消费点 8 处零改动） |
| `src/sprite/controllers/patternDetector.ts` | 修改 | import getSourceLabel + 删除私有 sourceLabel 方法（-18 行）+ 2 处调用点改 import |

### 5.3 设计原则落地

- **分层合法性**：SOURCE_LABELS 下沉到 shared 层，sprite 和 renderer 都从 shared import，不违反分层（sprite 不依赖 renderer）
- **向后兼容**：renderer/helpers/sourceLabel.ts 保持 re-export，8 处消费点零改动
- **单一真理源**：patternDetector 不再持有私有缩水映射（11 项），统一使用 shared 的 17 项完整映射
- **路径验证**：renderer/helpers/ 到 shared/ 需 3 个 `../`（参考 quickInputCompletion.ts 的 `../../../shared/truncate.js`），patternDetector.ts 到 shared/ 需 2 个 `../`
