/**
 * 用户级数据初始化（恢复首装态）
 *
 * 职责：一键清空插件宿主的全部用户级存储，让插件回到第一次使用的状态；
 * 项目级数据（工作区 .memora/ 的记忆与会话、工作区 settings.json）一字节不碰
 * ——记忆与会话是项目的一部分（用户拍板原话）。
 *
 * 四条清理通道（清单全部从真源派生，不手写第二份枚举）：
 *   ① SecretStorage：先读 providers 名单逐条删 apiKey。**必须先于** ②——
 *      SecretStorage 无枚举 API，key 按 name 构造，name 只存在于 configuration；
 *      顺序反了 = name 先丢 = secret 成永久孤儿（K1，测试锁调用时序）。
 *   ② 用户级 settings：键清单从 package.json contributes.configuration.properties
 *      派生（package.json 是配置声明真源，新增配置键自动跟随）；清单恒为完整
 *      设置 ID 形态，update 前经 toRelativeSettingKey 换算为相对键
 *      （getConfiguration(section) 的入参形态）；逐键 update(undefined, Global)。
 *      只清 Global target——Workspace 一字节不动（K4）。
 *   ③ globalState：keys() 枚举 → 只清 USER_STATE_KEY_PREFIX 前缀的键。
 *      globalState 是 VS Code **跨扩展共享**存储库，无脑全清会误删其他扩展的键（K3）。
 *   ④ globalStorage 目录：删 skills/ + role-packs/ 后**重建空目录**（与 activate 的
 *      mkdir 对齐，避免「打开目录」按钮指向不存在的路径）。
 *
 * 覆盖边界（如实登记，不撒谎）：
 *   - SecretStorage 无枚举 API ⇒ 只能删 configuration 里登记了 name 的 Provider 的
 *     key；「配置被外部编辑删掉 name、secret 却还在」的孤儿无法枚举删除（覆盖绝大多数）。
 *   - 旧键 memora.maxContextTokens 不由本模块清——activate 的 migrateMaxContextTokens
 *     无条件迁移时已清除（providerStore.ts），用户点初始化时该键早已不在。
 *
 * 落盘清理 ≠ 内存回首装态：activeRolePack / rolePackTeams / confirmWrites /
 * confirmScripts 都是装配期读一次，globalState 清了内存不跟着变 ⇒ 调用方清理成功后
 * 必须 reload window。本模块**不自己 reload**——重启时机归命令层决策，本模块只管存储。
 *
 * 幂等：已清的键/目录二次执行零副作用（keys() 不再返回已删键、update undefined 可重放、
 * rm force 对不存在的目录静默），失败可安全重试。
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { providerSecretKey, CFG_SECTION, CFG_PROVIDERS } from '../providers/providerStore.js';
// 配置写入唯一通道（带 5s 超时兜底：只读/受管设置上 update 可能永不 settle ⇒ 初始化永久卡住）
import { writeErrorText, writeSetting } from '../settingsWrite.js';
// 密钥删除唯一通道：钥匙串不可用时返回失败而不是裸抛（保留「任一步失败即抛出」
// 的契约不变，但消息带语义标签——哪一步、哪个 key，不再裸抛 VS Code 原始错误）
import { deleteSecret, secretErrorText } from './secretsWrite.js';
import {
  USER_STATE_KEY_PREFIX,
  USER_SKILLS_DIR_NAME,
  USER_ROLE_PACKS_DIR_NAME,
} from '../../shared/constants.js';

/**
 * 「初始化」执行上下文（依赖注入，便于单测：不直连 ExtensionContext）
 */
export interface UserDataResetScope {
  /** VS Code 全局状态（globalState，跨扩展共享存储库） */
  globalState: vscode.Memento;
  /** VS Code 安全存储（apiKey 加密存放处） */
  secrets: vscode.SecretStorage;
  /** globalStorageUri.fsPath（插件专属目录，含 skills/ 与 role-packs/ 子目录） */
  globalStorageDir: string;
  /** 插件 package.json（读 contributes.configuration.properties 派生 settings 键清单） */
  packageJson: unknown;
}

/** 清理报告（明细供命令层日志与结果提示；各列表 = 本次实际清理的键/目录） */
export interface ResetReport {
  /** 已清的 globalState 键 */
  globalStateCleared: string[];
  /** 已删 secret 的 Provider 别名 */
  secretsCleared: string[];
  /** 已清的用户级 settings 键 */
  settingsCleared: string[];
  /** 已删并重建为空目录的目录路径 */
  dirsReset: string[];
}

/**
 * 派生用户级 settings 键清单（真源 = package.json 声明）
 *
 * 两种合法形态都解析：contributes.configuration 为单对象（当前宿主）或对象数组
 * （VS Code 规范允许；防御将来有人拆分，届时不会静默漏清）。
 *
 * @param packageJson 插件 package.json 原文（不信任形状，逐层收窄）
 * @returns 完整设置 ID 清单（如 memora.providers）
 */
