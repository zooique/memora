/**
 * 侧栏形态 + 座位的**启动恢复**（唯一入口）
 *
 * 背景（2026-11-15 用户改口径）：「关闭时用的是托管形态就保持托管，重启后照旧」。
 * 此前形态是纯进程内状态（见 `assistantFormOps` 头注释），重启一律回 `self`。
 *
 * 两条纪律，别在这两处之外扩张：
 * - **持久值只当种子**：本文件只在启动时读一次 `workspaceState`，运行期真源仍是
 *   `assistantFormOps` 的内存 `form`；回写由 `assistantFormOps` 单向发出（`persistForm`）。
 * - **形态与座位成对**：助手形态的全部含义是「我在跟助手说话」⇒ 必须同时把座位写回
 *   `SessionModeStore`。只恢复外观不恢复座位，会重演「界面说托管、实际没人接」的旧病灶
 *   （第一轮真机验收修的就是它）。
 *
 * 恢复的三条分支（每条都写清了「凭什么这么认」）：
 *   ① 有座位且会话还在 → 播种助手形态 + 写回座位 + 打到座位那条会话（用户拍板 O3）；
 *   ② 有座位但会话已删 → **回落自助**并把磁盘纠正成自助（不造新会话、不猜近似的会话）；
 *   ③ 座位为空（关闭时在托管草稿里）→ 没有会话就进托管草稿（与点「助手」同一条路径）；
 *      有会话（草稿首句已落盘）则只认**托管出生**的那条，自助出生的一律回自助。
 *
 * 为什么外置：`chatPanel.ts` 贴着 max-lines 基线（只降不升），面板只留一行调用。
 */
import type * as vscode from 'vscode';
import { UI_FORM_STATE_KEY, type PersistedUiFormState } from '../../shared/constants.js';
import type { UiForm } from '../../shared/protocol.js';

/** 恢复路径需要面板提供的窄面（全部为延迟闭包，构造期不缓存实例） */
export interface UiFormRestoreDeps {
  /** 工作区级持久层（未注入 ⇒ 不恢复；测试 / 嵌入宿主行为与改造前一致） */
  uiState: vscode.Memento | undefined;
  /** 当前显示的会话 id（草稿期为空串） */
  currentSessionId: () => string;
  /** 该会话的两项事实：能否解析出实体 / 出生来源是否托管（一次取全，判据在会话存储） */
  sessionFacts: (sessionId: string) => { resolvable: boolean; hostedBorn: boolean };
  /** 播种形态：只写内存，不换会话、不发消息（见 `AssistantFormOps.seed`） */
  seedForm: (form: UiForm) => void;
  /** 采用某条会话为当前显示会话（面板导航唯一写点） */
  adoptSession: (sessionId: string) => void;
  /** 把座位写回 `SessionModeStore` 并打「恢复」标签 */
  restoreSeat: (sessionId: string) => void;
  /** 进托管草稿（与点「助手」时「一条托管会话都没有」的分支同源） */
  enterManagedDraft: () => void;
  /** 回写持久层（回落自助时必须纠正磁盘，否则每次启动都重演一次坏恢复） */
  persist: (state: PersistedUiFormState) => void;
}

/**
 * 读取持久化的形态状态（脏数据整体回落 `undefined`）
 *
 * 不猜半个值：`form` 非法或缺席一律当「没有存过」，避免把损坏数据解释成托管形态。
 *
 * @param uiState 工作区级持久层
 * @returns 合法状态；无值 / 脏值时为 undefined
 */
export function readPersistedUiForm(
  uiState: vscode.Memento | undefined,
): PersistedUiFormState | undefined {
  const raw = uiState?.get<unknown>(UI_FORM_STATE_KEY);
  if (!raw || typeof raw !== 'object') return undefined;
  const { form, seatSessionId } = raw as Partial<PersistedUiFormState>;
  if (form !== 'assistant' && form !== 'self') return undefined;
  return { form, seatSessionId: typeof seatSessionId === 'string' ? seatSessionId : '' };
}

/**
 * 执行一次启动恢复
 *
 * @param deps 面板窄面
 */
export function restorePersistedUiForm(deps: UiFormRestoreDeps): void {
  const saved = readPersistedUiForm(deps.uiState);
  // 自助 = 面板的默认值：不需要播种、不需要写盘（写一次也是同一个值）
  if (!saved || saved.form === 'self') return;

  if (saved.seatSessionId) {
    if (deps.sessionFacts(saved.seatSessionId).resolvable) {
      bindSeat(deps, saved.seatSessionId);
      return;
    }
    // 座位会话已删除：不降到「最近一条会话」上去赌，回自助并纠正磁盘
    deps.persist({ form: 'self', seatSessionId: '' });
    return;
  }

  const current = deps.currentSessionId();
  if (!current) {
    // 关闭时在托管草稿里：恢复成托管草稿（首句发送才落会话，与原来完全同态）
    deps.seedForm('assistant');
    deps.enterManagedDraft();
    deps.persist({ form: 'assistant', seatSessionId: '' });
    return;
  }
  // 草稿的首句发送过后才有会话：只有托管出生的那条才配当座位，自助出生的一律回自助
  const facts = deps.sessionFacts(current);
  if (facts.hostedBorn && facts.resolvable) {
    bindSeat(deps, current);
    return;
  }
  deps.persist({ form: 'self', seatSessionId: '' });
}

/**
 * 把某条会话绑成恢复的托管座位
 *
 * @param deps 面板窄面
 * @param seat 座位会话 id（已确认可解析）
 */
function bindSeat(deps: UiFormRestoreDeps, seat: string): void {
  deps.seedForm('assistant');
  // 与 O3 拍板一致：形态恢复成助手但当前会话不是座位那条时，切过去
  if (seat !== deps.currentSessionId()) deps.adoptSession(seat);
  deps.restoreSeat(seat);
  deps.persist({ form: 'assistant', seatSessionId: seat });
}
