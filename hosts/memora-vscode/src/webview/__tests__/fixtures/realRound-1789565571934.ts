/**
 * 真实 round 回放夹具：round-1789565571934（脚本生成物，勿手改）
 *
 * 来源（221KB 落盘文件，用 node 脚本压缩导出，非手工转录）：
 *   F:\\用户目录\\Desktop\\互动叙事平台方案\\.memora\\rounds\\round-1789565571934.json
 * 原文件 processEvents 共 1356 条，seq 3..1358（严格连续、严格单调）。
 *
 * 压缩纪律（保真 vs 体积）：
 *   ① 事件**类型相对顺序**逐条保留——9 类非 thought 事件的 seq 位置与先后关系与原文件一致；
 *   ② thought 洪流按「连续段落」压缩为 { kind:'thoughts', count }，count 取自真实段落长度
 *      （合计 1324，保留量级与分布特征，含尾部 419/482 两大段）；内容由 thoughtText() 确定性生成，
 *      seq 逐条唯一，以保证 step 分桶去重 / 增量拼接逻辑被真实触发；
 *   ③ tool_start/tool_result 的 name + args + summary **全量逐字保留**（1 次 task_table_write、
 *      4 次 task_table_update、search_memories、list_dir，共 7 对）；
 *   ④ text_self_review 的 payload 结构全保留（真实 Markdown：标题 + 表格 + 代码块 + 列表）；
 *   ⑤ 原文件**没有 done**（末条 = metrics）——这正是要复现的现实；要不要 done 由调用方决定。
 *
 * ⚠️ 已知差异（推断）：processEvents 不含 chunk（chunk 是 webview 协议消息，不入 round 事件）；
 *    但 is-streaming 光标只在 chunk / beginStreaming 时出现，故「无 chunk」变体**无法**复现
 *    「光标残留」现象。因此本夹具提供 withStreaming 开关，测试需同时覆盖两种变体。
 */

/** 计划快照最小结构（字段对齐 hosts/memora-vscode/src/shared/protocol.ts 的 PlanStepDto） */
export interface PlanStepDto {
  id: string;
  description: string;
  status: 'pending' | 'active' | 'done' | 'blocked';
  order: number;
  stepLog: { planStepId: string; summary: string; completedAt?: number }[];
}

/** 原 round 元数据（供断言/命名参照） */
export const REAL_ROUND = {
  id: "round-1789565571934",
  userText: "小组会议：给出下一个步任务建议",
  status: "complete",
  createdAt: "2026-09-16T13:32:51.934Z",
  completedAt: "2026-09-16T13:36:20.030Z",
  eventCount: 1356,
  firstSeq: 3,
  lastSeq: 1358,
} as const;

/** 4 步计划的顺序与标识（由任务表工具的 task_table_write 建立） */
export const PLAN_STEP_IDS = ["68e90642","1110041a","6f3b1624","3f5bf7fc"] as const;

/** 4 步计划描述 - 计划标识映射（task_table_write 的入参原文） */
export const PLAN_STEP_DEFS = [
  {
    "id": "68e90642",
    "description": "组长开场：介绍会议主题和讨论框架",
    "rolePack": "组长"
  },
  {
    "id": "1110041a",
    "description": "共鸣小说家发言：从叙事和用户体验角度给出下一步任务建议",
    "rolePack": "共鸣小说家"
  },
  {
    "id": "6f3b1624",
    "description": "memora助手发言：从技术实现和记忆管理角度给出下一步任务建议",
    "rolePack": "memora助手"
  },
  {
    "id": "3f5bf7fc",
    "description": "组长汇总：综合各方意见，提出具体行动方案",
    "rolePack": "组长"
  }
] as const;

// ───────────────────────── 计划快照（由任务表工具推进） ─────────────────────────
const PLAN_SNAPSHOT_0: PlanStepDto[] = [
  {
    "id": "68e90642",
    "description": "组长开场：介绍会议主题和讨论框架",
    "status": "active",
    "order": 0,
    "stepLog": []
  },
  {
    "id": "1110041a",
    "description": "共鸣小说家发言：从叙事和用户体验角度给出下一步任务建议",
    "status": "pending",
    "order": 1,
    "stepLog": []
  },
  {
    "id": "6f3b1624",
    "description": "memora助手发言：从技术实现和记忆管理角度给出下一步任务建议",
    "status": "pending",
    "order": 2,
    "stepLog": []
  },
  {
    "id": "3f5bf7fc",
    "description": "组长汇总：综合各方意见，提出具体行动方案",
    "status": "pending",
    "order": 3,
    "stepLog": []
  }
];

