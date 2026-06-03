/**
 * 流式 Markdown 渲染器（A-103）
 *
 * 在 LLM 流式输出中逐字符渲染 Markdown 为 ANSI 终端格式。
 * 详见 方案-行动侧打磨-v1.0.md §四
 *
 * 核心约束：
 *   - 流式：不做 AST 解析，仅用状态机逐字符处理
 *   - 不做行缓冲（仅 heading 确认时暂存 #）
 *   - fence 长度匹配：记录 opening fence 反引号数，只匹配等长 closing fence
 *   - 代码块内 ANSI 剥离
 *   - 零新依赖（仅 Node.js 内置）
 *
 * 状态：
 *   - NORMAL：普通文本（直接透传）
 *   - CODE_FENCE：代码块内（灰色输出，ANSI 剥离）
 *
 * 支持的 Markdown 元素：
 *   - # 标题 → bold + cyan
 *   - ``` 代码块 → dim 灰色
 *   - ` 行内代码 → dim 灰色
 *   - - /* 列表 → cyan • 前缀
 *   - ** 粗体 → bold
 *   - * 斜体 → italic（由终端处理）
 */
import pc from 'picocolors';

/** 渲染器状态 */
type RenderState = 'NORMAL' | 'CODE_FENCE';

/**
 * Markdown 流式渲染器
 *
 * 使用方式：
 *   const md = new MarkdownRenderer();
 *   for (const chunk of stream) {
 *     process.stdout.write(md.feed(chunk));
 *   }
 *   process.stdout.write(md.flush());
 */
export class MarkdownRenderer {
  /** 当前状态 */
  private state: RenderState = 'NORMAL';

  /** heading 开头缓冲（# 在行首时暂存，等待下一字符确认） */
  private headingBuffer = '';

  /** 行内代码缓冲 */
  private inlineCodeBuffer = '';

  /** 粗体缓冲 */
  private boldBuffer = '';

  /** 斜体缓冲 */
  private italicBuffer = '';

  /** opening fence 的反引号数（用于匹配等长 closing fence） */
  private fenceLength = 0;

  /** 代码块内是否在行首（用于检测 closing fence） */
  private codeLineStart = true;

  /** 代码块行首的 fence 候选缓冲 */
  private fenceCandidate = '';

  /** 当前行内容（用于行首检测） */
  private currentLine = '';

  /** 代码块计数器 */
  private codeBlockCount = 0;

  /** 当前代码块内的 ANSI 剥离缓冲 */
  private codeAnsiBuffer = '';

  /**
   * 处理一个文本块
   *
   * @param chunk 来自 LLM 流式输出的原始文本
   * @returns 渲染后的 ANSI 字符串（可直接 write 到 stdout）
   */
  feed(chunk: string): string {
    let output = '';

    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]!;

