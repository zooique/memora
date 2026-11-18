/**
 * 「打开工作台」命令（命令面板 + 助手形态输入区按钮共用同一条入口；标题栏不提供按钮、自助形态无此入口）
 *
 * 解析「看哪一条座位」的三种实时档，全部基于既有事实（本进程的托管装配表）：
 *   ① 当前聊天会话是托管会话 → 就是它；
 *   ② 本进程恰有一条托管会话 → 用它；
 *   ③ 多条 → QuickPick 让用户选（不做「猜一个」的默认值）。
 *
 * 本进程一条托管会话都没有时（多为重启后：mode 不落盘、装配表为空），**不再直接拒绝**：
 * 改读持久历史里的托管来源会话（`SessionMeta.origin === 'hosted'`），以只读方式重建工作台。
 * 这一档还要按**事件来源**再分一次（真机：只收回托管、没重启，却被写成「重启后按历史重建」）：
 *   - 当前仍有代理在驱动它 ⇒ 有实时事实，按 `live`；
 *   - 本进程登记过这条会话、它现在又不归代理 ⇒ 座位是被**收回**的；
 *   - 本进程从没登记过 ⇒ 才是「重开窗口后按历史重建」。
 * 后两种都说「当前没有实时驱动方」，但来源不同，不能共用一句话。这仍是读既有事实，
 * 不新增持久化、不猜一个实时座位出来。
 *
 * 边界：本命令只负责选座位与开面板；座位身份、状态与清单全由工作台面板按既有
 * 事实现场读取（命令不缓存、不落盘、不新增状态）。
 */
import * as vscode from 'vscode';
import type { MemoraChatViewProvider } from '../../webview/panels/chatPanel.js';
import type { MemoraWorkbenchPanel } from '../../webview/panels/workbenchPanel.js';
import type { SessionModeStore } from '../host/sessionModeStore.js';
import type { HostSessionStore } from '../host/sessionStore.js';
import type { WorkbenchSeatSource } from '../../shared/workbenchDto.js';
import { sessionDisplayTitle } from '../host/sessionTitle.js';
// 错误文案归一（与面板通知同源，不另写一套截断规则）
import { toNoticeText } from '../host/noticeText.js';

/** 命令依赖（全部为既有单例） */
export interface OpenWorkbenchDeps {
  /** 聊天面板（读当前会话） */
  chatProvider: MemoraChatViewProvider;
  /** 工作台面板（打开 / 改绑） */
  workbench: MemoraWorkbenchPanel;
  /** 会话模式表（只读：哪些会话按托管装配） */
  sessionModes: SessionModeStore;
  /** 会话存储（QuickPick 展示标题 / 历史候选） */
  sessionStore: HostSessionStore;
}

/** 解析出的座位（会话 + 来源） */
interface SeatTarget {
  /** 座位会话 id */
  sessionId: string;
  /** 来源档（三档语义见 `WorkbenchSeatSource` 注释，勿在此另写一套） */
  source: WorkbenchSeatSource;
}

/**
 * 命令实现：解析座位并打开工作台
 *
 * @param deps 既有单例依赖
 */
export async function openWorkbench(deps: OpenWorkbenchDeps): Promise<void> {
  const target = await resolveSeat(deps);
  if (!target) return;
  deps.workbench.open(target.sessionId, { seatSource: target.source });
}

/**
 * 解析座位会话
 *
 * 先按本进程托管表解析实时座位；表为空时退到持久历史里的托管来源会话，
 * 以只读重建方式打开（不再用「当前没有代理」把入口整个关掉）。
 *
 * @param deps 既有单例依赖
 * @returns 座位（无任何可读记录 / 用户取消时为 undefined）
 */
async function resolveSeat(deps: OpenWorkbenchDeps): Promise<SeatTarget | undefined> {
  // ① 当前显示会话就是托管会话：入口最自然的语义
  const current = deps.chatProvider.getCurrentSessionId();
  if (current && deps.sessionModes.isManaged(current)) {
    return { sessionId: current, source: liveSeatSource(deps, current) };
  }

  const managed = deps.sessionModes.listManagedSessionIds();
  // ② 唯一一条：直接打开
  if (managed.length === 1) {
    return { sessionId: managed[0], source: liveSeatSource(deps, managed[0]) };
  }
  // ③ 多条：让用户选（标题取与历史列表同一口径；id 作描述便于排错）
  if (managed.length > 1) {
    const picked = await pickSession(
      deps,
      managed,
      vscode.l10n.t('Choose the agent session to inspect'),
    );
    return picked ? { sessionId: picked, source: liveSeatSource(deps, picked) } : undefined;
  }

  // ④ 本进程托管表为空（重启后 mode 不落盘）：从持久历史里找托管来源会话。
  //    只读重建，不把「历史读得到」说成「没有」。按 updatedAt 降序，最近的在最前。
  const historical = deps.sessionStore
    .listSessionMetas()
    .filter((meta) => meta.origin === 'hosted')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (historical.length === 0) {
    // 实时与历史都没有任何托管记录：如实说没有，不打开一个空面板假装有
    void vscode.window.showInformationMessage(
      vscode.l10n.t('No hosted session was found in the history'),
    );
    return undefined;
  }
  // 当前显示会话恰是托管来源会话：优先沿用它，少一次选择
  if (current && historical.some((meta) => meta.sessionId === current)) {
    return { sessionId: current, source: historicalSeatSource(deps, current) };
  }
  if (historical.length === 1) {
    return {
      sessionId: historical[0].sessionId,
      source: historicalSeatSource(deps, historical[0].sessionId),
    };
  }
  const picked = await pickSession(
    deps,
    historical.map((meta) => meta.sessionId),
    vscode.l10n.t('Choose the hosted session to inspect from history'),
  );
  return picked ? { sessionId: picked, source: historicalSeatSource(deps, picked) } : undefined;
}

