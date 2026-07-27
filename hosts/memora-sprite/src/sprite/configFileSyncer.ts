/**
 * ConfigFileSyncer — 设定文件变更后的内核联动同步器
 *
 * 独立模块，职责单一：
 *   save/delete 设定文件后，同步 SQLite 索引 + Manager 内存缓存 + system prompt。
 *
 * 与 configFileManager 的关系（双层结构）：
 *   - configFileManager：纯文件 CRUD（无运行时依赖，真理源）
 *   - ConfigFileSyncer：文件变更后的内核联动（依赖 Agent.persona/config/skills）
 *
 * 联动失败不抛错（文件已是真理源，Manager 联动失败仅记录日志，
 * 下次 reloadConfig 时自然对齐）。
 */
import { logger, toError } from 'memora';
import type { ConfigFileType } from './configFileManager.js';

/**
 * Agent 内核联动接口
 *
 * 抽象为接口类型，避免 ConfigFileSyncer 直接依赖 Agent 全部 API。
 * 使用 getter 函数延迟访问 persona / config / skills——这些 Manager 在 Agent.init()
 * 之后才可用，而 Sprite 在构造 ConfigFileSyncer 时 Agent 可能尚未 init。
 * reloadConfig 是 Agent 自身方法（不依赖 init 后的 Manager），直接作为函数引用。
 */
export interface AgentSyncApi {
  /** persona Manager getter（删除角色时调用 deletePersona；init 前返回 null） */
  getPersona: () => {
    deletePersona(name: string): void;
  } | null;
  /** config Manager getter（rule 增删时调用 updateRule / deleteRule；skill 删除时调用 deleteSkill） */
  getConfig: () => {
    updateRule(name: string, content: string): void;
    deleteRule(name: string): void;
    deleteSkill(name: string): void;
  } | null;
  /** skills Manager getter（skill 保存时调用 reload 重新扫描） */
  getSkills: () => {
    reload(): Promise<unknown>;
  } | null;
  /** 内核重载（persona 保存时调用 reloadConfig('persona')） */
  reloadConfig(source: 'persona' | 'skill' | 'rule'): Promise<unknown>;
}

/**
 * 错误通知回调签名
 *
 * 用于在联动失败时通知 proactiveEngine.addNotice('suggestion', reason, false, 'high')。
 * 由 Sprite 注入，避免 ConfigFileSyncer 反向依赖 ProactiveEngine。
 */
export type SyncErrorNotifier = (reason: string) => void;

/**
 * ConfigFileSyncer 构造依赖
 */
export interface ConfigFileSyncerDeps {
  /** Agent 内核联动 API（仅暴露 4 个所需方法） */
  agent: AgentSyncApi;
  /** 错误通知回调（注入 proactiveEngine.addNotice） */
  onError: SyncErrorNotifier;
}

/**
 * 设定文件变更后的内核联动同步器
 *
 * 使用方式：
 *   const syncer = new ConfigFileSyncer(deps);
 *   await syncer.sync('persona', 'name', 'content', 'save');    // saveConfigFile 后调用
 *   await syncer.sync('rule', 'name', '', 'delete');            // deleteConfigFile 后调用
 */
export class ConfigFileSyncer {
  private readonly deps: ConfigFileSyncerDeps;

  constructor(deps: ConfigFileSyncerDeps) {
    this.deps = deps;
  }

  /**
   * 设定文件变更后的内核联动同步
   *
   * 联动逻辑（按 type 分支）：
   *   - persona:
   *     - save: agent.reloadConfig('persona') 重新扫描 personas/ 目录
   *     - delete: agent.persona.deletePersona(name) 清内存 + SQLite 软删除 + 激活角色回退
   *   - rule:
   *     - save: agent.config.updateRule(name, content) upsert SQLite + bootstrap 段刷新
   *     - delete: agent.config.deleteRule(name) SQLite 软删除 + bootstrap 段刷新
   *   - skill:
   *     - save: agent.skills.reload() 重新扫描 skills/ 目录
   *     - delete: agent.config.deleteSkill(name) SQLite 软删除 + SkillManager 内存清理 + bootstrap 段刷新
   *
   * 联动失败不抛错（文件已是真理源），仅记录日志 + 通知 proactiveEngine。
   * 下次 reloadConfig 时自然对齐。
   *
   * @param type 配置类型
   * @param name 配置名
   * @param content 文件内容（delete 时为空字符串）
   * @param action 操作类型 'save' | 'delete'
   */
  async sync(
    type: ConfigFileType,
    name: string,
    content: string,
    action: 'save' | 'delete',
  ): Promise<void> {
    try {
      if (type === 'persona') {
        if (action === 'delete') {
          // 删除：清内存 + SQLite 软删除 + 激活角色回退（K3）
          this.deps.agent.getPersona()?.deletePersona(name);
        } else {
          // 保存：重新扫描 personas/ 目录（保持激活角色，reload 内部处理）
          // personaWatcher 也会触发，但显式调用确保即时生效（避免 500ms 防抖延迟）
          await this.deps.agent.reloadConfig('persona');
        }
      } else if (type === 'rule') {
        if (action === 'delete') {
          // 删除：SQLite 软删除 + bootstrap 段刷新（K1）
          this.deps.agent.getConfig()?.deleteRule(name);
        } else {
          // 保存：upsert SQLite + bootstrap 段刷新（K1，处理软删除复活）
          this.deps.agent.getConfig()?.updateRule(name, content);
        }
      } else if (type === 'skill') {
        if (action === 'delete') {
          // 删除：SQLite 软删除 + SkillManager 内存清理 + bootstrap 段刷新（K1 联动 K4）
          this.deps.agent.getConfig()?.deleteSkill(name);
        } else {
          // 保存：重新扫描 skills/ 目录（SkillManager.reload 内部同步 SQLite + 内存）
          await this.deps.agent.getSkills()?.reload();
        }
      }
    } catch (err) {
      // 联动失败不阻断文件操作（文件已是真理源），下次 reloadConfig 时自然对齐
      logger.warn(
        { type, name, action, err: toError(err).message },
        '设定文件变更后的内核联动失败，下次 reloadConfig 时自然对齐',
      );
      this.deps.onError(`设定文件"${name}"同步失败，将在下次重载时自动对齐`);
    }
  }
}
