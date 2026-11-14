/**
 * 会话工具 · 主控装配面（托管模式 v0 · 切片 0：接线骨架）
 *
 * 职责（只做一件事）：
 *   - 装配层判定「这个 Agent 是主控」时，为它多注册**一个**会话工具 `list_work_sessions`；
 *   - 普通会话不注册 ⇒ 模型侧「工具不存在」，不是「调用报错」。
 *
 * 边界（刻意如此，勿扩）：
 *   - 本片**不做功能**：不建会话、不派发、不扫盘；只是把「主控身份 → 工具多一个」的接线打通。
 *   - 数据来源 = 注入的 `ISessionStore.listSessionMetas()`（宿主已有的会话元数据真源），
 *     不另建索引、不读对话正文。
 *   - 工具名**不能**叫 `list_sessions`：那个名字是内核的历史路标工具（纯文本摘要定位），
 *     与本工具的「工作区会话清单」不是一回事（重名会被内核 registerTool 直接拒绝）。
 *   - 主控身份**不落盘、不进 `SessionMeta`**：`SessionMeta.mode` 已作废，主控不是会话的持久属性。
 */
import type { Agent, ISessionStore, SessionMeta, ToolDefinition } from '@zooique/memora';
import { getSessionDisplayName } from '@zooique/memora';

/**
 * 会话清单工具名（装配点、单测、后续切片共用的唯一字面量）
 *
 * 与设计文档 §13.11.1 的四个路由工具之一同名；本片只落地这一个。
 */
export const LIST_WORK_SESSIONS_TOOL_NAME = 'list_work_sessions';

/**
 * 单个会话的对外摘要（本片最小字段集）
 *
 * 只给「认会话」所需的三个事实：标识、标题、最后更新时间。
 * 进度 / 待批 / 父子关系等字段留给后续切片（需要宿主运行态，不在本片射程）。
 */
export interface WorkSessionBrief {
  /** 会话标识（YYYY-MM-DD-sessionName，与 sessionStore 同口径） */
  sid: string;
  /** 展示标题（displayName 优先，回退 autoName，再回退会话标识） */
  title: string;
  /** 最后更新时间（ISO 8601，排序依据；store 已按此降序） */
  updatedAt: string;
}

/**
 * 工具定义（声明面）
 *
 * - `readonly: true` / `diskWrite: 'none'`：只读元数据，不写盘 ⇒ 不参与写串行闸；
 * - `confirmPolicy: 'audit'`：免弹窗但落审计（内核契约：宿主注册工具应显式声明，
 *   缺省 = 静默不审批不审计，这里刻意不走进那条缺省路径）。
 */
const LIST_WORK_SESSIONS_DEFINITION: ToolDefinition = {
  name: LIST_WORK_SESSIONS_TOOL_NAME,
  description:
    '列出当前工作区已知的会话（会话标识、标题、最后更新时间），用于判断是否已有相关会话、避免重复新建。' +
    '只返回元数据，不含对话正文。',
  parameters: {
    type: 'object',
    // 本片无参数：切片 1 接入扫盘后再按需扩展（不预留空壳参数）
    properties: {},
    required: [],
  },
  readonly: true,
  diskWrite: 'none',
  confirmPolicy: 'audit',
};

/**
 * 会话元数据 → 对外摘要（纯函数，便于单测）
 *
 * 标题回退链复用内核 `getSessionDisplayName`（displayName → autoName），
 * 两者皆空时退回会话标识——列表里不能出现「无名行」。
 *
 * @param meta 会话元数据（store 真源）
 * @returns 对外摘要
 */
export function toWorkSessionBrief(meta: SessionMeta): WorkSessionBrief {
  return {
    sid: meta.sessionId,
    title: getSessionDisplayName(meta) || meta.sessionId,
    updatedAt: meta.updatedAt,
  };
}

/**
 * 为主控会话注册会话工具
 *
 * 幂等性：本函数只做一次性装配注册；`registerTool` 对同名重复注册会抛错——
 * 这是有意的（重复装配 = 装配层 bug，不该被静默吞掉）。
 *
 * @param agent 已 init 的内核 Agent（注册面 = `agent.tools`）
 * @param sessionStore 宿主会话存储（数据真源 = `listSessionMetas()`）
 * @returns true = 已注册；false = 工具执行器不可用（未 init），调用方负责记日志
 */
export function registerWorkSessionTools(agent: Agent, sessionStore: ISessionStore): boolean {
  const tools = agent.tools;
  // 未初始化时 getter 返回 null：本片不抛错（装配层继续跑，调用方记一条警告即可）
  if (!tools) return false;
  tools.registerTool(LIST_WORK_SESSIONS_DEFINITION, async () => {
    // 结果形态对齐设计文档的 `{ ok, sessions }` 信封；本片不含 workspaceRoot（未到需要时）
    const sessions = sessionStore.listSessionMetas().map(toWorkSessionBrief);
    return JSON.stringify({ ok: true, sessions }, null, 2);
  });
  return true;
}
