/**
 * 对话面板 · 侧栏形态域（自助 ⇄ 助手）
 *
 * 形态是**界面的一个维度**，不是会话属性：它决定输入区长什么样（占位文字 / 底色 / 图标 /
 * 上方小字条 / 只留发送键），也决定「切进来时该看哪条会话」。会话身份仍由 `SessionMode`
 * 描述，两者不同源、不互相写入。
 *
 * 三条纪律（与 `SessionModeStore` 同源）：
 * - **不落盘**：重启一律回 `self`（用户拍板：形态不记住）；
 * - **不记住也不推断**：webview 只显示宿主下发的 `ui_form`，自己不记；
 * - **形态与会话的接线只有这里一处**：进助手自动换会话、回自助还原位置，别在命令层再写一遍。
 *
 * 为什么外置：`chatPanel.ts` 已贴 max-lines `只降不升` 基线，且这块是「一组状态 + 一条
 * 换会话链路」的自足域（与 `chatRunControlOps` / `chatSessionNavOps` 同型）。
 */
import * as vscode from 'vscode';
import type { ExtensionToWebviewMessage, UiForm } from '../../shared/protocol.js';
import type { SessionMode } from '../../extension/host/sessionModeStore.js';

/**
 * 当前侧栏形态的 context key
 *
 * 消费方 = `package.json#contributes.menus.view/title` 的两条互斥菜单项（形态切换按钮）。
 * 取值只有 `self` / `assistant`，写入点两处且同源：本模块 `set` 时写、命令注册时按
 * `chatProvider.getUiForm()` 播种一次（后者只为「命令注册早于任何一次切换」这一时刻）。
 */
export const UI_FORM_CONTEXT_KEY = 'memora.form';

/** 形态域注入面（唯一构造点 = 面板字段初始化处；全部为延迟闭包，不缓存实例） */
export interface AssistantFormOpsDeps {
  /** 向 webview 投递协议消息（面板 `post` 单点） */
  post: (msg: ExtensionToWebviewMessage) => void;
  /** 当前显示会话 id（草稿期为空串） */
  currentSessionId: () => string;
  /** 是否草稿态（草稿没有会话 id，位置要按「草稿」记而不是按 id 记） */
  isDraft: () => boolean;
  /** 某会话是否以托管身份装配（判据与工作台 / 停止暂停同一份） */
  isManaged: (sessionId: string) => boolean;
  /**
   * 某会话当前是否由代理支配（托管座位 ∪ 代理驱动；与收回 / 停止同一判据）
   *
   * 只服务「发送当口的归属提示」：形态说「你在跟助手说话」，而归属已不归助手时，
   * 必须当场说清，不能等用户自己发现消息没人接。
   */
  isAgentControlled: (sessionId: string) => boolean;
  /** 进程内有调度权的会话 id（按登记顺序） */
  listManagedSessionIds: () => string[];
  /** 切入指定会话（锁 / 装配 / 回放全由既有链路裁决） */
  switchToSession: (sessionId: string) => Promise<void>;
  /** 进入草稿态（`mode` 决定首句落会话时的身份） */
  newSessionFromCommand: (mode: SessionMode) => Promise<void>;
  /** 写 VS Code context key（菜单 `when` 判据） */
  setContext: (form: UiForm) => void;
}

/** 形态域外露面 */
export interface AssistantFormOps {
  /** 当前形态（`extension` 命令与渲染入口的唯一读取口） */
  current(): UiForm;
  /** 切换形态（唯一写点） */
  set(form: UiForm): Promise<void>;
  /** 就地回自助形态（不换会话；供「收回本会话」这类就地改变归属的动作使用） */
  forceSelf(): void;
  /** 发送当口的归属提示（助手形态 × 会话已不归助手）；不拦发送、只如实说明 */
  warnIfOwnershipLost(): void;
  /** 视图重建 / webview 就绪时补推当前形态（只发消息，不换会话） */
  repush(): void;
}

/**
 * 构造形态域
 *
 * @param deps 面板提供的延迟闭包
 */