const PLAN_SNAPSHOT_1: PlanStepDto[] = [
  {
    "id": "68e90642",
    "description": "组长开场：介绍会议主题和讨论框架",
    "status": "done",
    "order": 0,
    "stepLog": []
  },
  {
    "id": "1110041a",
    "description": "共鸣小说家发言：从叙事和用户体验角度给出下一步任务建议",
    "status": "active",
    "order": 1,
    "stepLog": []
  },
  {
    "id": "6f3b1624",
    "description": "memora助手发言：从技术实现和记忆管理角度给出下一步任务建议",
    "status": "pending",
    "order": 2,
    "stepLog": []
  },
  {
    "id": "3f5bf7fc",
    "description": "组长汇总：综合各方意见，提出具体行动方案",
    "status": "pending",
    "order": 3,
    "stepLog": []
  }
];

const PLAN_SNAPSHOT_2: PlanStepDto[] = [
  {
    "id": "68e90642",
    "description": "组长开场：介绍会议主题和讨论框架",
    "status": "done",
    "order": 0,
    "stepLog": []
  },
  {
    "id": "1110041a",
    "description": "共鸣小说家发言：从叙事和用户体验角度给出下一步任务建议",
    "status": "done",
    "order": 1,
    "stepLog": []
  },
  {
    "id": "6f3b1624",
    "description": "memora助手发言：从技术实现和记忆管理角度给出下一步任务建议",
    "status": "active",
    "order": 2,
    "stepLog": []
  },
  {
    "id": "3f5bf7fc",
    "description": "组长汇总：综合各方意见，提出具体行动方案",
    "status": "pending",
    "order": 3,
    "stepLog": []
  }
];

const PLAN_SNAPSHOT_3: PlanStepDto[] = [
  {
    "id": "68e90642",
    "description": "组长开场：介绍会议主题和讨论框架",
    "status": "done",
    "order": 0,
    "stepLog": []
  },
  {
    "id": "1110041a",
    "description": "共鸣小说家发言：从叙事和用户体验角度给出下一步任务建议",
    "status": "done",
    "order": 1,
    "stepLog": []
  },
  {
    "id": "6f3b1624",
    "description": "memora助手发言：从技术实现和记忆管理角度给出下一步任务建议",
    "status": "done",
    "order": 2,
    "stepLog": []
  },
  {
    "id": "3f5bf7fc",
    "description": "组长汇总：综合各方意见，提出具体行动方案",
    "status": "active",
    "order": 3,
    "stepLog": []
  }
];

const PLAN_SNAPSHOT_4: PlanStepDto[] = [
  {
    "id": "68e90642",
    "description": "组长开场：介绍会议主题和讨论框架",
    "status": "done",
    "order": 0,
    "stepLog": []
  },
  {
    "id": "1110041a",
    "description": "共鸣小说家发言：从叙事和用户体验角度给出下一步任务建议",
    "status": "done",
    "order": 1,
    "stepLog": []
  },
  {
    "id": "6f3b1624",
    "description": "memora助手发言：从技术实现和记忆管理角度给出下一步任务建议",
    "status": "done",
    "order": 2,
    "stepLog": []
  },
  {
    "id": "3f5bf7fc",
    "description": "组长汇总：综合各方意见，提出具体行动方案",
    "status": "done",
    "order": 3,
    "stepLog": []
  }
];

/** 计划快照时间线（供测试读取：PLAN_SNAPSHOTS[0] = task_table_write 建立初始 4 步） */
export const PLAN_SNAPSHOTS: PlanStepDto[][] = [PLAN_SNAPSHOT_0, PLAN_SNAPSHOT_1, PLAN_SNAPSHOT_2, PLAN_SNAPSHOT_3, PLAN_SNAPSHOT_4];

/** toolCallId → 该次任务表调用后的快照下标 */
const PLAN_BY_TOOL_CALL_ID: Record<string, number> = {
  "call_c34bba90b1cd4b26923fa72c": 0,
  "call_0683214304e740a8abef6cbb": 1,
  "call_ba3df8013a6d478585532d75": 2,
  "call_1bd63a6271744a96b0e44069": 3,
  "call_bcb04b1b01c84e17975fc351": 4,
};

