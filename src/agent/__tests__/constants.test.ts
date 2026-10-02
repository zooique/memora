/**
 * 单元测试：Agent 模块常量集合
 *
 * 常量测试的目的：常量值变更时回归保护。
 * 常量本身是字面量，测试断言其预期值，任何非预期变更将被捕获。
 *
 * 跨模块一致性说明：
 * - AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS 为**真源**，另有两处镜像：
 *   ① config/loader.ts 的 DEFAULT_MAX_CONTEXT_TOKENS；② role-pack/strategyKeys.ts 的 MIN_CONTEXT_LIMIT。
 *   三处独立声明、不跨层 import（依赖方向 agent → role-pack 单向），靠「注释对冲 + 本文件护栏测试」维系。
 *   下方两用例分别断言 loader 与 strategyKeys 两处镜像与真源一致，将人工保证升级为自动回归
 *   （测试文件不在生产依赖图内，故跨层 import 不破坏分层）。
 */
import { describe, expect, it } from 'vitest';
import { AGENT_CONSTANTS, LOOP_CONSTANTS } from '@/agent/constants.js';
import { MAX_CONTEXT_LIMIT, MIN_CONTEXT_LIMIT } from '@/role-pack/strategyKeys.js';
import { MAX_CONTEXT_WINDOW, parseConfig } from '@/config/loader.js';

describe('AGENT_CONSTANTS · Agent 门面层常量', () => {
  it('chat() 并发锁超时应为 180s（LLM 120s + 60s 缓冲）', () => {
    expect(AGENT_CONSTANTS.CHAT_LOCK_TIMEOUT_MS).toBe(180_000);
  });

  it('close() 归档等待超时应为 5s', () => {
    expect(AGENT_CONSTANTS.SHUTDOWN_ARCHIVE_TIMEOUT_MS).toBe(5_000);
  });

  it('chat() 输入最大长度应为 128KB', () => {
    expect(AGENT_CONSTANTS.CHAT_INPUT_MAX_LENGTH).toBe(128 * 1024);
  });

  it('默认上下文 token 数应为 120K', () => {
    expect(AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS).toBe(120_000);
  });

  it('loader 默认 maxContextTokens 应与 AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS 一致（跨模块护栏）', () => {
    // parseConfig({}) 走 DEFAULT_CONFIG 默认合并路径；若 loader 与 agent/constants
    // 两处 120_000 任一被改而另一未同步，本用例将捕获漂移。
    expect(parseConfig({}).memory.maxContextTokens).toBe(
      AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS,
    );
  });

  it('strategyKeys 的 MIN_CONTEXT_LIMIT 应与真源一致（跨模块护栏 · 第三处镜像）', () => {
    // role-pack 层不可 import agent（依赖方向 agent → role-pack 单向），故 120_000 存在第三份镜像。
    // 本用例把既有「两处护栏」升级为「三处护栏」：真源漂移时该镜像不会静默失配。
    expect(MIN_CONTEXT_LIMIT).toBe(AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS);
  });

  it('strategyKeys 的 MAX_CONTEXT_LIMIT 应与 loader 告警参考上界一致（跨模块护栏 · 2M 镜像对）', () => {
    // 2M 值在 loader.MAX_CONTEXT_WINDOW（provider 窗口告警参考上界）与
    // strategyKeys.MAX_CONTEXT_LIMIT（角色包 contextLimit 声明上界）两处独立声明、注释对冲，
    // 若缺自动回归——任一被改而另一未同步即静默失配（改一处须同步另一处）。
    expect(MAX_CONTEXT_LIMIT).toBe(MAX_CONTEXT_WINDOW);
  });

  it('默认 locale 应为 zh-CN（项目母语，可被 AssembleInput.locale 覆盖）', () => {
    expect(AGENT_CONSTANTS.DEFAULT_LOCALE).toBe('zh-CN');
  });

  it('常量对象应为 readonly（as const）', () => {
    // as const 编译期检查，运行时仅验证字段存在
    // 9 个字段：CHAT_LOCK_TIMEOUT_MS / SHUTDOWN_ARCHIVE_TIMEOUT_MS / CHAT_INPUT_MAX_LENGTH /
    // DEFAULT_MAX_CONTEXT_TOKENS /
    // DEFAULT_LOCALE / DEFAULT_RECALL_LIMIT /
    // PAUSE_TIMEOUT_MS（暂停超时自动归档）/
    // GC_INTERVAL_MS（孤儿 Round 垃圾回收周期）/
    // COMPLETED_TOOL_CALLS_MAX（FIFO 封顶）
    expect(Object.keys(AGENT_CONSTANTS)).toHaveLength(9);
  });
});

