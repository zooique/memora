/**
 * 角色选择动作（草稿期选择 / 设为默认）——设置面板的角色子视图动作层
 *
 * 从 settingsPanel 外置的两个动作，理由有二：
 *   - settingsPanel 贴 max-lines `只降不升`基线，「取值校验 + 提示文案 + 写盘」不该再往里堆；
 *   - 两个动作都做「包名存在性」判断，判据与文案必须各有单一真源，不能一个用这一套、
 *     另一个用另一套（同一判据两份实现 = 两份语义从落笔那天开始漂移）。
 *
 * 语义边界（两个动作**互不代替**）：
 *   - {@link selectDraftRolePack}：只写草稿内存，落盘随建会话的 meta 一次完成；
 *   - {@link setDefaultRolePack}：只写用户级配置 `memora.defaultRolePack`，**不碰任何会话 meta**，
 *     只影响此后新建会话（默认值在建会话时快照进 meta，改它不追溯已有会话）。
 */
import * as vscode from 'vscode';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';
import { writeErrorText, writeSetting } from '../../extension/settingsWrite.js';
import type { RolePackCatalogReader } from '../../extension/host/newSessionRolePack.js';
import { UNVERIFIED_ROLE_PACK_TEXT } from '../../extension/host/sessionRolePack.js';

/** 角色包管理器的最小读面（只用到存在性查询；不引入 Agent 全类型） */
interface RolePackDirectory {
  get?(packName: string): unknown;
}

/** 两个动作共用的投递 / 刷新面（面板注入；本模块不持有任何状态） */
export interface RolePackActionDeps {
  /** 发送一条 notice（与面板同一投递通道） */
  post(message: ExtensionToWebviewMessage): void;
  /** 动作完成后重推角色视图（`roles_loaded` 的单一刷新面） */
  reloadRoles(): Promise<void>;
}

/** 草稿期选择的额外依赖（读写桥由面板在装配时注入） */
export interface DraftRolePackActionDeps extends RolePackActionDeps {
  /**
   * 已登记实例的角色目录（只读、不装配；null/undefined = 无可校验目录）
   *
   * 草稿态没有 Agent 可直接问，且其角色列表本身就是从该实例投影出来的——
   * 无实例时列表为空、用户根本无从选择，故此处保留实例读面（与列表同源）。
   */
  peekRolePackManager(): RolePackDirectory | null | undefined;
  /** 草稿读写桥是否就绪（false = 没有记录选择的地方，必须如实失败） */
  hasDraftBridge: boolean;
  /** 把选择写进草稿内存（不落盘） */
  setDraftRolePackName(name: string): void;
}

/** 设置默认角色的额外依赖（校验真源 = 角色包目录编目，与建会话同一读面） */
export interface DefaultRolePackActionDeps extends RolePackActionDeps {
  /**
   * 角色包目录编目读面（实现见 rolePackCatalog.ts；未注入 = 无法校验）
   *
   * 与建会话同源：冷启动没有任何已装配实例时它照样可读，因此设置页不再有
   * 「请先在对话中打开任一会话」这种与建会话口径不一致的拒绝理由。
   */
  readRolePackCatalog?: RolePackCatalogReader;
}

/**
 * 草稿期角色选择（activateRole 的草稿分支）
 *
 * 存在性判据 = 已登记实例的 `rolePackManager.get`（与真实会话同一条内核目录，宿主不另写）；
 * 只读、不装配。无任何已登记实例时无法校验 ⇒ 如实失败（不允许「先记下、建会话时才炸」）；
 * 读写桥未注入时同理 ⇒ 返回 false（没有记录选择的地方，就不能报成功）。
 *
 * @param deps 面板注入的依赖
 * @param name 角色包名
 * @returns 是否记录成功
 */
export async function selectDraftRolePack(
  deps: DraftRolePackActionDeps,
  name: string,
): Promise<boolean> {
  // 入口先判读写桥：未注入 = 没有地方记录选择，必须如实失败——
  // 否则就是「报成功但什么都没发生」的静默谎报。
  if (!deps.hasDraftBridge) {
    deps.post({
      type: 'notice',
      level: 'error',
      message: vscode.l10n.t(
        'The draft role switching channel is not ready, so the selection cannot be recorded. Please try again later.',
      ),
    });
    return false;
  }
  const rpm = deps.peekRolePackManager();
  if (!rpm) {
    deps.post({
      type: 'notice',
      level: 'error',
      message: vscode.l10n.t(
        'No role pack directory is available to verify in the draft (no session is assembled yet). Send a message first, then choose.',
      ),
    });
    return false;
  }
  if (!rpm.get?.(name)) {
    deps.post({
      type: 'notice',
      level: 'error',
      message: vscode.l10n.t('Role pack not found: {0}', name),
    });
    return false;
  }
  deps.setDraftRolePackName(name);
  // 草稿没有 Agent ⇒ rolePackSwitched 不会来；显式重推既有 roles_loaded 刷新「当前」高亮
  await deps.reloadRoles();
  return true;
}

/**
 * 设置 / 取消「新建会话默认角色包」（只写用户级配置，不碰任何会话 meta）
 *
 * 校验真源 = 角色包目录编目（`RolePackCatalogReader`，与建会话 `decideNewSessionRolePack`
 * 同一读面）：冷启动无已装配实例同样可校验，不再有「先打开任一会话」这条与建会话口径
 * 不一致的拒绝理由。
 *
 * 三个出口（文案不许合并）：
 *   ① 列表读不到 ⇒ 不写，报「无法校验角色包列表」（中性措辞，不指定原因）；
 *   ② 名单里没有该包 ⇒ 不写，报「角色包不存在」；
 *   ③ 校验通过 ⇒ 写入。
 * 空串 = 取消默认，**无需校验**（没有名字要判存在性，不该被「列表读不到」挡住）。
 *
 * @param deps 面板注入的依赖
 * @param name 角色包名；空串 = 取消默认（恢复内核兜底包）
 * @returns 是否写入成功
 */
export async function setDefaultRolePack(
  deps: DefaultRolePackActionDeps,
  name: string,
): Promise<boolean> {
  if (name) {
    // 未注入编目视同「读不到」：绝不因「没接线」而乐观放行一个不可解析的名字
    const catalog = deps.readRolePackCatalog ? await deps.readRolePackCatalog() : null;
    if (!catalog) {
      deps.post({
        type: 'notice',
        level: 'error',
        message: vscode.l10n.t(
          '{0}; the default role "{1}" was not written',
          UNVERIFIED_ROLE_PACK_TEXT,
          name,
        ),
      });
      return false;
    }
    if (!catalog.has(name)) {
      deps.post({
        type: 'notice',
        level: 'error',
        message: vscode.l10n.t('Role pack not found: {0}', name),
      });
      return false;
    }
  }
  const written = await writeSetting('defaultRolePack', name);
  if (!written.ok) {
    deps.post({
      type: 'notice',
      level: 'error',
      message: writeErrorText(vscode.l10n.t('Default role pack setting'), written),
    });
    return false;
  }
  deps.post({
    type: 'notice',
    level: 'info',
    message: name
      ? vscode.l10n.t(
          '"{0}" is now the default role for new sessions (existing sessions are unaffected)',
          name,
        )
      : vscode.l10n.t('Default role cleared: new sessions will use the system fallback role'),
  });
  await deps.reloadRoles();
  return true;
}
