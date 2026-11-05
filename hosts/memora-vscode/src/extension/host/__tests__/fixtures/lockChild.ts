/**
 * 跨进程会话锁验收的**子进程侧**
 *
 * 参数：`<ws> <mode> <sessionId> [preferred]`
 *   - `hold`：拿锁 → 写一轮 → 打印 `LOCKED` → 等 1.5s → 再写一轮 → 打印 `DONE`
 *             （用来验证「第一写者不受影响，仍能正常收尾」）
 *   - `holdwait`：同 `hold`，但一直持有到父进程写哨兵文件 `ws/.lock-release`（最长 30s）。
 *             用于「两窗口同时启动」验收：子进程冷启 tsx 的耗时可能超过 `hold` 的 1.5s，
 *             固定睡眠会让持锁方先退出而把锁自己交出去（用例假红），故改用显式释放信号。
 *   - `kill`：拿锁 → 打印 `LOCKED` → 长睡（父进程随后 `taskkill /F` 强杀）
 *   - `try` ：尝试拿锁 → 打印 `ACQUIRED <true|false> <拿锁耗时ms>`；成功则写一轮
 *   - `distinct`：拿自己的锁 → 连写 20 轮（每次间隔 8ms）→ 打印 `DONE`
 *   - `startup`：用真实让位判据 `claimStartupSession` 裁决 → 打印
 *             `CLAIM <最终会话|-> <displaced>`；有归属则写一轮
 *
 * 正常完成以 `DONE` / `ACQUIRED` / `CLAIM` 行作为父进程的同步信号；
 * 异常退出码 3（父进程据此区分「没跑起来」与「并发丢数据」）。
 *
 * ⚠️ 本文件被 tsc 编译进 dist，但 `__tests__/**` 被 `.vscodeignore` 排除，不进安装包。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceSessionStore } from '../../sessionStore.js';
// 启动让位判据与面板共用同一实现（测试不得自己再写一份循环）
import { claimStartupSession } from '../../../../webview/helpers/sessionStartupClaim.js';

/** 等待指定毫秒（让父子进程的写/杀交错） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 打印一行结果（父进程按行解析） */
function emit(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** 子进程主体 */
async function main(): Promise<void> {
  const [ws, mode, sessionId, preferred] = process.argv.slice(2);
  if (!ws || !mode || !sessionId) {
    console.error('参数不足：ws mode sessionId [preferred]');
    process.exit(4);
  }
  const store = new WorkspaceSessionStore(ws);
  store.load();
  // 生产同款：启用跨进程写锁（未启用时写断言关闭，本验收就失去意义）
  store.enableCrossProcessLock();

  /** 写一轮（走写盘断言：未持锁且文件已存在时会抛错） */
  const append = (sid: string, tag: string): void => {
    store.appendRoundId(sid, `${sid}-${tag}-${Date.now()}`);
  };

  if (mode === 'hold') {
    if (!(await store.acquireSessionLock(sessionId))) {
      emit('ACQUIRED false');
      process.exit(3);
    }
    append(sessionId, 'hold-0');
    emit('LOCKED');
    await sleep(1500);
    append(sessionId, 'hold-1');
    emit('DONE');
  } else if (mode === 'holdwait') {
    if (!(await store.acquireSessionLock(sessionId))) {
      emit('ACQUIRED false');
      process.exit(3);
    }
    append(sessionId, 'hold-0');
    emit('LOCKED');
    // 显式释放信号：父进程断言完再写哨兵（比固定睡眠抗「子进程冷启慢」的抖动）
    const releaseFile = join(ws, '.lock-release');
    const deadline = Date.now() + 30_000;
    while (!existsSync(releaseFile) && Date.now() < deadline) {
      await sleep(50);
    }
    append(sessionId, 'hold-1');
    emit('DONE');
  } else if (mode === 'kill') {
    if (!(await store.acquireSessionLock(sessionId))) {
      emit('ACQUIRED false');
      process.exit(3);
    }
    append(sessionId, 'kill-0');
    emit('LOCKED');
    // 等着被强杀（进程死亡由 OS 关闭监听句柄 ⇒ 锁即时释放）
    await sleep(30_000);
    emit('DONE');
  } else if (mode === 'try') {
    const startedAt = Date.now();
    const acquired = await store.acquireSessionLock(sessionId);
    const elapsedMs = Date.now() - startedAt;
    emit(`ACQUIRED ${acquired} ${elapsedMs}`);
    if (acquired) append(sessionId, 'try');
  } else if (mode === 'distinct') {
    if (!(await store.acquireSessionLock(sessionId))) {
      emit('ACQUIRED false');
      process.exit(3);
    }
    for (let i = 0; i < 20; i += 1) {
      append(sessionId, `d-${i}`);
      await sleep(8);
    }
    emit('DONE');
  } else if (mode === 'startup') {
    if (!preferred) {
      console.error('startup 模式需要 preferred 参数');
      process.exit(4);
    }
    const claim = await claimStartupSession(preferred, {
      acquire: (id) => store.acquireSessionLock(id),
      fallbackCandidates: () =>
        store
          .listSessionMetas()
          .filter((m) => m.sessionId !== preferred && !store.isArchived(m.sessionId))
          .map((m) => m.sessionId),
    });
    emit(`CLAIM ${claim.sessionId || '-'} ${claim.displaced}`);
    if (claim.sessionId) append(claim.sessionId, 'claim');
  } else {
    console.error(`未知模式：${mode}`);
    process.exit(4);
  }

  store.releaseAllSessionLocks();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(3);
});
