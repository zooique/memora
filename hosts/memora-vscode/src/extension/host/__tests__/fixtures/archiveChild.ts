/**
 * 双进程并发「归档 / 取消归档」的**子进程侧**：对自己的会话做 20 次翻转，最终停在归档态。
 *
 * 用途：验证归档标记已从全局 `_global.json` 落到**会话自己的文件**——两个进程各归档一个
 * 不同会话时，不存在共享写点，不会互相覆盖。
 *
 * 参数：ws、sessionId、翻转次数（偶数，且最后一次落在 archive）。
 * 正常完成打印 `DONE`；异常退出码 3。
 *
 * ⚠️ 本文件被 tsc 编译进 dist，但 `__tests__/**` 被 `.vscodeignore` 排除，不进安装包。
 */
import { WorkspaceSessionStore } from '../../sessionStore.js';

/** 等待指定毫秒（让父子两个进程的写入交错） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 子进程主体：建自己的会话 → 交替归档/取消归档 → 打印完成标记 */
async function main(): Promise<void> {
  const [ws, sessionId, countRaw] = process.argv.slice(2);
  const count = Number(countRaw);
  if (!ws || !sessionId || !Number.isFinite(count)) {
    console.error('参数不足：ws sessionId count');
    process.exit(4);
  }
  const store = new WorkspaceSessionStore(ws);
  store.load();
  // 会话必须已存在（archive 对不存在会话返回 false），meta 让文件有内容可落盘
  store.createSession({
    sessionId,
    updatedAt: new Date().toISOString(),
    messageCount: 0,
  });
  for (let i = 0; i < count; i += 1) {
    if (i % 2 === 0) {
      store.unarchiveSession(sessionId);
    } else {
      store.archiveSession(sessionId);
    }
    await sleep(8);
  }
  // 偶数次翻转起于未归档 ⇒ 末次（count-1 为奇数）是 archive，停在归档态
  process.stdout.write('DONE\n');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(3);
});
