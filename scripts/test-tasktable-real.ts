/**
 * 任务表确定性触发（层1）· 真实 LLM 真机实证脚本
 *
 * 用法：
 *   npx tsx scripts/test-tasktable-real.ts
 *
 * 背景（探索方案 docs/任务表确定性触发-探索方案.md 层0/层1）：
 *   任务表工具（task_table_write/update）长期"建造成型、从未被 LLM 触发"（metrics.plan.taskTableWriteCount = 0）。
 *   层1 确定性化：检测用户输入命中 needsPlanning → 首迭代注入命令式强引导 nudge，推高 LLM 建表决策概率。
 *
 * 本脚本实证目标（非完整宿主装配，聚焦观测，直接复用 loop 的可写装配回调）：
 *   给真实 LLM 一个"强命令多步任务"，观察它是否决策调用 task_table_write 并分步推进 active 步骤。
 *   loop 在 toolCalls 遍历时（loop.ts L1482-1483）仅凭调用名即累计 taskTableWriteCount，
 *   且 getActivePlanItemMeta 返回 active 步骤变化即产 plan_item_boundary（loop.ts L1005-1017），
 *   因此注入最小 getActivePlanItemMeta/getTaskTable、无需 sessionManager 完整集成，
 *   即可既实证"LLM 是否愿意建表"，又实证"plan_item_boundary 是否随步骤推进产出"。
 *
 * 注意：
 *   - getActivePlanItemMeta/getTaskTable 为 loop 实例可写字段，构造后直赋（对齐 assembler.ts 装配模式）。
 *   - script 依赖三套件环境变量 MEMORA_MODEL / MEMORA_BASE_URL / MEMORA_API_KEY（.memora/config.json 占位展开）。
 */

import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config/loader.js';
import { createLlmProvider } from '../src/llm/factory.js';
import { AgentLoop } from '../src/agent/loop.js';
import { BUILTIN_TOOLS } from '../src/agent/builtinTools.js';
import type { AgentMetrics } from '../src/agent/tracer.js';

// ═══════════════════════════════════════════════════════════════
// 简易任务表内存态（仅支撑工具返回可读结果，非会话集成）
// ═══════════════════════════════════════════════════════════════

/** 一条模拟计划步骤 */
interface MockPlanItem {
  id: string; // 8 位短 id（模拟 task_table_write 返回格式）
  description: string;
  status: 'pending' | 'active' | 'done' | 'blocked';
}

/** 内存计划容器（本脚本进程内自维护，供 toolExecutor 读写返回） */
const mockPlan: MockPlanItem[] = [];

/** 生成 8 位十六进制短 id（对齐 task_table_write「uuid 前 8 位」寻址约定） */
function shortId(): string {
  return randomBytes(4).toString('hex');
}

/**
 * 推进 active 步骤（模拟 sessionManager.ensureActivePlanItem 的"恰好一个 active"自维护）。
 * 找到第一个非 done/blocked 的步骤置 active；每步推进会让 getActivePlanItemMeta 的 planItemId 变化，
 * 供 loop 识别"active 步骤已推进"并产出 plan_item_boundary 事件（实证 plan_item_boundary 计数）。
 */
function advanceActive(): void {
  const firstOpen = mockPlan.find((s) => s.status === 'pending');
  for (const s of mockPlan) {
    s.status = s === firstOpen ? 'active' : s.status === 'active' ? 'pending' : s.status;
  }
}

/** 渲染任务表 Markdown（供 toolExecutor 返回给 LLM 回显当前计划） */
function renderPlan(): string {
  if (mockPlan.length === 0) return '当前任务表为空。';
  const rows = mockPlan
    .map((s, i) => `| ${i + 1} | [${s.id}] | ${s.description} | ${s.status} |`)
    .join('\n');
  return `| # | 步骤ID | 描述 | 状态 |\n|---|--------|------|------|\n${rows}`;
}

/**
 * 简易工具执行器：对齐 AgentLoop 期望的 (name, argsStr) => Promise<string> 签名。
 * 只对 task_table_write / task_table_update 做有意义的处理；其余内置工具返回"演示环境已忽略"，
 * 避免 LLM 走文件/执行类工具。真实宿主由 ToolExecutor 注入 planManager 连会话状态机，
 * 此处以最小实现支撑观测（不引入 sessionManager 依赖）。
 */
