/**
 * 草稿会话态 —— 标题条「＋」后、首次发送前的空白页（用户拍板 2026-11-07）
 *
 * 行为：点「＋」不再立刻落一条空会话记录，先显示干净空白页，**只有第一次真正发送内容时
 * 才创建会话**（复用面板既有的唯一建会话路径，不新造第二条）。
 *
 * 🔴 红线：草稿**不是会话**，只存在于面板内存（本控制器实例由面板持有）：
 *   - 没有 sessionId、不写 sessionStore、不进历史列表、不占会话锁、不装配 Agent；
 *   - 面板销毁 / 进程重启后自然消失；切到别的会话即丢弃（没有「切回草稿」）；
 *   - 活跃度快照天然不含草稿（无 id 可入表）。
 * 角色切换在草稿期不可用（降级）：为没有 id / Agent 的草稿造「角色目录 + 待装配队列」
 * 等于第二份会话状态，故拒绝（判据在设置面板 `activateRole`）。
 *
 * 为什么外置：`chatPanel.ts` 贴 eslint `max-lines` 只降不升基线；本域是「一个布尔标记 +
 * 纯投递序列」，无业务裁决，符合 helpers 落点纪律（判据仍归面板，本模块只做投影）。
 */
import { formatDateKey } from '@zooique/memora';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';

/** 草稿页标题：草稿没有会话 id ⇒ 没有创建时间可言，恒显示「新会话」（不带时间） */
export const DRAFT_SESSION_TITLE = '新会话';

/** 草稿控制器依赖：全部由面板注入，模块自身不反向持有面板实例 */
export interface DraftSessionDeps {
  /** 投递到 webview（走面板既有 post，含后台流闸） */
  post: (msg: ExtensionToWebviewMessage) => void;
  /** 只清内存会话指针，**不触**「上次停留会话」（草稿不该被记住） */
  clearSessionId: () => void;
  /** 确认框前景会话置空：上一个会话的待确认项不得在草稿页弹出 */
  setConfirmForeground: (sessionId: string) => void;
  pushSessionList: () => void;
  refreshActivity: () => void;
  /** 面板唯一的建会话路径（拿锁 / 装配 / 回放全在它里面） */
  createSession: (sessionId: string) => Promise<boolean>;
}

/**
 * 草稿会话控制器
 *
 * 单一职责：持有「当前空值态是否为用户主动新建的草稿」这一个标记，并在进出草稿时
 * 把屏上投影归零 / 重建。**不解释为第二份会话状态**：会话是否存在仍只由面板的
 * `_currentSessionId` 表示（草稿期恒为 ''）。
 */
export class DraftSessionController {
  /** 草稿态标记（面板内存态；初始值由面板按「启动时有无历史会话」给出） */
  private _draft: boolean;

  constructor(
    private readonly deps: DraftSessionDeps,
    initial: boolean,
  ) {
    this._draft = initial;
  }

  /** 是否处于草稿态（给 extension / 设置面板：草稿期不得装配 Agent、不得写会话 meta） */
  get isDraft(): boolean {
    return this._draft;
  }

  /** 有会话 id ⇒ 必然已离开草稿（唯一退出写点） */
  exit(): void {
    this._draft = false;
  }

  /**
   * 进入草稿（标题条「＋」/ 工作区无任何会话时的启动兜底）
   *
   * 只做「展示面归零」，**不产生任何会话状态**。
   */
  enter(): void {
    this._draft = true;
    this.deps.clearSessionId();
    this.deps.setConfirmForeground('');
    this.project(false);
  }

  /**
   * 重建草稿页（webview 刷新而面板对象存活）
   *
   * @param historyLoaded 历史回放收尾信号：ready 链路需要（replaySession），
   *        切换会话的防御分支不需要
   */
  replay(historyLoaded = false): void {
    this.project(historyLoaded);
  }

  /**
   * 草稿态首次发送：真正创建会话（全流程唯一的会话创建点）
   *
   * 失败（锁被占等）则留在草稿并重推草稿页——绝不恢复「暂无会话，请点＋」的死态
   * （可见 notice 已由面板的 createSession 弹出）。
   *
   * @returns true = 会话已就绪，可继续走发送流程；false = 留在草稿
   */
  async flush(): Promise<boolean> {
    const sessionId = `${formatDateKey(new Date())}-s${Date.now().toString(36)}`;
    const created = await this.deps.createSession(sessionId);
    if (!created) this.project(false);
    return created;
  }

  /** 草稿页投影（进入 / 重建 / 建会话失败回滚共用同一序列，避免三种空白页漂移） */
  private project(historyLoaded: boolean): void {
    this.deps.post({ type: 'clear_ok' });
    // draft: true = 草稿页的**唯一标识**，承担两件事：
    //   ① webview 禁用改名笔（草稿没有可改名的会话）；
    //   ② 会话级投影归零信号——webview 据此隐藏能力徽章、把上下文占用环复位为空态
    //     （无会话 ⇒ 不得保留上一会话的能力面与占用；不为此新增消息类型）
    this.deps.post({ type: 'session_title', title: DRAFT_SESSION_TITLE, draft: true });
    // 草稿没有 Agent ⇒ 角色 / 后台任务 / 看板投影一律空（看板由 clear_ok 的 DOM 复位承担），
    // 不把上一个会话的投影留在屏上
    this.deps.post({ type: 'chat_role_pack', rolePack: '', traits: undefined });
    this.deps.post({ type: 'chat_role_packs', packs: [], activeName: '' });
    this.deps.post({ type: 'background_tasks', items: [] });
    this.deps.pushSessionList();
    this.deps.refreshActivity();
    if (historyLoaded) this.deps.post({ type: 'history_loaded' });
  }
}