export function listUserSettingKeys(packageJson: unknown): string[] {
  const keys = new Set<string>();
  const contributes =
    typeof packageJson === 'object' && packageJson !== null
      ? (packageJson as { contributes?: unknown }).contributes
      : undefined;
  const configuration =
    typeof contributes === 'object' && contributes !== null
      ? (contributes as { configuration?: unknown }).configuration
      : undefined;
  // 数组形态（多 configuration 块）与单对象形态都接受
  const blocks: unknown[] = Array.isArray(configuration)
    ? configuration
    : configuration !== undefined && configuration !== null
      ? [configuration]
      : [];
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue;
    const properties = (block as { properties?: unknown }).properties;
    if (typeof properties !== 'object' || properties === null) continue;
    for (const key of Object.keys(properties)) keys.add(key);
  }
  return [...keys];
}

/**
 * 完整设置 ID → 相对键（getConfiguration(section).update 的入参形态）
 *
 * package.json properties 的键是完整 ID（memora.providers），而
 * getConfiguration('memora').update(key) 收**相对 section 的短键**（providers）——
 * 直接传完整 ID 会写成 memora.memora.providers（坑：清不干净还留双前缀脏键）。
 * 本函数是两种形态的唯一换算点；非本 section 的键（理论上不存在）原样返回。
 */
function toRelativeSettingKey(fullKey: string): string {
  const prefix = `${CFG_SECTION}.`;
  return fullKey.startsWith(prefix) ? fullKey.slice(prefix.length) : fullKey;
}

/**
 * 读 providers 名单（只取 name 字段）
 *
 * key 名与 ProviderStore 共用 CFG_SECTION / CFG_PROVIDERS 常量（无字面量副本）；
 * 形态只取 name（单条损坏/异形不阻塞清理，跳过即可）。
 */
function readProviderNames(): string[] {
  const providers = vscode.workspace
    .getConfiguration(CFG_SECTION)
    .get<{ name?: unknown }[]>(CFG_PROVIDERS, []);
  return providers
    .map((p) => (typeof p?.name === 'string' ? p.name : ''))
    .filter((name) => name.length > 0);
}

/**
 * 执行用户级数据初始化（恢复首装态）
 *
 * 通道顺序即 K1 硬约束：SecretStorage 先于 settings。任一步失败即抛出
 * （已执行的步骤不回滚——各步骤幂等，整体可安全重试）；调用方负责 catch、
 * 报错与「失败则不 reload」的决策。
 *
 * @param scope 执行上下文（注入的 VS Code 存储面）
 * @returns 清理报告（本次实际清掉的键/目录明细）
 */
export async function resetUserData(scope: UserDataResetScope): Promise<ResetReport> {
  const report: ResetReport = {
    globalStateCleared: [],
    secretsCleared: [],
    settingsCleared: [],
    dirsReset: [],
  };

  // ① SecretStorage 先行（K1）：此时 configuration 里的 providers 名单还在，
  //    按名单逐条删 apiKey；下一步才清 configuration——反了 name 就没了。
  for (const name of readProviderNames()) {
    const deleted = await deleteSecret(scope.secrets, providerSecretKey(name));
    // 失败即抛出的契约不变（调用方 catch + 失败不 reload + 各步骤幂等可重试），
    // 但消息带语义标签（哪个 Provider 的 key、失败原因），与 settings 通道同构
    if (!deleted.ok) throw new Error(secretErrorText(`API Key「${name}」清理`, deleted));
    report.secretsCleared.push(name);
  }

  // ② 用户级 settings：派生清单逐键清 Global 值（K4：第三参恒 Global，
  //    工作区 .vscode/settings.json 一字节不碰）。
  //    经统一写入通道（带 5s 上限）：只读/受管设置上 update 可能永不 settle，
  //    否则初始化流程会永久卡住、用户看不到任何回执。失败按本函数契约抛出。
  for (const fullKey of listUserSettingKeys(scope.packageJson)) {
    const written = await writeSetting(toRelativeSettingKey(fullKey), undefined);
    if (!written.ok) throw new Error(writeErrorText(`用户级设置「${fullKey}」`, written));
    report.settingsCleared.push(fullKey);
  }

  // ③ globalState：前缀过滤（K3：跨扩展共享库，只清本插件前缀的键）
  for (const key of scope.globalState.keys()) {
    if (!key.startsWith(USER_STATE_KEY_PREFIX)) continue;
    await scope.globalState.update(key, undefined);
    report.globalStateCleared.push(key);
  }

  // ④ globalStorage 目录：删后重建空目录（与 activate 的 mkdir 对齐）
  for (const dirName of [USER_SKILLS_DIR_NAME, USER_ROLE_PACKS_DIR_NAME]) {
    const dir = join(scope.globalStorageDir, dirName);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    report.dirsReset.push(dir);
  }

  return report;
}