      switch (this.state) {
        case 'NORMAL':
          output += this.feedNormal(ch);
          break;

        case 'CODE_FENCE':
          output += this.feedCodeFence(ch);
          break;
      }
    }

    return output;
  }

  /**
   * 清理残留状态，在流结束后调用
   * @returns 残留字符（被缓冲但未输出的内容）
   */
  flush(): string {
    let output = '';

    // heading 缓冲残留
    if (this.headingBuffer.length > 0) {
      output += this.headingBuffer;
      this.headingBuffer = '';
    }

    // 行内代码缓冲残留
    if (this.inlineCodeBuffer.length > 0) {
      output += pc.dim(this.inlineCodeBuffer);
      this.inlineCodeBuffer = '';
    }

    // 粗体缓冲残留
    if (this.boldBuffer.length > 0) {
      output += this.boldBuffer;
      this.boldBuffer = '';
    }

    // 斜体缓冲残留
    if (this.italicBuffer.length > 0) {
      output += this.italicBuffer;
      this.italicBuffer = '';
    }

    // 代码块内未闭合 → 强制输出残留（灰色）
    if (this.state === 'CODE_FENCE') {
      // 代码块未正常闭合，输出残留
      if (this.codeAnsiBuffer.length > 0) {
        output += pc.dim(this.codeAnsiBuffer);
        this.codeAnsiBuffer = '';
      }
      this.state = 'NORMAL';
      this.fenceLength = 0;
      this.codeLineStart = true;
      this.fenceCandidate = '';
    }

    // 未完成的换行
    if (this.currentLine.length > 0) {
      // 行首有 heading 缓冲
      if (this.headingBuffer.length > 0) {
        output = this.headingBuffer + output;
      }
      // 已输出过换行的情况不需要额外处理
    }

    this.currentLine = '';
    return output;
  }

  /**
   * 获取代码块统计信息
   * @returns 渲染期间遇到的代码块数量
   */
  getCodeBlockCount(): number {
    return this.codeBlockCount;
  }

  // ── NORMAL 状态处理 ────────────────────────────────────

  /**
   * NORMAL 状态下逐字符处理
   */
  private feedNormal(ch: string): string {
    // 换行 → 检查行首状态
    if (ch === '\n') {
      return this.commitNormalLine(ch);
    }

    // 行首检测
    if (this.currentLine === '') {
      return this.feedNormalLineStart(ch);
    }

    // 行内检测
    return this.feedNormalInline(ch);
  }

  /**
   * NORMAL 状态下行首字符处理
   *
   * 触发条件：currentLine 为空（刚完成换行或刚开始）
   */
  private feedNormalLineStart(ch: string): string {
    // 翠幕天罗 P3-2 修复：行内代码缓冲非空时委托给 handleInlineCode
    // 避免行首 ` 的后继字符被当作普通文本渲染
    if (this.inlineCodeBuffer.length > 0) {
      return this.handleInlineCode(ch);
    }

    // # → 暂存为 heading 候选
    if (ch === '#' && this.inlineCodeBuffer === '') {
      this.headingBuffer = '#';
      return '';
    }

    // heading 缓冲中
    if (this.headingBuffer.length > 0) {
      this.headingBuffer += ch;

      // ## → 多级标题
      if (ch === '#') {
        return '';
      }

      // # + 空格 → 确认标题
      if (ch === ' ') {
        const level = this.headingBuffer.length - 1;
        const prefix = '#'.repeat(level) + ' ';
        this.currentLine = '';
        this.headingBuffer = '';
        return pc.bold(pc.cyan(prefix));
      }

      // # 后跟非空格/非# → 不是标题，还原
      const accumulated = this.headingBuffer;
      this.headingBuffer = '';
      this.currentLine = accumulated;
      return accumulated;
    }

    // ` → 行内代码开始
    if (ch === '`' && !this.isEscaped()) {
      // 检测是否为 fence：需要前一个字符是换行
      // fence 由三个反引号触发，这里先积累看看
      this.inlineCodeBuffer = '`';
      return '';
    }

    // - 或 * → 列表项
    if ((ch === '-' || ch === '*') && this.inlineCodeBuffer === '') {
      this.currentLine = ch;
      // 暂不输出，等待空格确认
      return pc.cyan('• ');
    }

    // ** → 粗体
    if (ch === '*' && this.boldBuffer === '' && this.italicBuffer === '') {
      this.italicBuffer = '*';
      return '';
    }

    this.currentLine = ch;
    return ch;
  }

  /**
   * NORMAL 状态下行内字符处理
   *
   * 触发条件：currentLine 非空
   */
  private feedNormalInline(ch: string): string {
    // 行内代码中
    if (this.inlineCodeBuffer.length > 0) {
      return this.handleInlineCode(ch);
    }

    // 粗体/斜体中
    if (this.boldBuffer.length > 0 || this.italicBuffer.length > 0) {
      return this.handleFormatting(ch);
    }

    // ` → 行内代码开始
    if (ch === '`' && !this.isEscaped()) {
      this.inlineCodeBuffer = '`';
      return '';
    }

    // * → 斜体或粗体候选
    if (ch === '*') {
      this.italicBuffer = '*';
      return '';
    }

    this.currentLine += ch;
    return ch;
  }

  /**
   * NORMAL 状态的换行处理
   */
  private commitNormalLine(newline: string): string {
    // 如果正在内联代码中或格式化中，先关闭
    let flushed = '';

    if (this.inlineCodeBuffer.length > 1) {
      flushed += pc.dim(this.inlineCodeBuffer.slice(1));
      this.inlineCodeBuffer = '';
    }

    if (this.boldBuffer.length > 0) {
      flushed += this.boldBuffer;
      this.boldBuffer = '';
    }

    if (this.italicBuffer.length > 0) {
      flushed += this.italicBuffer;
      this.italicBuffer = '';
    }

    this.currentLine = '';
    return flushed + newline;
  }

  /**
   * 处理行内代码
   */
  private handleInlineCode(ch: string): string {
    this.inlineCodeBuffer += ch;

    // 检测三个反引号 → 可能是 fence
    if (this.inlineCodeBuffer === '```') {
      // fence 开始
      this.inlineCodeBuffer = '';
      this.fenceLength = 3;
      this.state = 'CODE_FENCE';
      this.codeLineStart = true;
      this.fenceCandidate = '';
      this.codeAnsiBuffer = '';
      this.codeBlockCount++;
      // 查找语言标签到换行
      return pc.dim('```');
    }

    // 遇到空格或标点 → 不是 fence，是行内代码
    if (this.inlineCodeBuffer.length === 2 && ch !== '`') {
      const accumulated = this.inlineCodeBuffer;
      this.inlineCodeBuffer = '';
      this.currentLine += accumulated;
      return accumulated;
    }

    // 关闭反引号 → 结束行内代码
    if (ch === '`' && this.inlineCodeBuffer.length > 1) {
      // 第二个反引号可能关闭 `code` 或形成 ```
      // 检查前面是否有足够的反引号
      const codeContent = this.inlineCodeBuffer.slice(1, -1); // 去掉首尾的 `
      this.inlineCodeBuffer = '';
      return pc.dim(codeContent);
    }

    return '';
  }

  /**
   * 处理粗体/斜体格式
   */
  private handleFormatting(ch: string): string {
    // 斜体缓冲中
    if (this.italicBuffer.length > 0 && this.boldBuffer === '') {
      this.italicBuffer += ch;

      if (this.italicBuffer === '**') {
        // 第二个 * → 升级为粗体候选
        this.boldBuffer = '**';
        this.italicBuffer = '';
        return '';
      }

      if (ch === '*' && this.italicBuffer.length > 1) {
        // 关闭斜体
        const content = this.italicBuffer.slice(1, -1);
        this.italicBuffer = '';
        return content; // 斜体由终端处理
      }

      // 遇到空格或字母后确认不是格式标记
      if (this.italicBuffer.length > 2 && !/^[*]+$/.test(this.italicBuffer)) {
        const accumulated = this.italicBuffer;
        this.italicBuffer = '';
        this.currentLine += accumulated;
        return accumulated;
      }

      return '';
    }

    // 粗体缓冲中
    if (this.boldBuffer.length > 0) {
      this.boldBuffer += ch;

      if (ch === '*' && this.boldBuffer.endsWith('**')) {
        // 关闭粗体（**...**）
        const content = this.boldBuffer.slice(2, -2);
        this.boldBuffer = '';
        return pc.bold(content);
      }

      // 过长 → 不是格式标记
      if (this.boldBuffer.length > 10) {
        const accumulated = this.boldBuffer;
        this.boldBuffer = '';
        this.currentLine += accumulated;
        return accumulated;
      }

      return '';
    }

    return ch;
  }

  /**
   * 检测反引号是否被转义（\`）
   */
  private isEscaped(): boolean {
    return this.currentLine.endsWith('\\');
  }

  // ── CODE_FENCE 状态处理 ────────────────────────────────

  /**
   * CODE_FENCE 状态下逐字符处理
   *
   * 记录 opening fence 反引号数（fenceLength），
   * 只匹配等长的 closing fence 才能关闭代码块。
   */
  private feedCodeFence(ch: string): string {
    this.codeAnsiBuffer += ch;

    // 换行 → 重置行首检测，输出当前行
    if (ch === '\n') {
      this.codeLineStart = true;
      this.fenceCandidate = '';
      const line = this.stripAnsi(this.codeAnsiBuffer);
      // 翠幕天罗 P3-1 修复：每次输出后清空缓冲区，防止内容重复
      this.codeAnsiBuffer = '';
      return pc.dim(line);
    }

    // 行首：检测 closing fence
    if (this.codeLineStart) {
      if (ch === '`') {
        this.fenceCandidate = '`';
        this.codeLineStart = false;
        return '';
      }

      // 不是反引号 → 不是 closing fence，输出当前字符
      this.codeLineStart = false;
      this.fenceCandidate = '';
      const char = this.stripAnsi(this.codeAnsiBuffer);
      this.codeAnsiBuffer = '';
      return pc.dim(char);
    }

    // fence 候选匹配中
    if (this.fenceCandidate.length > 0) {
      if (ch === '`') {
        this.fenceCandidate += '`';

        // 反引号数 = fenceLength → 匹配成功，退出代码块
        if (this.fenceCandidate.length === this.fenceLength) {
          // 翠幕天罗 P4-1 修复：保存 closing fence 内容后再清空
          const closingFence = this.fenceCandidate;
          this.state = 'NORMAL';
          this.codeLineStart = true;
          this.fenceCandidate = '';
          this.fenceLength = 0;
          const stripped = this.stripAnsi(this.codeAnsiBuffer);
          this.codeAnsiBuffer = '';
          // 输出代码内容（灰色）+ closing fence（灰色）
          return stripped + pc.dim(closingFence);
        }

        // 反引号数 < fenceLength → 继续等待
        return '';
      }

      // 反引号数 < fenceLength 但下一个字符不是 ` → 不是 closing fence
      // 把缓冲的反引号输出
      const accumulated = this.fenceCandidate + ch;
      this.fenceCandidate = '';
      // 注意：此时 codeAnsiBuffer 包含了累积的反引号+当前字符，
      // 但我们已经把 fenceCandidate 单独取出来了
      // 只需要输出 fenceCandidate + ch 这部分增量
      return pc.dim(this.stripAnsi(accumulated));
    }

    // 非行首普通字符 → 输出当前字符
    const char = this.stripAnsi(this.codeAnsiBuffer);
    this.codeAnsiBuffer = '';
    return pc.dim(char);
  }

  /**
   * 剥离 ANSI 转义序列
   *
   * 代码块内如果混入 ANSI 颜色码会干扰渲染，
   * 所以先剥离所有 ANSI 序列再包裹灰色。
   */
  private stripAnsi(text: string): string {
    const result = text.replace(/\x1b\[[0-9;]*m/g, '');
    this.codeAnsiBuffer = result;
    return result;
  }
}
