/**
 * 跨重启 e2e 的**子进程侧**：真实宿主存储 + 真 Agent，在「用户已提问、LLM 尚未作答」的
 * 窗口上用 `SIGKILL` 自杀（**非优雅退出**，不给任何 flush/close 机会）。
 *
 * 为什么必须是独立子进程：本用例要验证的恰恰是「进程被硬杀之后磁盘上还剩下什么」。
 * 在同一个进程里用 `throw` / `agent.close()` 模拟都是**优雅退出**——close() 会 flush，
 * 那验的是「正常关闭能存住」，跟崩溃恢复是两回事。
 *
 * 为什么要打印 `FIRST_CHUNK`：父进程必须能区分两种红——「子进程真跑到了崩溃窗口才死」
 * 与「子进程压根没启动成功就退出」。少了这个标记，环境问题会被误读成行为缺陷。
 *
 * ⚠️ 本文件被 tsc 编译进 dist，但 `__tests__/**` 被 `.vscodeignore` 排除，不进安装包。
 */
import { Agent, type LlmChunk, type LlmProvider } from '@zooique/memora';
import { WorkspaceSessionStore } from '../../sessionStore.js';
import { WorkspaceRoundStore } from '../../workspaceRoundStore.js';
import { WorkspaceStorage } from '../../workspaceStorage.js';

/**
 * 悬停型 provider：产出首个 content 分片后**永不结束**。
 *
 * 语义 = LLM 正在长响应中途。父进程收到第一个分片即杀进程，此刻轮必然是
 * 「已 appendUser、未 appendAssistant」的 pending 态——正是崩溃窗口本身。
 * （若 provider 直接给 `finishReason: 'stop'`，循环会立刻收场成 complete，
 * 那就测不到中断了。）
 */
class HangingProvider {
  readonly name = 'hanging';
  readonly supportsStructuredOutput = false;
  // eslint-disable-next-line require-yield
  async *chat(): AsyncIterable<LlmChunk> {
    yield { content: '第一段叙述' };
    // 永不 resolve：模拟仍在等待后续分片
    await new Promise<void>(() => {});
  }
}

/**
 * 提问型 provider：一次性返回 `ask_user` 工具调用。
 *
 * 语义 = 「AI 已提问、用户未答」。⚠️ 这个窗口与「流式作答中途」**盘面不同**：
 * `handleAskUser` 不 await，而是 yield `paused` 后**结束本轮生成器**（状态机转 PAUSED），
 * 进程此刻是空闲的，等的是用户输入。所以崩溃点必须落在 `paused` 之后，
 * 才叫「提问窗口崩溃」——落在 `paused` 之前测的是另一件事。
 */
class AskProvider {
  readonly name = 'ask';
  readonly supportsStructuredOutput = false;
  // eslint-disable-next-line require-yield
  async *chat(): AsyncIterable<LlmChunk> {
    yield {
      content: '',
      toolCalls: [
        {
          id: 'call-ask-1',
          type: 'function' as const,
          function: {
            name: 'ask_user',
            arguments: JSON.stringify({ question: '选哪个方案？', options: ['A', 'B'] }),
          },
        },
      ],
      finishReason: 'tool_calls' as const,
    };
  }
}

async function main(): Promise<void> {
  const [workspace, configDir, dataDir, prompt, mode] = process.argv.slice(2);
  if (!workspace || !configDir || !dataDir || !prompt) {
    throw new Error('crashChild 参数不足：需要 <workspace> <configDir> <dataDir> <prompt> [mode]');
  }
  const askMode = mode === 'ask';

  // 真实宿主持久层（与生产同一实现）：load() 从磁盘载入，与装配链一致。
  // ⚠️ roundStore 必须传且必须进 Agent —— 缺它时轮次根本不落盘，
  // 崩溃后磁盘一无所有，测试会误判成「不可恢复」。
  const roundStore = new WorkspaceRoundStore(workspace);
  roundStore.load();
  const sessionStore = new WorkspaceSessionStore(workspace, roundStore);
  sessionStore.load();
  const storage = new WorkspaceStorage(workspace);
  storage.load();

  const agent = new Agent({
    projectPath: workspace,
    dataDir,
    configDir,
    provider: (askMode ? new AskProvider() : new HangingProvider()) as unknown as LlmProvider,
    storage,
    sessionStore,
    roundStore,
    permission: 'owner',
    allowedPaths: [dataDir],
    // 关自动归档：避免后台摘要任务在崩溃前后插入额外 LLM 调用，污染落盘面
    archiveMode: 'manual',
  });
  await agent.init();

  const gen = agent.chat(prompt);
  if (askMode) {
    // 等 `paused` 分片 = AI 已把问题抛给用户、本轮生成器已结束、进程空闲。
    // 这才是「提问窗口」；在此之前杀，测的是「LLM 未作答中途」另一件事。
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        process.stdout.write('NO_PAUSED_CHUNK\n');
        process.exit(4);
      }
      if (step.value?.type === 'paused') {
        process.stdout.write('ASK_PENDING\n');
        break;
      }
    }
    process.kill(process.pid, 'SIGKILL');
    return;
  }
  // 等到**真实正文分片**再杀，而不是「第一个 chunk」——实测首个 chunk 是 `thinking`
  // 相位事件，出现在用户消息落盘之前，此刻杀下去连轮都不存在，测的是「什么都没存」，
  // 而不是「进行中的轮存成什么样」。正文分片到达 = 已过 appendUser + LLM 已响应 = 崩溃窗口。
  for (;;) {
    const step = await gen.next();
    if (step.done) {
      process.stdout.write('NO_TEXT_CHUNK\n');
      process.exit(4);
    }
    if (step.value?.type === 'text') {
      process.stdout.write('TEXT_CHUNK\n');
      break;
    }
  }
  // 硬杀自己：不走 agent.close()、不 flush、不留 finally
  process.kill(process.pid, 'SIGKILL');
}

void main().catch((err: unknown) => {
  process.stderr.write(`CHILD_ERROR:${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(3);
});
