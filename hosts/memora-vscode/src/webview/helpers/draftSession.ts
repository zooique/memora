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
 * 角色包（2026-11-07 用户否掉初版「草稿期不可切换」后重定）：草稿期**可以显示与切换**，
 * 但只记一个名字（本控制器 `_rolePackName`）——目录复用设置页既有 `roles_loaded`，
 * 落盘复用面板唯一建会话路径里那一次 `updateSessionMeta`（不造第二条写入）。
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
  /**
   * 草稿未选角色时「即将生效」的角色名（每次投影现读，避免设置页改默认后徽章停在旧值）
   *
   * 真源在宿主单点读口 `rolePackDefault.ts`：用户级默认；未设置则投影内核
   * `BUILTIN_FALLBACK_PACK`（装配 §4.1 单链：`builtinFallbackRole ?? 本常量`）。
   * 宿主不得另写默认包名，更不得拿「列表第一个」冒充（那是第二份回落真源）。
   */
  getDefaultRolePackName: () => string;
  /** 面板唯一的建会话路径（拿锁 / 装配 / 回放全在它里面；角色包名随 meta 一次性落盘） */
  createSession: (sessionId: string, rolePackName?: string) => Promise<boolean>;
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

  /** 草稿期用户选择的角色包名（undefined = 未选，投影回落内核兜底包名） */
  private _rolePackName: string | undefined;

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
    // 草稿选择随草稿一起消失：会话一旦建立，角色已落在该会话 meta 上（不把选择带进下一个草稿）
    this._rolePackName = undefined;
  }

  /** 草稿期当前角色名（undefined = 未选；设置页据此高亮「当前」，真实会话不读它） */
  get rolePackName(): string | undefined {
    return this._rolePackName;
  }

  /**
   * 草稿期切换角色包（**只写草稿内存**，不装配、不写盘）
   *
   * 存在性校验归调用方（设置页用已登记实例的 `rolePackManager.get` 同一份内核判据）；
   * 本方法只承接「选中」这一事实并立即刷新徽章投影。
   */
  selectRolePack(name: string): void {
    this._rolePackName = name;
    this.postRolePack();
  }

  /**
   * 进入草稿（标题条「＋」/ 工作区无任何会话时的启动兜底）
   *
   * 只做「展示面归零」，**不产生任何会话状态**。
   */
  enter(): void {
    this._draft = true;
    // 新草稿从「未选」起：不继承上一个会话 / 上一个草稿的角色选择
    this._rolePackName = undefined;
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
    // 角色选择在建会话前一刻捕获：createSession 会把会话 id 写进面板（随即 exit 清空草稿选择）
    const created = await this.deps.createSession(sessionId, this._rolePackName);
    if (!created) this.project(false);
    return created;
  }

  /** 草稿角色徽章投影（进入 / 切换共用，避免两处各拼一次包名） */
  private postRolePack(): void {
    // 未选 ⇒ 用户级默认；未设置则内核 §4.1 兜底包名（括号里才是「即将生效」的真实角色）
    this.deps.post({
      type: 'chat_role_pack',
      rolePack: this._rolePackName ?? this.deps.getDefaultRolePackName(),
      traits: undefined,
    });
  }

  /** 草稿页投影（进入 / 重建 / 建会话失败回滚共用同一序列，避免三种空白页漂移） */
  private project(historyLoaded: boolean): void {
    this.deps.post({ type: 'clear_ok' });
    // draft: true = 草稿页的**唯一标识**，承担两件事：
    //   ① webview 禁用改名笔（草稿没有可改名的会话）；
    //   ② 会话级投影归零信号——webview 据此隐藏能力徽章、把上下文占用环复位为空态
    //     （无会话 ⇒ 不得保留上一会话的能力面与占用；不为此新增消息类型）
    this.deps.post({ type: 'session_title', title: DRAFT_SESSION_TITLE, draft: true });
    // 草稿没有 Agent ⇒ 后台任务 / 看板投影一律空（看板由 clear_ok 的 DOM 复位承担），
    // 不把上一个会话的投影留在屏上；角色徽章例外——草稿期显示「即将生效」的包（见 postRolePack）
    this.postRolePack();
    this.deps.post({ type: 'chat_role_packs', packs: [], activeName: '' });
    this.deps.post({ type: 'background_tasks', items: [] });
    this.deps.pushSessionList();
    this.deps.refreshActivity();
    if (historyLoaded) this.deps.post({ type: 'history_loaded' });
  }
}
