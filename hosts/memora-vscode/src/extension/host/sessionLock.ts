/**
 * 每会话跨进程写锁 — 命名管道（Windows）/ Unix domain socket（POSIX）
 *
 * 为什么不用 flock：Windows 没有 flock。
 * 为什么不用「独占文件 + O_EXCL」：进程崩溃会留下锁文件（僵尸锁），必须再写一套
 *   「PID 探活 + 清理」策略，且 PID 复用会把僵尸判成活锁。命名管道/套接字由操作系统的
 *   句柄生命周期托管：进程被强杀（`taskkill /F`）时内核立即关闭监听句柄，锁当场释放，
 *   不存在需要清理的残留（POSIX 的 socket 文件残留由下一次获取者做一次「试连」后回收）。
 * 为什么不用 npm 心跳锁：心跳式锁在进程假死时会「等超时」，且多一个依赖；本需求只需要
 *   「谁在写这个会话」这一事实，不需要租约。
 *
 * ⚠️ **已知边界（风险已登记，台账 `SESSIONLOCK-LIVENESS-1`）**：OS 只在**进程退出**时回收句柄；
 *   进程**假死（未退出）**时句柄继续被占、锁无 TTL ⇒ 该会话对其他窗口**永久不可用**，唯一恢复
 *   是杀掉该窗口。租约 / 心跳属另一件事，本类不实现——不得把「不需要租约」读成「假死无风险」。
 *
 * 锁名 = sha256(数据目录绝对路径（win32 小写）+ `\0` + sessionId) 前 32 hex：
 *   - **必须含数据目录**：不同工作区的会话 id 可能同名（`YYYY-MM-DD-main`），只按会话 id
 *     取锁会让两个工作区互相误挡；
 *   - 不直接用 sessionId：会话名可能含分隔符 / 超长，且管道名有长度上限；
 *   - win32 路径转小写：同一目录的大小写拼写差异不能产生两把锁。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, unlinkSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { join, resolve } from 'node:path';

/** Windows 命名管道前缀（`\\.\pipe\`） */
const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\';
/** POSIX socket 文件所在子目录（与 `.memora/sessions` 并列，不污染会话目录） */
const POSIX_LOCK_DIR_NAME = 'locks';

/**
 * 单进程内持有的锁集合（sessionId → 正在监听的 server）
 *
 * 只做「拿 / 放 / 查询」三件事；**不重试、不等待、不心跳**——拿不到就是 false，
 * 由调用方决定给用户什么提示（拒绝优于排队，排队会把 UI 挂住）。
 */
export class CrossProcessSessionLock {
  /** sessionId → 本进程正在监听的 server（有值 = 本进程持锁） */
  private readonly servers = new Map<string, Server>();
  /**
   * 锁设施自身故障时降级持有的会话（sessionId 集合）
   *
   * 判据区分（重要）：「被占」= 对方进程持锁，必须拒绝；「锁设施故障」= 管道名非法 /
   * 权限异常等，**不能因此把用户挡在门外**——记一条告警后按持有处理（fail-open），
   * 宁可回到旧的「可能覆盖」风险，也不制造「插件不可用」。
   */
  private readonly degraded = new Set<string>();

  /**
   * @param dataDir 会话落盘的 `.memora` 数据目录（锁名哈希与 POSIX socket 位置都取它）
   */
  constructor(private readonly dataDir: string) {}

  /** 本进程是否持有该会话的锁（纯查询，不尝试获取；含降级持有） */
  isHeld(sessionId: string): boolean {
    return this.servers.has(sessionId) || this.degraded.has(sessionId);
  }

  /**
   * 尝试获取该会话的写锁（**不等待**）
   *
   * @param sessionId 会话标识
   * @returns true = 本进程现在持有（含本来已持有 / 设施故障降级）；false = 被其他进程持有
   */
  async tryAcquire(sessionId: string): Promise<boolean> {
    if (this.isHeld(sessionId)) return true;
    const address = this.addressFor(sessionId);
    const first = await this.listenOnce(address);
    if (first.kind === 'ok') {
      this.servers.set(sessionId, first.server);
      return true;
    }
    if (first.kind === 'error') {
      // 锁设施故障 ≠ 会话被占：告警一次后降级放行（不制造「插件不可用」）
      console.warn(`Memora 会话锁设施不可用，已降级放行：${sessionId}`, first.error);
      this.degraded.add(sessionId);
      return true;
    }
    // Windows：管道被占 = 对方进程活着（进程死由 OS 关句柄，不会留尸）
    if (process.platform === 'win32') return false;
    // POSIX：崩溃会留下 socket 文件（连不上但文件还在）——试连一次，无人应答则回收再试
    if (await this.isListenerAlive(address)) return false;
    try {
      unlinkSync(address);
    } catch {
      // 文件已被别人清掉 / 权限异常：交由下一次 listen 的结果说话
    }
    const retried = await this.listenOnce(address);
    if (retried.kind === 'ok') {
      this.servers.set(sessionId, retried.server);
      return true;
    }
    if (retried.kind === 'error') {
      console.warn(`Memora 会话锁设施不可用，已降级放行：${sessionId}`, retried.error);
      this.degraded.add(sessionId);
      return true;
    }
    return false;
  }

