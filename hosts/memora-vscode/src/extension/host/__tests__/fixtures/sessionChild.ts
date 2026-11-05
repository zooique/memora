/**
 * 双进程并发写会话的**子进程侧**：向指定会话追加 N 个 roundId，每次写入间留间隔。
 *
 * 用途：验证 6.0.0 步 2 的「每会话一文件」布局——父子两个进程各写**不同**会话时，
 * 一次写入只触碰自己的会话文件，不会像旧的整份 `sessions.json` 那样互相覆盖。
 * 父子交错靠 sleep：父进程同时向另一个会话写，两条写链路在时间上重叠。
 *
 * 参数：ws（工作区路径）、sessionId、roundId 前缀、写入次数。
 * 正常完成打印 `DONE`；异常退出码 3（父进程据此区分「没跑起来」与「并发丢数据」）。
 *
 * ⚠️ 本文件被 tsc 编译进 dist，但 `__tests__/**` 被 `.vscodeignore` 排除，不进安装包。
 */
import { WorkspaceSessionStore } from '../../sessionStore.js';

/** 等待指定毫秒（让父子两个进程的写入交错） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 子进程主体：load → 连续追加 → 打印完成标记 */
async function main(): Promise<void> {
  const [ws, sessionId, prefix, countRaw] = process.argv.slice(2);
  const count = Number(countRaw);
  if (!ws || !sessionId || !prefix || !Number.isFinite(count)) {
    console.error('参数不足：ws sessionId prefix count');
    process.exit(4);
  }
  const store = new WorkspaceSessionStore(ws);
  store.load();
  for (let i = 0; i < count; i += 1) {
    // 每次只写本会话文件（appendRoundId 内部即 writeSessionFile，不触碰其他会话）
    store.appendRoundId(sessionId, `${prefix}-${i}`);
    await sleep(8);
  }
  process.stdout.write('DONE\n');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(3);
});
