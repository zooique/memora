/**
 * 会话回放（HOSTED-SEAT-SESSION-1 外置）
 *
 * 视图重建 / 切会话 / 助手窗打开时，把**指定会话**的显示层重建一遍。本模块只管
 * 「按会话取值 → 投给绑定该会话的视图」的顺序：历史、标题、角色、技能、钉住引用、
 * 侧栏投影（占用 / 任务看板）。数据来源全部由面板注入（不持有 store、不碰运行态）。
 *
 * 为什么外置：chatPanel 贴 max-lines 上限，而回放是「读 → 投」的自足序列，
 * 与输入 / 流 / 会话导航零共享状态。
 */
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';
import type { PendingLiveRound } from '../../shared/turnProjection.js';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';

/** 回放依赖（字段读口 + 既有投影方法；面板只注入不做判断） */
export interface SessionReplayDeps {
  /** 该会话是否就是侧栏此刻显示的会话 */
  isCurrent: (sessionId: string) => boolean;
  /** 该会话是否有视图在显示（侧栏当前会话或附加视图绑定） */
  mayShow: (sessionId: string) => boolean;
  /** 侧栏是否处于草稿页 */
  isDraft: () => boolean;
  /** 重放草稿页（只对侧栏当前会话） */
  replayDraft: () => void;
  /** 该会话留存的未发送草稿（回填输入框） */
  restoreDraft: (sessionId: string) => ExtensionToWebviewMessage;
  /** 会话级投递 */
  post: (sessionId: string, msg: ExtensionToWebviewMessage) => void;
  /** 附件字节预读（同步渲染前填缓存） */
  preloadImages: (sessionId: string) => void;
  /** 打开历史加载期的 viewLoader 是否存在（无则走 legacy 扁平回退） */
  hasRoundLoader: () => boolean;
  /** 该会话的 live 轮（未落盘的流式正文 + 过程事件），无则 undefined */
  liveRound: (sessionId: string) => PendingLiveRound | undefined;
  /** 推一条整批重放的 turn_update（投递目标 = 该会话） */
  postTurnUpdate: (sessionId: string, live: PendingLiveRound | undefined, replay: boolean) => void;
  /** legacy 扁平历史（仅 user 消息；无 round loader 时的回退） */
  legacyHistory: (
    sessionId: string,
  ) => { role: string; content: string; ts?: string; roundId?: string }[];
  /** 会话标题（读侧兜底） */
  titleFor: (sessionId: string) => string;
  /** 该会话实例（角色 / 徽章按它取；可能尚未装配） */
  agentFor: (sessionId: string) => Agent | undefined;
  /** 侧栏当前会话的激活角色包名 */
  activeRolePack: () => string | undefined;
  /** 读某会话的角色包名（落盘真源） */
  readRolePack: (sessionId: string) => string | undefined;
  /** 推角色包（投递目标 = 该会话） */
  postRolePack: (name: string | undefined, agent: Agent | undefined, sessionId: string) => void;
  /** 模型清单（全局） */
  postProviders: () => void;
  /** 角色包清单（投递目标 = 该会话） */
  pushRolePacks: (sessionId: string) => void;
  /** 技能清单（投递目标 = 该会话） */
  pushSkillList: (sessionId: string) => void;
  /** 能力徽章（投递目标 = 该会话） */
  postCapabilityBadge: (agent: Agent | undefined, sessionId: string) => void;
  /** 钉住引用回种 */
  pushPinned: (sessionId: string) => void;
  /** 历史占用（侧栏投影） */
  postOccupancy: () => void;
  /** 任务表看板（侧栏投影） */
  postPlan: () => void;
}

/**
 * 重建某会话的显示层
 *
 * 侧栏当前会话：完整清单（含占用 / 看板等侧栏投影）；
 * 助手会话：只回放气泡 + 标题 + 配置面，角色 / 徽章按**该会话实例**取（不借侧栏投影）。
 *
 * @param deps 面板注入的窄依赖
 * @param sessionId 目标会话
 * @param focusRoundId 可选 turn 锚点（DISPATCH-CARD-TURN-1）：点 turn 卡打开会话时落到该轮；
 *   缺省仍是历史加载后滚到流尾（工作台 / 历史浮层 / 普通切会话不变）。
 */
