import type { ISessionStore } from '@zooique/memora';

/**
 * 托管 Worker 会话 workStatus 更新助手（P1 新增）
 *
 * 集中管理 hosted Worker 会话的 SessionMeta.workStatus 更新逻辑。
 * 为什么抽出来：chatPanel.ts 有 max-lines 硬闸，T4 新增的 4 处 workStatus
 * 更新代码直接塞进 chatPanel 会超行；更重要的是——**workStatus 的更新逻辑
 * 只在宿主事件钩子消费时触发**，是宿主侧托管接线的一环，chatPanel 不该知道
 * SessionMeta 里托管字段的内部结构。
 *
 * 判定守卫：所有更新函数都内置 `meta?.origin === 'hosted'` 守卫——
 * 自助会话的 SessionMeta.workStatus 永远 undefined，updateSessionMeta 是 Partial 语义，
 * 所以守卫漏掉 = 会错误给自助会话写 workStatus，违反"自助零改动"原则。
 *
 * 更新通道：宿主事件钩子消费 → 宿主调用 updateSessionMeta。
 * AgentLoop（src/agent/loop.ts）与 SessionMeta 零耦合（grep 确认），
 * Worker loop 永远不直接写本字段。
 */
type SessionStoreLite = Pick<ISessionStore, 'getSessionMeta' | 'updateSessionMeta'>;

/**
 * questionPending 钩子 → workStatus='blocked'
 *
 * 触发时机：Worker 发出 ask_user（决策层提问），等待用户回答。
 * 已 blocked 的会话跳过更新（幂等）。
 */
export function noteBlockedOnAsk(sessionId: string, sessionStore: SessionStoreLite): void {
  const meta = sessionStore.getSessionMeta(sessionId);
  if (meta?.origin !== 'hosted') return;
  if (meta.workStatus === 'blocked') return; // 幂等
  sessionStore.updateSessionMeta(sessionId, { workStatus: 'blocked' });
}

/**
 * consumeFlow 终态钩子 → workStatus='completed' | 'failed'
 *
 * 触发时机：Worker 的 runFlow 正常收场 / 异常终止。
 *   - controller.signal.aborted → 'failed'（被用户停）
 *   - !pausedOnPurpose → 'completed'（正常收场）
 *   - pausedOnPurpose → 不写（软暂停不是终态，还能续跑；保持 'working'）
 */
export function noteFlowSettled(
  sessionId: string,
  sessionStore: SessionStoreLite,
  aborted: boolean,
  pausedOnPurpose: boolean,
): void {
  const meta = sessionStore.getSessionMeta(sessionId);
  if (meta?.origin !== 'hosted') return;
  if (aborted) {
    sessionStore.updateSessionMeta(sessionId, { workStatus: 'failed' });
  } else if (!pausedOnPurpose) {
    sessionStore.updateSessionMeta(sessionId, { workStatus: 'completed' });
  }
  // pausedOnPurpose 时 workStatus 保持 'working'（软暂停允许续跑，不是终态）
}

/**
 * 用户主动停止 Worker → workStatus='failed'
 *
 * 触发时机：宿主 onUserStopped 回调（用户点了停止按钮）。
 * 已 failed 的会话跳过更新（幂等）。
 */
export function noteUserStopped(sessionId: string, sessionStore: SessionStoreLite): void {
  const meta = sessionStore.getSessionMeta(sessionId);
  if (meta?.origin !== 'hosted') return;
  if (meta.workStatus === 'failed') return; // 幂等
  sessionStore.updateSessionMeta(sessionId, { workStatus: 'failed' });
}

/**
 * 同步异常 → workStatus='failed'
 *
 * 触发时机：runFlow 外层 try/catch 捕获到同步抛错。
 * 已 failed 的会话跳过更新（幂等）。
 */
export function noteSyncError(sessionId: string, sessionStore: SessionStoreLite): void {
  const meta = sessionStore.getSessionMeta(sessionId);
  if (meta?.origin !== 'hosted') return;
  if (meta.workStatus === 'failed') return; // 幂等
  sessionStore.updateSessionMeta(sessionId, { workStatus: 'failed' });
}
