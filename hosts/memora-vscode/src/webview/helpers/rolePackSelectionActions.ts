/**
 * 角色选择动作（草稿期选择 / 设为默认）——设置面板的角色子视图动作层
 *
 * 从 settingsPanel 外置的两个动作，理由有二：
 *   - settingsPanel 贴 max-lines `只降不升`基线，「取值校验 + 提示文案 + 写盘」不该再往里堆；
 *   - 两个动作共用同一套校验链（已登记实例的 `rolePackManager` → 存在性 → 提示），
 *     放在一处才能保证「不存在就拒绝」的判据与文案只有一份。
 *
 * 语义边界（两个动作**互不代替**）：
 *   - {@link selectDraftRolePack}：只写草稿内存，落盘随建会话的 meta 一次完成；
 *   - {@link setDefaultRolePack}：只写用户级配置 `memora.defaultRolePack`，**不碰任何会话 meta**，
 *     只影响此后新建会话（默认值在建会话时快照进 meta，改它不追溯已有会话）。
 */
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';
import { writeErrorText, writeSetting } from '../../extension/settingsWrite.js';

/** 角色包管理器的最小读面（只用到存在性查询；不引入 Agent 全类型） */
interface RolePackDirectory {
  get?(packName: string): unknown;
}

/** 两个动作共用的依赖（面板注入；本模块不持有任何状态） */
export interface RolePackActionDeps {
  /** 已登记实例的角色目录（只读、不装配；null/undefined = 无可校验目录） */
  peekRolePackManager(): RolePackDirectory | null | undefined;
  /** 发送一条 notice（与面板同一投递通道） */
  post(message: ExtensionToWebviewMessage): void;
  /** 动作完成后重推角色视图（`roles_loaded` 的单一刷新面） */
  reloadRoles(): Promise<void>;
}

/** 草稿期选择的额外依赖（读写桥由面板在装配时注入） */
export interface DraftRolePackActionDeps extends RolePackActionDeps {
  /** 草稿读写桥是否就绪（false = 没有记录选择的地方，必须如实失败） */
  hasDraftBridge: boolean;
  /** 把选择写进草稿内存（不落盘） */
  setDraftRolePackName(name: string): void;
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
  // 旧实现短路后仍 return true，是「报成功但什么都没发生」的静默谎报。
  if (!deps.hasDraftBridge) {
    deps.post({
      type: 'notice',
      level: 'error',
      message: '草稿期角色切换通道未就绪，无法记录选择，请稍后重试',
    });
    return false;
  }
  const rpm = deps.peekRolePackManager();
  if (!rpm) {
    deps.post({
      type: 'notice',
      level: 'error',
      message: '草稿期暂无可校验的角色目录（尚未装配任何会话），请先发送一条内容后再选择',
    });
    return false;
  }
  if (!rpm.get?.(name)) {
    deps.post({ type: 'notice', level: 'error', message: `角色包不存在：${name}` });
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
 * 校验必须在写入前：目录真源 = 已登记实例的 `rolePackManager`（与装配同一份目录，不另写扫描器）；
 * 草稿期若还没有任何已登记实例（角色列表此时同样为空），直接拒绝——避免写入不可解析的名字。
 *
 * @param deps 面板注入的依赖
 * @param name 角色包名；空串 = 取消默认（恢复内核兜底包）
 * @returns 是否写入成功
 */
export async function setDefaultRolePack(deps: RolePackActionDeps, name: string): Promise<boolean> {
  const rpm = deps.peekRolePackManager();
  if (!rpm) {
    deps.post({
      type: 'notice',
      level: 'error',
      message: '当前没有可校验的角色目录：请先在对话中打开任一会话，再设置默认角色',
    });
    return false;
  }
  if (name && !rpm.get?.(name)) {
    deps.post({ type: 'notice', level: 'error', message: `角色包不存在：${name}` });
    return false;
  }
  const written = await writeSetting('defaultRolePack', name);
  if (!written.ok) {
    deps.post({
      type: 'notice',
      level: 'error',
      message: writeErrorText('默认角色包设置', written),
    });
    return false;
  }
  deps.post({
    type: 'notice',
    level: 'info',
    message: name
      ? `已将「${name}」设为新建会话的默认角色（不影响已有会话）`
      : '已取消默认角色：新建会话将使用系统兜底角色',
  });
  await deps.reloadRoles();
  return true;
}
