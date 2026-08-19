/**
 * 单元测试：Agent 模块常量集合
 *
 * 常量测试的目的：常量值变更时回归保护。
 * 常量本身是字面量，测试断言其预期值，任何非预期变更将被捕获。
 *
 * 跨模块一致性说明：
 * - AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS 应与 config/loader.ts 的
 *   DEFAULT_MAX_CONTEXT_TOKENS 保持一致（两处独立声明，不跨层引用，详见
 *   config/loader.ts 文件头注释）。下方用例通过 parseConfig({}) 默认合并路径
 *   断言两处一致，将人工保证升级为自动回归（测试文件不在生产依赖图内，不破坏分层）。
 */
import { describe, expect, it } from 'vitest';
import { AGENT_CONSTANTS, LOOP_CONSTANTS } from '@/agent/constants.js';
import { parseConfig } from '@/config/loader.js';

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

  it('记忆衰减执行间隔应为 1 小时', () => {
    expect(AGENT_CONSTANTS.DECAY_INTERVAL_MS).toBe(3_600_000);
  });

  it('默认上下文 token 数应为 120K', () => {
    expect(AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS).toBe(120_000);
  });

  it('loader 默认 maxContextTokens 应与 AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS 一致（跨模块护栏）', () => {
    // parseConfig({}) 走 DEFAULT_CONFIG 默认合并路径；若 loader 与 agent/constants
    // 两处 120_000 任一被改而另一未同步，本用例将捕获漂移。
    expect(parseConfig({}).memory.maxContextTokens).toBe(AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS);
  });

  it('默认 recall 排除的 source 应为空（设定记忆已归角色包，不参与召回排除）', () => {
    expect(AGENT_CONSTANTS.DEFAULT_RECALL_EXCLUDE_SOURCES).toEqual([]);
  });

  it('默认 locale 应为 zh-CN（项目母语，可被 AssembleInput.locale 覆盖）', () => {
    expect(AGENT_CONSTANTS.DEFAULT_LOCALE).toBe('zh-CN');
  });

  it('常量对象应为 readonly（as const）', () => {
    // as const 编译期检查，运行时仅验证字段存在
    // 14 个字段：CHAT_LOCK_TIMEOUT_MS / SHUTDOWN_ARCHIVE_TIMEOUT_MS / CHAT_INPUT_MAX_LENGTH /
    // DECAY_INTERVAL_MS / DEFAULT_MAX_CONTEXT_TOKENS / DEFAULT_RECALL_EXCLUDE_SOURCES /
    // DEFAULT_LOCALE / DEFAULT_RECALL_LIMIT / DEFAULT_RECENT_HISTORY_ROUNDS /
    // PAUSE_TIMEOUT_MS（P0-3 暂停超时自动归档）/
    // HOT_MEMORY_MAX_ROUNDS / HOT_MEMORY_CONTENT_SLICE（P2.2 热记忆截断策略）/
    // CURRENT_SCHEMA_VERSION（T1-4 检查点 schema 版本，未来兼容公共前提）/
    // COMPLETED_TOOL_CALLS_MAX（T2 FIFO 封顶）
    expect(Object.keys(AGENT_CONSTANTS)).toHaveLength(14);
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

  it('摘要缓存 TTL 应为 10 条消息', () => {
    expect(LOOP_CONSTANTS.SUMMARY_CACHE_TTL_MSGS).toBe(10);
  });

  it('召回记忆内容截断长度应为 200 字符', () => {
    expect(LOOP_CONSTANTS.RECALL_CONTENT_SLICE).toBe(200);
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

  it('常量对象应为 readonly（as const）', () => {
    // as const 编译期检查，运行时仅验证字段存在
    expect(Object.keys(LOOP_CONSTANTS)).toHaveLength(12);
  });
});