// ───────────────────────── 压缩事件脚本（保序） ─────────────────────────
export type ScriptItem =
  | { kind: 'meta'; role: string; llm: string }
  | { kind: 'thinking'; phase: string }
  | { kind: 'thoughts'; count: number }
  | { kind: 'step_boundary'; stepId: string; title: string }
  | { kind: 'tool'; toolCallId: string; name: string; args: string; ok: boolean; summary: string }
  | { kind: 'self_review' }
  | { kind: 'text_self_review'; content: string }
  | { kind: 'metrics'; durationMs: number; tokenIn: number; tokenOut: number; toolFailureCount: number; unparsedToolIntentCount: number; success: boolean };

/** 真实 round 的压缩事件序（顺序与原文件逐条一致） */
export const REAL_ROUND_SCRIPT: ScriptItem[] = [
  { kind: 'meta', role: "白话方案设计师", llm: "mimo-v2.5-pro" },
  { kind: 'thinking', phase: "llm_calling" },
  { kind: 'thoughts', count: 124 },
  { kind: 'step_boundary', stepId: "20acd4eb-1b15-4c7e-8710-86ed12ee03f2", title: "共鸣小说家 发言：给出下一个步任务建议" },
  { kind: 'tool', toolCallId: "call_c34bba90b1cd4b26923fa72c", name: "task_table_write", args: "{\"mode\": \"overwrite\", \"steps\": [{\"description\": \"组长开场：介绍会议主题和讨论框架\", \"rolePack\": \"组长\"}, {\"description\": \"共鸣小说家发言：从叙事和用户体验角度给出下一步任务建议\", \"rolePack\": \"共鸣小说家\"}, {\"description\": \"memora助手发言：从技术实现和记忆管理角度给出下一步任务建议\", \"rolePack\": \"memora助手\"}, {\"description\": \"组长汇总：综合各方意见，提出具体行动方案\", \"rolePack\": \"组长\"}]}", ok: true, summary: "任务表已更新（overwrite），当前共 4 个步骤：\n  - [68e90642] 组长开场：介绍会议主题和讨论框架（角色：组长）\n  - [1110041a] 共鸣小说家发言：从叙事和用户体验角" },
  { kind: 'thinking', phase: "llm_calling" },
  { kind: 'thoughts', count: 48 },
  { kind: 'step_boundary', stepId: "1110041a-a036-41ac-a5a0-07dfaf288385", title: "共鸣小说家发言：从叙事和用户体验角度给出下一步任务建议" },
  { kind: 'tool', toolCallId: "call_0683214304e740a8abef6cbb", name: "task_table_update", args: "{\"step_id\": \"1\", \"status\": \"done\"}", ok: true, summary: "步骤 [68e90642] \"组长开场：介绍会议主题和讨论框架\" 已标记为 done" },
  { kind: 'thinking', phase: "llm_calling" },
  { kind: 'thoughts', count: 55 },
  { kind: 'step_boundary', stepId: "6f3b1624-105c-4fe1-af53-624fc8d44b5b", title: "memora助手发言：从技术实现和记忆管理角度给出下一步任务建议" },
  { kind: 'tool', toolCallId: "call_2ae994b871cd41cd88943958", name: "search_memories", args: "{\"query\": \"互动叙事平台 用户 痛点 体验\", \"limit\": \"5\"}", ok: true, summary: "搜索 \"互动叙事平台 用户 痛点 体验\" 找到 2 条（语义+关键词）：\n1. [round-summary:轮次摘要 2026-09-16-smu3jqouj round-1789529804724" },
  { kind: 'thinking', phase: "llm_calling" },
  { kind: 'thoughts', count: 73 },
  { kind: 'step_boundary', stepId: "3f5bf7fc-2b65-4161-9c9d-0fa2a0e54695", title: "组长汇总：综合各方意见，提出具体行动方案" },
  { kind: 'tool', toolCallId: "call_ba3df8013a6d478585532d75", name: "task_table_update", args: "{\"step_id\": \"2\", \"status\": \"done\"}", ok: true, summary: "步骤 [1110041a] \"共鸣小说家发言：从叙事和用户体验角度给出下一步任务建议\" 已标记为 done" },
  { kind: 'thinking', phase: "llm_calling" },
  { kind: 'thoughts', count: 59 },
  { kind: 'tool', toolCallId: "call_3a8dce4ff4b74ee79177ddbb", name: "list_dir", args: "{\"path\": \".\", \"recursive\": \"true\"}", ok: true, summary: "目录 f:\\用户目录\\Desktop\\互动叙事平台方案 共有 34 个条目：\n  📁 docs/\n  📄 docs\\数据模型设计v1.0.md\n  📄 docs\\数据模型验证.py\n  📄 d" },
  { kind: 'thinking', phase: "llm_calling" },
  { kind: 'thoughts', count: 49 },
  { kind: 'tool', toolCallId: "call_1bd63a6271744a96b0e44069", name: "task_table_update", args: "{\"step_id\": \"3\", \"status\": \"done\"}", ok: true, summary: "步骤 [6f3b1624] \"memora助手发言：从技术实现和记忆管理角度给出下一步任务建议\" 已标记为 done\n（收尾提示：全部步骤已标记完成，但列表中没有执行性验证步骤。若尚未实际验证结果——" },
  { kind: 'thinking', phase: "llm_calling" },
  { kind: 'thoughts', count: 15 },
  { kind: 'tool', toolCallId: "call_bcb04b1b01c84e17975fc351", name: "task_table_update", args: "{\"step_id\": \"4\", \"status\": \"done\"}", ok: true, summary: "步骤 [3f5bf7fc] \"组长汇总：综合各方意见，提出具体行动方案\" 已标记为 done\n（收尾提示：全部步骤已标记完成，但列表中没有执行性验证步骤。若尚未实际验证结果——如运行测试、检查产出、复" },
  { kind: 'thinking', phase: "llm_calling" },
  { kind: 'thoughts', count: 419 },
  { kind: 'self_review' },
  { kind: 'thinking', phase: "llm_calling" },
  { kind: 'thoughts', count: 482 },
  { kind: 'text_self_review', content: "这个小组会议记录**质量很高**，我来具体评价一下：\n\n## 📊 会议记录质量评估\n\n### ✅ 优点\n\n| 维度 | 评价 | 具体表现 |\n|------|------|----------|\n| **结构清晰** | 优秀 | 四个角色依次发言，逻辑递进 |\n| **白话表达** | 优秀 | \"伏线收束\"、\"建造章节\"等比喻让技术讨论生动易懂 |\n| **实用性** | 优秀 | 每个建议都有时间估算和具体操作步骤 |\n| **一致性** | 优秀 | 两位组员意见在汇总中得到整合，无矛盾 |\n\n### 📝 核心结论的准确性\n\n会议得出的结论**完全正确**：\n\n1. **文档对齐必须先修** —— 这是事实，宪法内部确实有Spike结论矛盾\n2. **修完就该动手写代码** —— 项目已经零代码太久，需要进入实现阶段\n3. **开发者体验很重要** —— 新开发者需要快速上手的入口\n\n### 🎯 行动方案评估\n\n**4步走方案**：\n```\nStep 1: 文档收束（30分钟）✅ 合理，小成本大收益\nStep 2: 项目骨架（1-2天）✅ 必要，从设计到代码的桥梁\nStep 3: 第一个API（1天）✅ 关键，验证技术链路\nStep 4: 开发者文档（0.5天）✅ 重要，降低后续开发门槛\n```\n\n**时间估算**：总计约1周，符合MVP开发节奏。\n\n---\n\n## 🚀 下一步行动建议\n\n会议记录已经给出了明确方案。**现在需要你确认**：\n\n**是否开始执行 Step 1（文档收束）？**\n\n具体任务：\n1. 修复宪法内部 Spike 结论矛盾（5分钟）\n2. 数据模型文档添加术语映射表（10分钟）\n3. Spike 结论回流到产品构思（5分钟）\n\n预计耗时：20分钟。\n\n需要我现在开始执行吗？" },
  { kind: 'thinking', phase: "archiving" },
  { kind: 'metrics', durationMs: 208130, tokenIn: 131439, tokenOut: 1949, toolFailureCount: 0, unparsedToolIntentCount: 0, success: true },
];