export function createAssistantFormOps(deps: AssistantFormOpsDeps): AssistantFormOps {
  /** 当前形态（`self` = 启动即自助；不落盘，进程重启即回本值） */
  let form: UiForm = 'self';
  /**
   * 切进助手形态前自助面停留的位置
   *
   * `undefined` = 没有记录（从未切过形态）；空串 = 当时在草稿页；其余 = 会话 id。
   * 切回自助时**只还原一次**（还原后清空），避免下次进助手沿用上上次的位置。
   */
  let returnTo: string | undefined;

  /** 状态 → 界面 / 菜单：一次写 state 必须同时落这三处，漏任何一处都是静默不一致 */
  function apply(next: UiForm): void {
    form = next;
    deps.setContext(next);
    deps.post({ type: 'ui_form', form: next });
  }

  /**
   * 进助手形态后的会话接线
   *
   * 顺序即优先级：当前会话已是助手会话 → 不动（不重放，别把正在看的对话刷一遍）；
   * 否则用进程内已有的助手会话（多条取**最后登记**的一条：点「助手」是要跟助手说话，
   * 弹框选会话会把一次点击变成两次，工作台入口已经承担「看哪条」）；一条都没有 →
   * 进托管草稿（等用户说第一句再落会话，不凭空造一条空会话）。
   */
  async function enterAssistantSession(): Promise<void> {
    const current = deps.currentSessionId();
    if (current && deps.isManaged(current)) return;
    const managed = deps.listManagedSessionIds();
    if (managed.length > 0) {
      await deps.switchToSession(managed[managed.length - 1]);
      return;
    }
    await deps.newSessionFromCommand('managed');
  }

  /**
   * 回自助形态后的会话接线
   *
   * 还原一次即清记录；记录里那条会话已被删 / 已不可达时**不兜底乱跳**——
   * `switchToSession` 的失败由既有链路提示，用户仍可自己从历史里挑。
   */
  async function restoreSelfPosition(): Promise<void> {
    const back = returnTo;
    returnTo = undefined;
    if (back === undefined) return;
    if (back === '') {
      await deps.newSessionFromCommand('self');
      return;
    }
    if (back === deps.currentSessionId()) return;
    await deps.switchToSession(back);
  }

  return {
    current: () => form,
    repush: () => deps.post({ type: 'ui_form', form }),
    /**
     * 就地回自助形态（不换会话）
     *
     * 为什么**不**走 `set('self')`：那条路会 `restoreSelfPosition()` 跳回进助手前的位置——
     * 而收回本会话之后，用户要的正是眼前这一条（它刚归自己），跳走等于把刚收回的会话留在身后。
     * 记录的自助位置同时作废：形态此刻已经是自助，下次进助手应重新记当前位置。
     */
    forceSelf(): void {
      returnTo = undefined;
      // 同形态 = 无操作（幂等：重复收回不重复下发 ui_form）
      if (form === 'self') return;
      apply('self');
    },
    /**
     * 发送当口的归属提示（助手形态 × 当前会话已不归助手）
     *
     * 真机验收：收回托管后侧栏仍是助手外观，用户发出的消息只落进会话、没有任何说明。
     * 这里补一条**当场可见**的事实（形态说「跟助手说话」，归属却已收走），并写清恢复入口。
     *
     * 刻意**不拦发送**：这条消息会按自助会话正常处理，拦下只会把用户的话吞掉；
     * 这里解决的是「没人告诉他会发生什么」，不是「不许他发」。
     */
    warnIfOwnershipLost(): void {
      // 只有助手形态才存在「以为在跟助手说话」的误解；自助形态下这条消息本来就是普通对话
      if (form !== 'assistant') return;
      const sid = deps.currentSessionId();
      if (!sid || deps.isAgentControlled(sid)) return;
      deps.post({
        type: 'notice',
        level: 'info',
        message: vscode.l10n.t(
          'Memora: this session was taken back from the assistant, so the assistant will not handle your message; it is sent as a self-service chat. To have the assistant take over again, click "+" above to create a new session (in assistant form a new session goes to the assistant), or click "Back to Chatting Myself" in the view title bar and then "Switch to Assistant".',
        ),
      });
    },
    async set(next: UiForm): Promise<void> {
      // 同形态重复点击 = 无操作（不重放会话、不刷界面）
      if (next === form) return;
      if (next === 'assistant') {
        // 先记位置再切形态：切形态本身会换会话，晚记就记成了助手会话
        returnTo = deps.isDraft() ? '' : deps.currentSessionId();
        apply(next);
        await enterAssistantSession();
        return;
      }
      apply(next);
      await restoreSelfPosition();
    },
  };
}