export function replaySessionInto(
  deps: SessionReplayDeps,
  sessionId: string,
  focusRoundId?: string,
): void {
  const isCurrent = deps.isCurrent(sessionId);
  // 两个视图都没在显示这条会话 ⇒ 无事可做
  if (!deps.mayShow(sessionId)) return;
  // 未发送草稿回填：只填框、不置 typing 态（旧草稿不是「用户此刻在打字」）
  deps.post(sessionId, deps.restoreDraft(sessionId));
  // 草稿态（webview 重载但面板对象存活）→ 重建草稿页，不读 store
  if (isCurrent && deps.isDraft()) {
    deps.replayDraft();
    return;
  }
  // 清空消息区（切换会话时旧 DOM 必须先清）
  deps.post(sessionId, { type: 'clear_ok' });
  replayHistoryInto(deps, sessionId);
  // 落点信号：无锚点 = 历史加载完成滚到底；带锚点 = 点 turn 卡定位该轮。
  // 两者互斥而非先后，避免「先到底再回跳」的双次滚动闪烁。
  deps.post(
    sessionId,
    focusRoundId ? { type: 'focus_round', roundId: focusRoundId } : { type: 'history_loaded' },
  );
  // 会话标题（空会话 = 引导文案，避免「新会话 HH:MM」占位误认）
  deps.post(sessionId, {
    type: 'session_title',
    title: sessionId
      ? deps.titleFor(sessionId)
      : vscode.l10n.t('No session yet (click + above to create one)'),
  });
  // 角色 / 技能 / 徽章：实例与角色名都按会话取（助手会话不借侧栏投影）
  const agent = deps.agentFor(sessionId);
  const rolePackName = isCurrent ? deps.activeRolePack() : deps.readRolePack(sessionId);
  deps.postRolePack(rolePackName, agent, sessionId);
  deps.postProviders();
  deps.pushRolePacks(sessionId);
  deps.postCapabilityBadge(agent, sessionId);
  // 顺序约束：技能清单必须晚于 clear_ok（clear 会清空技能 chip，本帧才是回种帧）
  deps.pushSkillList(sessionId);
  deps.pushPinned(sessionId);
  // 以下两项是**侧栏投影**（读当前实例）：只在回放侧栏当前会话时补推
  if (!isCurrent) return;
  deps.postOccupancy();
  deps.postPlan();
}

/**
 * 回放某会话的历史（round-based 优先；无 loader 时走 legacy 扁平）
 *
 * @param deps 面板注入的窄依赖
 * @param sessionId 目标会话
 */
export function replayHistoryInto(deps: SessionReplayDeps, sessionId: string): void {
  // 无会话（初始空态）→ 清空消息区并返回
  if (!sessionId) {
    deps.post(sessionId, { type: 'clear_ok' });
    return;
  }
  // 会话加载期预读（附件字节同步读盘填缓存，供格式化同步命中）
  deps.preloadImages(sessionId);
  try {
    if (deps.hasRoundLoader()) {
      // 单条 turn_update 承载全量 rounds：live 未落盘内容并入同一条（原位替换半残快照）
      deps.postTurnUpdate(sessionId, deps.liveRound(sessionId), true);
      return;
    }
    for (const m of deps.legacyHistory(sessionId)) {
      if (m.role !== 'user') continue;
      deps.post(sessionId, { type: 'user', text: m.content, ts: m.ts ?? '', roundId: m.roundId });
    }
  } catch (err) {
    console.warn('Memora failed to load session history', err);
    // 历史加载失败给用户可见提示，避免「历史空白」静默
    deps.post(sessionId, {
      type: 'notice',
      level: 'error',
      message: vscode.l10n.t('Failed to load session history; try switching sessions and retry'),
    });
  }
}