describe('LOOP_CONSTANTS · AgentLoop 引擎层常量', () => {
  it('非 CJK 字符 token 估算应为每 token 3 字符', () => {
    expect(LOOP_CONSTANTS.CHARS_PER_TOKEN).toBe(3);
  });

  it('CJK 字符 token 估算密度应为 1.5（偏高估算，避免上下文溢出）', () => {
    expect(LOOP_CONSTANTS.CJK_CHARS_PER_TOKEN).toBe(1.5);
  });

  it('LLM 调用最大重试次数应为 2（不含首次）', () => {
    expect(LOOP_CONSTANTS.MAX_LLM_RETRIES).toBe(2);
  });

  it('LLM 重试基础延迟应为 1000ms（指数退避 base）', () => {
    expect(LOOP_CONSTANTS.RETRY_BASE_DELAY_MS).toBe(1000);
  });

  it('单次 LLM 请求超时应为 120s', () => {
    expect(LOOP_CONSTANTS.LLM_TIMEOUT_MS).toBe(120_000);
  });

  it('上下文截断缓冲比例应为 0.9（留 10% 给响应）', () => {
    expect(LOOP_CONSTANTS.CONTEXT_TOKENS_BUFFER_RATIO).toBe(0.9);
  });

  it('软上限摘要层 token 占容量阈值应为 0.3（30%）', () => {
    expect(LOOP_CONSTANTS.SUMMARY_LAYER_TOKEN_RATIO).toBe(0.3);
  });

  it('摘要缓存 TTL 应为 10 条消息', () => {
    expect(LOOP_CONSTANTS.SUMMARY_CACHE_TTL_MSGS).toBe(10);
  });

  it('上下文摘要参与消息条数应为 6', () => {
    expect(LOOP_CONSTANTS.SUMMARY_MSG_COUNT).toBe(6);
  });

  it('上下文摘要单条消息截断长度应为 200 字符', () => {
    expect(LOOP_CONSTANTS.SUMMARY_CONTENT_SLICE).toBe(200);
  });

  it('上下文摘要 LLM maxTokens 应为 150', () => {
    expect(LOOP_CONSTANTS.SUMMARY_MAX_TOKENS).toBe(150);
  });

  it('任务分类检测窗口应为 3 条 user 消息（多轮含代码请求不误判）', () => {
    expect(LOOP_CONSTANTS.TASK_TYPE_WINDOW).toBe(3);
  });

  it('单条工具结果上限应为 6000 token（read_file 分段与入口关落盘同源）', () => {
    expect(LOOP_CONSTANTS.SINGLE_TOOL_RESULT_MAX_TOKENS).toBe(6_000);
  });

  it('包裹开销预留应为 100 token（read_file 分段预算须扣除，否则自身产出反被入口关落盘）', () => {
    expect(LOOP_CONSTANTS.TOOL_RESULT_WRAP_OVERHEAD_TOKENS).toBe(100);
    // 扣除方向不可反：预算 = 上限 − 本键，必须保证 0 < 本键 < 上限，否则预算非正 / 不收紧
    expect(LOOP_CONSTANTS.TOOL_RESULT_WRAP_OVERHEAD_TOKENS).toBeGreaterThan(0);
    expect(LOOP_CONSTANTS.TOOL_RESULT_WRAP_OVERHEAD_TOKENS).toBeLessThan(
      LOOP_CONSTANTS.SINGLE_TOOL_RESULT_MAX_TOKENS,
    );
  });

  it('常量对象应为 readonly（as const）', () => {
    // as const 编译期检查，运行时仅验证字段存在
    // 24 个字段：CHARS_PER_TOKEN / CJK_CHARS_PER_TOKEN / MAX_LLM_RETRIES / RETRY_BASE_DELAY_MS /
    // LLM_TIMEOUT_MS / CONTEXT_TOKENS_BUFFER_RATIO / SUMMARY_LAYER_TOKEN_RATIO /
    // SINGLE_TOOL_RESULT_MAX_TOKENS（单条工具结果上限——
    // read_file 分段预算与入口关落盘阈值同源）/
    // TOOL_RESULT_WRAP_OVERHEAD_TOKENS（包裹模板开销预留——
    // read_file 分段预算扣除本键，否则自身产出超限反被入口关落盘）/
    // SUMMARY_CACHE_TTL_MSGS /
    // DEFAULT_INTERRUPTED_MARK（流式中断 SSOT 默认文案，
    // loop 与 orchestrator 共用）/
    // DEFAULT_MAX_ITERATIONS_REACHED_MARK（撞线收尾默认文案，
    // 与 DEFAULT_INTERRUPTED_MARK 同族对称，loop 引用）/
    // CONTEXT_PRESSURE_HINT（预算预警提示）/
    // SEARCH_CONVERGENCE_THRESHOLD / SEARCH_CONVERGENCE_HINT / MAX_WEB_SEARCH_CALLS（搜索收敛）/
    // TOOL_NARRATION_DISCIPLINE（工具导语纪律，分区式 UI 配套）/
    // SUMMARY_MSG_COUNT / SUMMARY_CONTENT_SLICE / SUMMARY_MAX_TOKENS /
    // REASONING_INPUT_CHARS / TASK_TYPE_WINDOW /
    // MAX_INTEL_PREFIX_LEN（情报区数据上限——LLM 私有笔记长度栓）/
    // MEMORY_SEARCH_TIMEOUT_MS（search_memories 响应性护栏——embed 挂起降级）/
    // MAX_PENDING_INTERJECTIONS（待注入插话条数上限——loop.interject 满员拒收裁决）
    expect(Object.keys(LOOP_CONSTANTS)).toHaveLength(25);
  });

  it('TOOL_NARRATION_DISCIPLINE 为工具导语纪律（抑制工具步前长文规划，与 narrate 分区配套）', () => {
    expect(LOOP_CONSTANTS.TOOL_NARRATION_DISCIPLINE).toContain('最多一句话');
    expect(LOOP_CONSTANTS.TOOL_NARRATION_DISCIPLINE).toContain('最终回答');
  });

  it('CONTEXT_PRESSURE_HINT 为预算预警提示（软上限前一级，引导压缩/收敛）', () => {
    expect(LOOP_CONSTANTS.CONTEXT_PRESSURE_HINT).toContain('上下文空间提示');
    expect(LOOP_CONSTANTS.CONTEXT_PRESSURE_HINT).toContain('compress_context');
    // 与软上限收尾信号语义互补（清晰区分，非同一文案）
    expect(LOOP_CONSTANTS.CONTEXT_PRESSURE_HINT).not.toContain('SOFT_LIMIT');
  });
});