async function toolExecutor(name: string, argsStr: string): Promise<string> {
  // 解析参数（可能为空串或非法 JSON，兜底为空对象）
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsStr || '{}');
  } catch {
    args = {};
  }

  switch (name) {
    case 'task_table_write': {
      const mode = String(args.mode ?? 'overwrite');
      const steps = (args.steps as Array<{ description?: string; rolePack?: string }> | undefined) ?? [];
      if (mode === 'overwrite') mockPlan.length = 0; // 清空后重建
      for (const s of steps) {
        mockPlan.push({
          id: shortId(),
          description: String(s.description ?? '(未命名步骤)'),
          status: 'pending',
        });
      }
      if (mockPlan.length > 0) {
        const first = mockPlan[0];
        if (first) first.status = 'active'; // 模拟 ensureActivePlanItem：首个步骤 active
      }
      return `任务表已更新（${mode}），当前共 ${mockPlan.length} 个步骤：\n${renderPlan()}`;
    }
    case 'task_table_update': {
      const status = String(args.status ?? 'done');
      const planItemId = String(args.step_id ?? '');
      // 简化寻址：支持行首序号（1-based）或短 id 前缀匹配
      const idx = /^\d+$/.test(planItemId) ? Number(planItemId) - 1 : mockPlan.findIndex((s) => s.id.startsWith(planItemId));
      const item = mockPlan[idx];
      if (!item) {
        return `[ERR:STEP_NOT_FOUND] 未找到步骤 "${planItemId}"`;
      }
      item.status = status === 'blocked' ? 'blocked' : status === 'done' ? 'done' : item.status;
      // 模拟结束步骤后自动推进下一个 active（ensureActivePlanItem）——驱动 plan_item_boundary 产出
      if (item.status === 'done') advanceActive();
      return `步骤 [${item.id}] "${item.description}" 已标记为 ${status}`;
    }
    default:
      return `（演示环境已忽略工具 ${name}，参数 ${argsStr || '(空)'}）`;
  }
}

// ═══════════════════════════════════════════════════════════════
// 输出辅助
// ═══════════════════════════════════════════════════════════════

/** 断言工具函数：失败置退出码并打印，成功打印 ✅ */
function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`  ❌ 断言失败: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✅ ${message}`);
  }
}

/** 打印任务表维度指标（层0 新字段：taskTableWriteCount / planItemBoundaryCount） */
function printPlanMetrics(metrics: AgentMetrics): void {
  console.log('  ┌─ 任务表维度（层0 观测）');
  console.log(`  │  task_table_write 调用（建表/重建次数）: ${metrics.plan.taskTableWriteCount}`);
  console.log(`  │  plan_item_boundary 产出 → plan_item_boundary 事件数 : ${metrics.plan.planItemBoundaryCount}`);
  console.log('  └──────────────');
}