  /** 释放该会话的锁（未持有时忽略；POSIX 下 close 会由 Node 自动删除 socket 文件） */
  release(sessionId: string): void {
    this.degraded.delete(sessionId);
    const server = this.servers.get(sessionId);
    if (!server) return;
    this.servers.delete(sessionId);
    try {
      server.close();
    } catch {
      // 已关闭 / 未启动：释放语义是幂等的，不向上抛
    }
  }

  /** 释放本进程持有的全部锁（进程退出兜底；正常路径由业务逐个 release） */
  releaseAll(): void {
    for (const sessionId of [...this.servers.keys()]) this.release(sessionId);
  }

  /**
   * 锁地址推导（Windows 管道名 / POSIX socket 路径）
   *
   * @param sessionId 会话标识
   * @returns 可直接交给 `server.listen()` 的地址
   */
  private addressFor(sessionId: string): string {
    const dir =
      process.platform === 'win32' ? resolve(this.dataDir).toLowerCase() : resolve(this.dataDir);
    const digest = createHash('sha256')
      .update(`${dir}\u0000${sessionId}`)
      .digest('hex')
      .slice(0, 32);
    if (process.platform === 'win32') return `${WINDOWS_PIPE_PREFIX}memora-lock-${digest}`;
    return join(this.dataDir, POSIX_LOCK_DIR_NAME, `memora-lock-${digest}.sock`);
  }

  /**
   * 单次监听尝试（成功即持锁）
   *
   * @param address 锁地址
   * @returns ok = 持锁成功；conflict = 地址被占（对方活着）；error = 锁设施故障（应降级放行）
   */
  private listenOnce(
    address: string,
  ): Promise<
    { kind: 'ok'; server: Server } | { kind: 'conflict' } | { kind: 'error'; error: unknown }
  > {
    return new Promise((resolvePromise) => {
      // POSIX 需要先保证 socket 文件所在目录存在（目录缺失的错误与「被占」不同，直接失败）
      if (process.platform !== 'win32') {
        try {
          mkdirSync(join(this.dataDir, POSIX_LOCK_DIR_NAME), { recursive: true });
        } catch {
          // 建目录失败会在 listen 时以 error 事件暴露，这里不提前返回
        }
      }
      const server = createServer();
      /** 监听失败：按错误码区分「被占」与「设施故障」 */
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening);
        try {
          server.close();
        } catch {
          // 未进入 listening 的 server close 可能抛 ERR_SERVER_NOT_RUNNING：忽略
        }
        // EADDRINUSE = 对方正在监听；其余（EACCES / 名非法等）属于设施故障
        resolvePromise(
          err.code === 'EADDRINUSE' ? { kind: 'conflict' } : { kind: 'error', error: err },
        );
      };
      /** 监听成功：转交 server，并卸载一次性错误处理 */
      const onListening = (): void => {
        server.removeListener('error', onError);
        // 后续运行期错误不得冒泡成未捕获异常（锁是数据护栏，不是崩溃源）
        server.on('error', () => {});
        // unref：持锁不得拖住测试/工具进程的退出；句柄本身仍占用管道
        server.unref();
        resolvePromise({ kind: 'ok', server });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(address);
    });
  }

  /**
   * POSIX 下判断「socket 文件背后是否真有进程在监听」
   *
   * @param address socket 路径
   * @returns true = 能连上（活锁）；false = 连不上（崩溃残留，可回收）
   */
  private isListenerAlive(address: string): Promise<boolean> {
    return new Promise((resolvePromise) => {
      const socket = connect(address);
      /** 超时兜底：极端情况下 connect 悬挂时按「没人听」处理，避免拿锁流程长时间挂起 */
      const timer = setTimeout(() => {
        socket.destroy();
        resolvePromise(false);
      }, 500);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.destroy();
        resolvePromise(true);
      });
      socket.once('error', () => {
        clearTimeout(timer);
        socket.destroy();
        resolvePromise(false);
      });
    });
  }
}
