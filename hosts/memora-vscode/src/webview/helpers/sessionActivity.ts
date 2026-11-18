/**
 * 会话活跃度纯计算（自 `chatPanel.refreshSessionActivity` 外置）
 *
 * 为什么外置：这段判据同时服务两个消费面——聊天面板的入口角标，以及工作台的
 * 「在跑 / 等你」投影。放在面板私有方法里，工作台只能再写一份同样的 Set 遍历
 * （第二真相源）；外置后两边共用同一份计算，判据口径不会漂移。
 *
 * 口径（与迁移前逐字一致，**不是**新语义）：
 *   - `runningIds`：运行态表里 `streaming === true` 的会话；
 *   - `pendingIds`：有未答提问或有待确认的会话；
 *   - `badgeCount`：角标只数「别的会话」（当前显示会话的待处理已在屏上可见）；
 *   - `titleById`：遍历面内会话的展示名（真源 = `sessionTitleFor`，与工作台标题同源），
 *     供派活会话卡显示名字——webview 侧拿不到 SessionMeta，只能由宿主随快照投影下发。
 */

/** 本模块的输入面（全部由调用方以闭包注入，本模块不持有任何存储） */
export interface SessionActivityInputs {
  /** 参与遍历的会话集合（已由调用方并好：已装配实例 + 已建 ask 协调器 + 当前会话） */
  sessionIds: Iterable<string>;
  /** 当前显示会话（角标排除它） */
  currentSessionId: string;
  /** 某会话是否正在流式生成（真源 = 运行态表的 `streaming`） */
  isStreaming: (sessionId: string) => boolean;
  /** 某会话是否在等用户（待答提问 / 待确认） */
  isWaiting: (sessionId: string) => boolean;
  /** 会话展示名（真源 = sessionTitleFor / getSessionDisplayName，宿主注入） */
  titleFor: (sessionId: string) => string;
}

/** 活跃度快照（字段与 `session_activity` 协议载荷同构） */
export interface SessionActivitySnapshot {
  /** 正在跑的会话集合 */
  runningIds: string[];
  /** 等用户的会话集合 */
  pendingIds: string[];
  /** 入口角标数字（= 排除当前会话后的 pending 数） */
  badgeCount: number;
  /** sid → 展示名（遍历面内会话；派活会话卡按此显示，未命中回落 sid） */
  titleById: Record<string, string>;
}

/**
 * 计算一次活跃度快照（纯函数，无 I/O）
 *
 * 不导出：外部只需要 `runSessionActivityPush`（本文件内唯一消费者），
 * 直接暴露快照计算会让第二个调用点绕过「去重 + 投递」这条唯一路径。
 *
 * @param input 遍历面与两个判据闭包
 * @returns 可直接投递的活跃度快照
 */
function collectSessionActivity(input: SessionActivityInputs): SessionActivitySnapshot {
  // 遍历面去重（调用方给的是多个来源的并集：当前会话 + 已装配实例 + 已建 ask 协调器，
  // 同一会话会重复出现；不去重会让 pendingIds 出现重复项，角标与列表双亮）
  const ids = [...new Set(input.sessionIds)];
  const runningIds = ids.filter((id) => input.isStreaming(id));
  const pendingIds = ids.filter((id) => input.isWaiting(id));
  // 遍历面内会话的展示名：每次快照重算（标题会随改名变），只收在面的会话（与角标同源，不额外扫盘）
  const titleById: Record<string, string> = {};
  for (const id of ids) titleById[id] = input.titleFor(id);
  return {
    runningIds,
    pendingIds,
    badgeCount: pendingIds.filter((id) => id !== input.currentSessionId).length,
    titleById,
  };
}

/** `runSessionActivityPush` 的输入面（在快照输入之上叠加去重与投递） */
export interface SessionActivityPushInput extends SessionActivityInputs {
  /** 上一次成功投递的序列化快照（去重基准；缺省 = 首推） */
  lastSerialized: string | undefined;
  /** true = 忽略去重强制重发（视图重建 / webview ready） */
  force: boolean;
  /** 实际投递口（由调用方绑定到当前 webview） */
  post: (snapshot: SessionActivitySnapshot) => void;
}

/**
 * 计算并（按需）投递一次活跃度快照
 *
 * 把「判据 + 去重 + 投递」收成一个纯逻辑函数：聊天面板不再持有一段只服务自己的
 * 拼接代码，工作台读口与角标共用同一份计算口径。
 *
 * @param input 快照输入 + 去重基准 + 投递口
 * @returns 本次的序列化快照（无论是否真的投递；调用方存回去下次比较）
 */
export function runSessionActivityPush(input: SessionActivityPushInput): string {
  const snapshot = collectSessionActivity(input);
  const serialized = JSON.stringify(snapshot);
  if (input.force || serialized !== input.lastSerialized) input.post(snapshot);
  return serialized;
}

/** 面板侧活跃度推送的注入面（遍历面来源 + 排除项；判据与去重仍归 runSessionActivityPush） */
export interface PanelSessionActivityDeps extends Omit<SessionActivityPushInput, 'sessionIds'> {
  /** 已装配实例的会话（遍历面来源之一） */
  agentSessionIds: Iterable<string>;
  /** 已建 ask 协调器的会话（遍历面来源之一） */
  askSessionIds: Iterable<string>;
  /** 不参与活跃度的会话（助手会话：它不在工作会话列表里，角标不能指向不存在的行） */
  excludeSessionIds?: Iterable<string | undefined>;
}

/**
 * 面板活跃度推送：把「当前会话 + 已装配实例 + 已建 ask 协调器」并成遍历面后交给唯一判据
 *
 * 排除项在这里统一剔除（含 undefined 的助手会话 id），面板不再各写一份 filter——
 * 遍历面的拼装口径与判据同处一模块，避免「加了来源忘了排除」的漂移。
 *
 * @param deps 遍历面来源 + 排除项 + 判据闭包 + 投递口
 * @returns 本次的序列化快照（调用方存回去下次比较）
 */
export function pushPanelSessionActivity(deps: PanelSessionActivityDeps): string {
  const excludes = new Set(Array.from(deps.excludeSessionIds ?? []).filter(Boolean));
  return runSessionActivityPush({
    sessionIds: [deps.currentSessionId, ...deps.agentSessionIds, ...deps.askSessionIds].filter(
      (id) => Boolean(id) && !excludes.has(id),
    ),
    currentSessionId: deps.currentSessionId,
    isStreaming: deps.isStreaming,
    isWaiting: deps.isWaiting,
    titleFor: deps.titleFor,
    lastSerialized: deps.lastSerialized,
    force: deps.force,
    post: deps.post,
  });
}
