/**
 * CLI 交互层 — 基于 readline 的终端交互实现
 *
 * 将 index.ts 中的 readline 逻辑提取为 IInteraction 实现，
 * 使交互层可替换（未来 Electron 实现只需提供新的 IInteraction）。
 */
import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';
import type { IInteraction, InputHandler, CloseHandler } from '../interaction.js';

/**
 * CLI 交互层
 *
 * 使用 Node.js readline 从 stdin 读取用户输入，输出到 stdout。
 */
export class CliInteraction implements IInteraction {
  private rl: Interface | null = null;
  private inputHandler: InputHandler | null = null;
  private closeHandlers: Set<CloseHandler> = new Set();

  start(handler: InputHandler): void {
    this.inputHandler = handler;
    this.rl = createInterface({ input: process.stdin, output: process.stdout });

    this.rl.on('line', (line) => {
      const text = line.trim();
      if (!text) return;
      this.inputHandler?.({ text });
    });

    this.rl.on('close', () => {
      for (const handler of this.closeHandlers) {
        handler();
      }
    });
  }

  output(text: string): void {
    process.stdout.write(text);
  }

  error(text: string): void {
    process.stderr.write(text + '\n');
  }

  stop(): void {
    this.rl?.close();
    this.rl = null;
    this.inputHandler = null;
  }

  onClose(handler: CloseHandler): void {
    this.closeHandlers.add(handler);
  }
}