/** thought 文案生成器（seq 唯一，触发增量拼接 / 去重分支） */
export function thoughtText(n: number): string {
  return `思考碎片#${n}：评估会议记录结构与行动方案可执行性`;
}

// ───────────────────────── 时间线构造 ─────────────────────────

/** 时间线上的一条入站 webview 消息（结构化弱类型，直接喂给 dispatch） */
export interface TimelineMsg {
  type: string;
  [k: string]: unknown;
}

export interface TimelineOptions {
  /** 补发 done —— R4 对照组的唯一变量 */
  withDone?: boolean;
  /** 插入 chunk（模拟真实运行期流式正文）；落盘 processEvents 没有 chunk，故默认关 */
  withStreaming?: boolean;
  /** 收尾补发空 plan_update（宿主 postPlanUpdate() 的清看板动作） */
  withEmptyPlanUpdate?: boolean;
}

/**
 * 展开压缩脚本 → 可直接 dispatch 的消息序列。
 *
 * seq 从 3 起连续自增：因原文件 seq 严格连续，展开后末条 seq === 1358，
 * 与原文件一致（可作断言：REAL_ROUND.lastSeq）。
 */
export function buildRealRoundTimeline(opts: TimelineOptions = {}): TimelineMsg[] {
  const msgs: TimelineMsg[] = [];
  let seq = REAL_ROUND.firstSeq;
  let thoughtIdx = 0;
  let streamingStarted = false;

  for (const item of REAL_ROUND_SCRIPT) {
    switch (item.kind) {
      case 'meta':
        msgs.push({ type: 'process_event', event: { type: 'meta', seq: seq++, ts: '', payload: { role: item.role, llm: item.llm } } });
        break;
      case 'thinking':
        msgs.push({ type: 'process_event', event: { type: 'thinking', seq: seq++, ts: '', payload: { phase: item.phase } } });
        break;
      case 'thoughts':
        for (let i = 0; i < item.count; i++) {
          msgs.push({
            type: 'process_event',
            event: { type: 'thought', seq: seq++, ts: '', payload: { content: thoughtText(thoughtIdx++) } },
          });
        }
        break;
      case 'step_boundary':
        msgs.push({
          type: 'process_event',
          event: { type: 'step_boundary', seq: seq++, ts: '', payload: { stepId: item.stepId, title: item.title } },
        });
        break;
      case 'tool': {
        // 真实运行期：正文先在流式区出现，随后工具执行（chunk 是协议消息，不入 round 事件）
        if (opts.withStreaming && !streamingStarted) {
          streamingStarted = true;
          msgs.push({ type: 'chunk', content: '【组长开场】介绍会议主题和讨论框架', roundId: REAL_ROUND.id });
        }
        msgs.push({
          type: 'process_event',
          event: { type: 'tool_start', seq: seq++, ts: '', payload: { toolCallId: item.toolCallId, name: item.name, args: item.args } },
        });
        msgs.push({
          type: 'process_event',
          event: {
            type: 'tool_result', seq: seq++, ts: '',
            payload: { toolCallId: item.toolCallId, name: item.name, ok: item.ok, summary: item.summary },
          },
        });
        const snapIdx = PLAN_BY_TOOL_CALL_ID[item.toolCallId];
        if (snapIdx !== undefined) {
          msgs.push({ type: 'plan_update', steps: PLAN_SNAPSHOTS[snapIdx] });
        }
        break;
      }
      case 'self_review':
        msgs.push({ type: 'process_event', event: { type: 'self_review', seq: seq++, ts: '', payload: {} } });
        break;
      case 'text_self_review':
        msgs.push({
          type: 'process_event',
          event: { type: 'text_self_review', seq: seq++, ts: '', payload: { content: item.content } },
        });
        break;
      case 'metrics':
        msgs.push({
          type: 'process_event',
          event: {
            type: 'metrics', seq: seq++, ts: '',
            payload: {
              durationMs: item.durationMs, tokenIn: item.tokenIn, tokenOut: item.tokenOut,
              toolFailureCount: item.toolFailureCount, unparsedToolIntentCount: item.unparsedToolIntentCount,
              success: item.success,
            },
          },
        });
        break;
    }
  }

  if (opts.withEmptyPlanUpdate) msgs.push({ type: 'plan_update', steps: [] });
  if (opts.withDone) msgs.push({ type: 'done', roundId: REAL_ROUND.id });
  return msgs;
}