/**
 * 实时托管座位的来源档：恢复来的座位仍是 managed，但工作台要能看见「这是重启恢复的」
 *
 * 不加这一层，`isManaged` 就会把恢复座位一律说成 live（`orchestrator.managed` 为真 ⇒
 * 工作台那一行直接隐藏），用户得不到任何可见标记——而恢复这件事恰恰需要被看见一次。
 *
 * @param deps 既有单例依赖
 * @param sessionId 托管座位
 * @returns `restored`（本进程从磁盘恢复的）或 `live`（用户本次点开 / 一直开着的）
 */
function liveSeatSource(deps: OpenWorkbenchDeps, sessionId: string): WorkbenchSeatSource {
  return deps.sessionModes.isRestored(sessionId) ? 'restored' : 'live';
}

/**
 * 给「历史档」的候选再判一次事件来源（实时驱动 / 恢复 / 收回 / 重启重建）
 *
 * 判据全部读既有容器，不新增状态：
 *   - `isAgentDriven(sid)` = 现在仍有代理在驱动它（这类有**实时事实**，按 `live` 处理：
 *     它没被收回，也就不能说「当前没有实时驱动方」）；
 *   - `isRestored(sid)` = 本进程从持久化状态恢复了这条座位（有调度权、无驱动方）。
 *     它与「用户刚收回」在 `has()` 上无法区分，必须单独一档；
 *   - `has(sid)` = 本进程写过这条会话的 mode（收回会写 `'self'`；重启后 Map 为空）；
 *   - 都没命中 = 本进程第一次见到它 ⇒ 重开窗口后按历史重建。
 *
 * @param deps 既有单例依赖
 * @param sessionId 候选会话
 * @returns 座位来源档（`live` / `restored` / `revoked` / `history`）
 */
function historicalSeatSource(deps: OpenWorkbenchDeps, sessionId: string): WorkbenchSeatSource {
  return seatSourceForSession(deps.sessionModes, sessionId);
}

/**
 * 座位来源档 resolver（工作台命令与助手页内嵌抽屉共用的唯一判据）
 *
 * 判据全部读既有容器，不新增状态：
 *   - `isAgentDriven(sid)` = 现在仍有代理在驱动它（有实时事实 ⇒ live）；
 *   - `isRestored(sid)` = 本进程从持久化状态恢复了这条座位（有调度权、无驱动方，
 *     必须排在 has() 之前，否则被说成「已收回」）；
 *   - `has(sid)` = 本进程写过 mode（用户刚收回 ⇒ revoked）；
 *   - 都没命中 = 本进程第一次见到 ⇒ 重开窗口后按历史重建（history）。
 *
 * 抽屉曾固定传 `live`（INLINE-WORKBENCH-1），`filtersByLiveDriver('live')` 会滤掉
 * 没有实时驱动方的 jobs ⇒ 重启恢复场景独立工作台有清单、抽屉却空。抽成单点后
 * 两条入口同档，杜绝第二套座位判据。
 */
export function seatSourceForSession(
  sessionModes: Pick<SessionModeStore, 'isAgentDriven' | 'isRestored' | 'has'>,
  sessionId: string,
): WorkbenchSeatSource {
  if (sessionModes.isAgentDriven(sessionId)) return 'live';
  if (sessionModes.isRestored(sessionId)) return 'restored';
  if (sessionModes.has(sessionId)) return 'revoked';
  return 'history';
}

/**
 * 让用户从多条候选里选一条
 *
 * 标题取与历史列表同一口径（`sessionDisplayTitle`），会话 id 作描述便于排错；
 * 用户取消返回 undefined（不猜一个默认值）。
 *
 * @param deps 既有单例依赖
 * @param sessionIds 候选会话 id（按期望顺序）
 * @param placeHolder QuickPick 提示语
 * @returns 选中的会话 id；取消时为 undefined
 */
async function pickSession(
  deps: OpenWorkbenchDeps,
  sessionIds: readonly string[],
  placeHolder: string,
): Promise<string | undefined> {
  const picked = await vscode.window.showQuickPick(
    sessionIds.map((sessionId) => ({
      label: sessionDisplayTitle(
        sessionId,
        deps.sessionStore.getSessionMeta(sessionId),
        vscode.l10n,
      ),
      description: sessionId,
      sessionId,
    })),
    { placeHolder },
  );
  return picked?.sessionId;
}

/**
 * 注册命令（extension.ts 只留一行接线）
 *
 * @param context 扩展上下文（命令随订阅释放）
 * @param deps 既有单例依赖
 */
export function registerOpenWorkbenchCommand(
  context: vscode.ExtensionContext,
  deps: OpenWorkbenchDeps,
): void {
  context.subscriptions.push(
    // 失败必须可见：点入口与走命令面板共用本命令，任何一环抛错（选座 / 重建历史 / 建面板）
    // 都不能只留在 rejection 里——真机验收里那表现为「点了没反应」，用户只能改走命令面板
    vscode.commands.registerCommand('memora.openWorkbench', async () => {
      try {
        await openWorkbench(deps);
      } catch (err) {
        void vscode.window.showErrorMessage(
          vscode.l10n.t('Failed to open the workbench: {0}', toNoticeText(err)),
        );
      }
    }),
  );
}