// ═══════════════════════════════════════════════════════════════
// 主函数
// ═══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log('📋 任务表确定性触发（层1）· 真实 LLM 真机实证\n');

  // 1. 加载配置（.memora/config.json，三件套由环境变量 MEMORA_* 展开）
  console.log('📋 步骤 1：加载 LLM 配置');
  let config;
  try {
    config = await loadConfig();
  } catch {
    console.error('❌ 未找到配置文件，请先配置 .memora/config.json');
    process.exit(1);
  }
  const hasProviderKey = Object.values(config?.llm?.providers ?? {}).some((p) => p?.apiKey);
  if (!hasProviderKey) {
    console.error('❌ 配置中缺少 API Key');
    process.exit(1);
  }
  const provider = createLlmProvider(config);
  console.log(`  ✅ Provider 创建成功: ${provider.name}`);

  // 2. 构造 AgentLoop：真实 provider + BUILTIN_TOOLS 全量（含 task_table_write/update）
  //    maxIterations 设小（~8），防止真实 LLM 多步任务无限轮询烧 token。
  console.log('\n📋 步骤 2：构造 AgentLoop（BUILTIN_TOOLS + 简易 toolExecutor）');
  const loop = new AgentLoop({
    provider,
    bootstrapMemories: [],
    toolDefinitions: BUILTIN_TOOLS,
    toolExecutor,
    maxIterations: 8,
  });
  // 装配 plan_item_boundary 实证所需的两个可写回调（对齐 assembler.ts 装配模式）：
  // getActivePlanItemMeta 返回当前 active 步骤元信息，loop 据此对比演进并产 plan_item_boundary 事件。
  loop.getActivePlanItemMeta = () => {
    const active = mockPlan.find((s) => s.status === 'active');
    return active ? { planItemId: active.id, title: active.description } : null;
  };
  // getTaskTable 返回当前任务表 Markdown，每次迭代注入给 LLM 感知进度
  loop.getTaskTable = () => renderPlan();
  const names = BUILTIN_TOOLS.map((t) => t.name);
  assert(names.includes('task_table_write'), 'BUILTIN_TOOLS 含 task_table_write');
  assert(names.includes('task_table_update'), 'BUILTIN_TOOLS 含 task_table_update');
  console.log(`  ✅ 注入工具数: ${names.length}`);

  // 3. 跑一个强命令多步任务（命中 needsPlanning → 首迭代注入 nudge）
  //    正文含"重构/拆解/补充单测"等多步结构信号，确定性判定应为 true。
  console.log('\n📋 步骤 3：跑多步任务（预期触发任务表）');
  console.log('  📤 输入: "重构 src/core/format.ts：把日期格式化逻辑抽成独立函数 formatDate，并补充单元测试。"');
  const input =
    '重构 src/core/format.ts：把日期格式化逻辑抽成独立函数 formatDate，并补充单元测试。';
  let response = '';
  console.log('  🤖 助手流式回复：\n');
  const start = Date.now();
  const toolCallsSeen: string[] = [];
  const stepBoundariesSeen: string[] = [];
  for await (const chunk of loop.processUserInput(input)) {
    if (chunk.type === 'text') {
      response += chunk.content;
      process.stdout.write(chunk.content);
    } else if (chunk.type === 'tool_start') {
      toolCallsSeen.push(chunk.name);
    } else if (chunk.type === 'plan_item_boundary') {
      stepBoundariesSeen.push(chunk.planItemId ?? '');
    }
  }
  const duration = Date.now() - start;
  console.log(`\n\n  ⏱️  本轮耗时: ${duration}ms`);

  // 4. 实证观测：任务表维度指标
  console.log('\n📋 步骤 4：任务表触发实证（层0 观测指标）');
  const metrics = loop.getMetrics();
  printPlanMetrics(metrics);
  console.log(`  🤖 LLM 实际发起的工具调用序列: ${toolCallsSeen.join(' → ') || '(无工具调用)'}`);
  console.log(`  🚧 产出的 plan_item_boundary 事件: ${stepBoundariesSeen.length} 个 ${stepBoundariesSeen.length ? `（${stepBoundariesSeen.join(' → ')}）` : ''}`);
  assert(response.length > 0, `有文本回复（${response.length} 字符）`);

  // 结论 1：taskTableWriteCount > 0 即证明层1 让任务表从未触发变为被真实 LLM 决策触发
  if (metrics.plan.taskTableWriteCount > 0) {
    console.log('🎉 实证1 通过：真实 LLM 已决策调用 task_table_write，任务表触发链路打通。');
  } else {
    console.log('⚠️  实证1 未触发：taskTableWriteCount = 0。建议检查 needsPlanning 判定是否命中，或 nudge 文案强度。');
  }
  // 结论 2：注入 getActivePlanItemMeta 后，active 步骤随 update 推进应产出 plan_item_boundary（plan_item_boundary_count 与思考折叠联动）
  if (metrics.plan.planItemBoundaryCount > 0) {
    console.log(`🎉 实证2 通过：plan_item_boundary 产出 ${metrics.plan.planItemBoundaryCount} 次，任务表驱动布局骨血（思考折叠/进度看板）已苏醒。`);
  } else {
    console.log('⚠️  实证2 未产出：planItemBoundaryCount = 0。可能 LLM 未分步推进 active，或一次性宣告完成。');
  }
}

// 执行主函数（错误时置退出码并打印）
main().catch((err) => {
  console.error('脚本异常:', err);
  process.exit(1);
});