/**
 * 代码执行提供者接口定义：让 memora 内核具备可注入的通用代码执行能力。
 * 宿主实现 ICodeExecutionProvider 注入沙箱执行器（接口注入，遵循 IWebSearchProvider 模式；零依赖）。
 *
 * 与 run_skill_script 的区别：
 * - run_skill_script 绑定技能目录内的脚本文件（执行器由内核内置，子进程沙箱）；
 * - run_code 是通用的「模型写代码 → 执行 → 结果回填」能力，执行器**由宿主注入**。
 *
 * 安全注意：内核不内置沙箱执行器（保持零依赖），执行器的隔离等级与可用语言由宿主决定。
 */

/** 代码执行结果 */
export interface CodeExecutionResult {
  /** 标准输出 */
  stdout: string;
  /** 标准错误 */
  stderr: string;
  /** 退出码（0 = 成功） */
  exitCode: number;
  /** 是否超时 */
  timedOut: boolean;
  /**
   * 是否被调用方中断（turn 中止 signal 触发）。
   *
   * 与 `timedOut` 分列（不是同义合并）：超时是执行器自己到点，中断是用户/上层主动中止——
   * 文案与归因都不同，合并会让「用户按了停止」被报成「执行超时」。
   */
  aborted?: boolean;
  /**
   * 中断时进程树终止未确认的原因（权限不足 / 目标不可终止等）。
   * 只在 `aborted` 为真时有意义；非空 ⇒ 结果文案必须如实告知可能仍有残留，不假装已终止。
   */
  terminationError?: string;
}

/** 代码执行选项 */
export interface CodeExecutionOptions {
  /** 执行超时（毫秒，默认 30000，最大 120000） */
  timeoutMs?: number;
  /** 工作目录（可选，未传由执行器决定） */
  cwd?: string;
  /**
   * 中断信号（可选）：执行器监听 abort 后必须终止自己 spawn 的子进程树，
   * 并在终止完成后才 settle。宿主实现负责调用内核导出的 `killProcessTree`
   * （禁止在宿主侧自写一份杀树实现——那会与内核超时路径形成双轨）。
   */
  signal?: AbortSignal;
}

/**
 * 代码执行提供者接口：宿主实现并注入 AgentOptions.codeExecutionProvider 提供执行能力；
 * 未注入时 Agent 不会暴露 run_code 工具给 LLM。
 */
export interface ICodeExecutionProvider {
  /**
   * 执行器支持的语言清单（可选声明，命令执行能力方案 §10.4-①(b)）：小写语言别名
   * （如 ["javascript", "js", "nodejs", "node"]）。
   * 声明后内核 run_code 工具描述按实际生成「支持：a、b、c」——消灭「描述承诺 python、
   * 宿主只支持 JS」的描述与现实不符（§10.3 实锤）；未声明（undefined / 空数组）→
   * 描述退化为现行去承诺文案，对模型不列举（零感知，向后兼容，命令执行能力方案 §11.6 拍板）。
   * 支持列表真源在本字段（宿主执行器自知），内核与工具描述均从它派生，不双写。
   */
  readonly supportedLanguages?: readonly string[];
  /** 执行代码字符串，返回 stdout/stderr/exitCode/timedOut */
  execute(
    code: string,
    language: string,
    options?: CodeExecutionOptions,
  ): Promise<CodeExecutionResult>;
}
