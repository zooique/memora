/**
 * 侧栏形态 + 座位的**启动恢复**（唯一入口）
 *
 * 背景（2026-11-15 用户改口径）：「关闭时用的是托管形态就保持托管，重启后照旧」。
 * 此前形态是纯进程内状态（见 `assistantFormOps` 头注释），重启一律回 `self`。
 *
 * 四条纪律，别在这四处之外扩张：
 * - **持久值只当种子**：本文件只在启动时读一次 `workspaceState`，运行期真源仍是
 *   `assistantFormOps` 的内存 `form`；回写由 `assistantFormOps` 单向发出（`persistForm`）。
 * - **形态与座位成对**：助手形态的全部含义是「我在跟助手说话」⇒ 必须同时把座位写回
 *   `SessionModeStore`。只恢复外观不恢复座位，会重演「界面说托管、实际没人接」的旧病灶
 *   （第一轮真机验收修的就是它）。
 * - 🔴 **恢复只读**（2026-11-15 真机第二次同类事故后定）：启动恢复**不改当前显示的会话 /
 *   页面位置、不写任何持久层、不删任何键**。恢复期做副作用已经出过两次事：一次是整写会话
 *   文件撞 fail-closed 锁（扩展激活失败），一次是恢复时切走用户正在看的空白页、顺带把
 *   `composerDraftPage` 与空白页草稿清掉（数据静默丢失）。两件都不是「恢复」该干的事。
 *   所以这里只做**只读判定 + 内存播种**；要导航，等恢复返回之后由用户动作或上层策略另起一步。
 * - **不猜**：座位会话已删除 ⇒ 静默回落自助，不降到别的会话上赌，也不纠正磁盘
 *   （纠正也是写盘；下次启动同样只读判定一次，代价是多读一个键，不是多一次坏恢复）。
 *
 * 恢复的分支（用户口径 A「页面优先」：重启后回到关窗时看的那个页面）：
 *   ① 座位还在 → 把座位写回 `SessionModeStore` 并播种助手形态（**不切页面**）；
 *      座位已删 → 不登记、不赌别的会话、也不纠正磁盘（纠正也是写盘）。
 *   ② 当前页面是空白页（无当前会话）→ 把草稿身份对齐成托管草稿（只定「第一句发给谁」；
 *      本来就在空白页，不是切走，也不清空白页草稿与标记）。
 *      「上次有座位」与「上次停在空白页」可以同时成立：座位照旧登记，当前视图仍是空白页。
 *   ③ 有会话但座位不可用 → 只认**托管出生**的那条（草稿首句已落盘的情形），自助出生的一律回自助。
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
  /** 把座位写回 `SessionModeStore` 并打「恢复」标签（纯内存容器，不落盘、不换页面） */
  restoreSeat: (sessionId: string) => void;
  /** 进托管草稿（与点「助手」时「一条托管会话都没有」的分支同源） */
  enterManagedDraft: () => void;
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
  // 自助 = 面板的默认值：不需要播种（不写盘、不纠正磁盘——恢复只读）
  if (!saved || saved.form === 'self') return;

  const seat = saved.seatSessionId;
  // ① 座位还在 ⇒ 只登记座位（纯内存容器）；**不切页面**（用户口径 A：页面优先）
  const seatOk = seat !== '' && deps.sessionFacts(seat).resolvable;
  if (seatOk) {
    deps.seedForm('assistant');
    deps.restoreSeat(seat);
  }

  // ② 页面是空白页（无当前会话）⇒ 把草稿身份对齐成托管草稿：只定「第一句发给谁」，
  //    不切页面（本来就在空白页）、不清空白页草稿与标记
  if (!deps.currentSessionId()) {
    deps.seedForm('assistant');
    deps.enterManagedDraft();
    return;
  }

  // ③ 有会话但没有可用座位 ⇒ 只有托管出生的那条才认（自助出生的一律回自助）
  if (seatOk) return;
  const facts = deps.sessionFacts(deps.currentSessionId());
  if (facts.hostedBorn && facts.resolvable) {
    deps.seedForm('assistant');
    // 登记身份（纯内存）：不登记的话这条会话会被按自助装配，助手工具面当场丢失
    deps.restoreSeat(deps.currentSessionId());
  }
}
