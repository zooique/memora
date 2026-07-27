/**
 * PersonaWatcher — personas 目录热重载监听器
 *
 * 独立模块，职责单一：
 *   监听 &lt;configDir&gt;/personas/ 目录的文件变化（新增/修改/删除 .md 文件），
 *   500ms 防抖后触发 agent.reloadConfig('persona') 清空缓存重新扫描。
 *
 * 设计要点：
 *   - 使用 fs.watch recursive 模式（Node 22 LTS 稳定支持）
 *   - 监听器 error 事件仅记录日志，不抛错（目录被删除/权限丢失时优雅降级）
 *   - configDir 未提供时直接跳过（测试场景默认行为）
 *   - 重载期间对话繁忙时 reloadConfig 会抛 chatBusyError，由本模块捕获降级为日志
 *
 * 不持有 Sprite 状态——所有运行时依赖（agent / proactiveEngine / 事件发射）
 * 通过构造函数注入，与 Sprite 门面解耦。
 */
import { watch } from 'node:fs';
import { join } from 'node:path';
import { logger, toError } from 'memora';

/**
 * personas 目录热重载防抖间隔（毫秒）
 *
 * 编辑器保存文件时可能触发多次 change 事件（写入 + 重命名），500ms 防抖合并为一次 reload。
 * 与 fileWatcherTrigger 的默认防抖（1000ms）保持同量级，但稍短以提升响应感。
 */
const PERSONA_RELOAD_DEBOUNCE_MS = 500;

/**
 * 内核重载回调签名
 *
 * 抽象为接口类型，避免 PersonaWatcher 直接依赖 Agent 全部 API。
 * 实际由 Sprite 注入 `(source) => agent.reloadConfig(source)`。
 */
export type PersonaReloader = (source: 'persona') => Promise<unknown>;

/**
 * 错误通知回调签名
 *
 * 用于在监听异常时通知 proactiveEngine.addNotice('suggestion', reason, false, 'high')。
 * 由 Sprite 注入，避免 PersonaWatcher 反向依赖 ProactiveEngine。
 */
export type PersonaWatchErrorNotifier = (reason: string) => void;

/**
 * 文件变更通知回调签名
 *
 * 用于 reload 完成后通知宿主 UI 刷新设定面板（对应 emitSprite('configFilesChanged', ...)）。
 * 由 Sprite 注入，避免 PersonaWatcher 反向依赖 Sprite 事件系统。
 */
export type PersonaFilesChangedEmitter = (payload: {
  type: 'persona';
  action: 'save';
  name: string;
}) => void;

/**
 * PersonaWatcher 构造依赖
 */
export interface PersonaWatcherDeps {
  /** Agent 级配置目录（监听 &lt;configDir&gt;/personas/） */
  configDir: string;
  /** 内核重载回调（注入 agent.reloadConfig） */
  reload: PersonaReloader;
  /** 错误通知回调（注入 proactiveEngine.addNotice） */
  onError: PersonaWatchErrorNotifier;
  /** 文件变更通知回调（注入 emitSprite('configFilesChanged', ...)） */
  onFilesChanged: PersonaFilesChangedEmitter;
}

/**
 * personas 目录热重载监听器
 *
 * 使用方式：
 *   const watcher = new PersonaWatcher(deps);
 *   watcher.start();  // 在 Sprite.start() 中调用
 *   watcher.stop();   // 在 Sprite.stop() 中调用
 *
 * 幂等性：start() 重复调用直接返回，stop() 重复调用安全。
 */
export class PersonaWatcher {
  private readonly deps: PersonaWatcherDeps;
  /** fs.watch 监听器句柄（start 时创建，stop 时关闭） */
  private watcher: ReturnType<typeof watch> | null = null;
  /** 热重载防抖计时器（500ms 内多次变化合并为一次 reload） */
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: PersonaWatcherDeps) {
    this.deps = deps;
  }

  /**
   * 启动 personas 目录监听器
   *
   * 监听 &lt;configDir&gt;/personas/ 目录的文件变化（新增/修改/删除 .md 文件），
   * 500ms 防抖后触发 reload('persona') 清空缓存重新扫描。
   * 重载期间对话繁忙时跳过本次（用户可手动调 reloadConfig）。
   *
   * 幂等守卫：已存在 watcher 则跳过，避免重复 start() 导致旧句柄泄漏。
   */
  start(): void {
    // 幂等守卫：已存在 watcher 则跳过
    if (this.watcher) return;

    const personasDir = join(this.deps.configDir, 'personas');
    try {
      this.watcher = watch(personasDir, { recursive: true }, (_eventType, filename) => {
        // 仅响应 .md 文件变化，忽略其他文件（如 .swp 临时文件）
        if (!filename || !filename.endsWith('.md')) return;
        this.scheduleReload();
      });
      // error 事件：关闭并清理 watcher 句柄，避免目录被删除后 watcher 进入僵尸状态
      this.watcher.on('error', (err) => {
        logger.warn({ err: toError(err).message, personasDir }, 'personas 目录监听器错误，热重载已停止');
        this.deps.onError(`人物设定目录监听异常：${toError(err).message}`);
        try {
          this.watcher?.close();
        } catch {
          // 二次错误（如句柄已损坏）忽略，避免 error handler 内抛错
        }
        this.watcher = null;
      });
      logger.info({ personasDir }, 'personas 目录热重载已启动');
    } catch (err) {
      // 目录不存在或权限不足时优雅降级，不阻塞 start()
      logger.warn({ err: toError(err).message, personasDir }, 'personas 目录监听启动失败，跳过热重载');
      this.deps.onError(`人物设定目录监听启动失败：${toError(err).message}`);
    }
  }

  /**
   * 防抖调度 personas 重载
   *
   * 500ms 内多次文件变化合并为一次 reload，避免编辑器写入触发多次重载。
   *
   * reload 完成后（无论成功失败）发射 configFilesChanged 事件：
   *   - 文件层已变化是事实（真理源），渲染层应据此刷新列表
   *   - reload 失败仅影响内核同步，不影响文件层刷新通知
   *   - name 为空字符串表示批量变更（防抖合并多次变化，无法确定具体文件名）
   */
  private scheduleReload(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      void this.deps
        .reload('persona')
        .catch((err) => {
          logger.warn({ err: toError(err).message }, 'personas 热重载失败');
          this.deps.onError(`人物设定热重载失败：${toError(err).message}，面板数据可能不是最新`);
        })
        .finally(() => {
          // 发射 configFilesChanged 事件（IPC 层监听后广播 CONFIG_FILES_CHANGED 到渲染进程）
          // type='persona' + name='' 表示批量变更，渲染层全量刷新 persona tab
          this.deps.onFilesChanged({ type: 'persona', action: 'save', name: '' });
        });
    }, PERSONA_RELOAD_DEBOUNCE_MS);
  }

  /**
   * 关闭 personas 目录监听器 + 清理防抖计时器
   *
   * 幂等：watcher / timer 已清理时重复调用安全。
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
  }
}
