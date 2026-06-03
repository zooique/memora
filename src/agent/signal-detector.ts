/**
 * 实时信号检测器
 *
 * 目的：在用户输入中识别"值得立即归档"的强信号，避免漏掉关键信息
 *
 * 设计思路：
 *   - 用轻量正则匹配用户表达"个人信息/偏好/事实"的高置信度语言模式
 *   - 命中后由 Agent 触发即时归档（fire-and-forget）
 *   - 不命中不触发，依靠 Lazy 启动扫描兜底完整性
 *
 * 与"每 N 轮阈值触发"相比：
 *   - 优势：响应即时（用户刚说完就归档），无 LLM 实时调用延迟
 *   - 限制：只能识别"显式表达"的信息；隐性偏好（如"我喜欢简洁"）靠 Lazy 兜底
 *
 * 详见 docs/基础设计文档/00-记忆归档原则-v1.0.md + ADR-013
 */

/**
 * 强信号正则集合
 *
 * 命中模式说明：
 * - "我叫 / 我是 / 我的名字": 用户主动透露身份
 * - "记住 / 记一下 / 帮我记": 显式要求持久化
 * - "我 + 是 + 名词": 自我介绍或关系声明（"我是工程师"、"我是你爸"）
 * - "我 + 喜欢/讨厌/偏好": 表达偏好
 * - "我 + 用/使用 + 工具": 技术栈声明
 * - "我们 + 决定/确定/约好": 决策标记
 * - "我 + 在/住/来自": 地理位置/状态
 *
 * 故意排除：
 * - 纯问候（"你好"）
 * - 询问（"你叫什么"）
 * - 闲聊（"今天天气不错"）
 */
const SIGNAL_PATTERNS: RegExp[] = [
  // 自我介绍 / 身份
  /我[叫是][^，。,.!！?？\s]{1,20}/u, // "我叫张三" / "我是张老师"
  /我的名字[是叫]?/u,
  /你[可以能]叫我/u,
  // 显式记忆请求
  /[请帮]?记住[一下这那]?/u,
  /记[一]?[下]/u,
  /别[不要]?忘[了记]?/u, // 别忘、别忘了、别忘记
  /不要[忘忘]?记/u, // 不要忘、不要忘记
  /以后[再说]?[一龥]?要/u,
  // 偏好 / 习惯（要求"喜欢/讨厌/偏好"动词必须出现）
  /我[比较更]?[喜欢爱讨厌]/u, // 我喜欢、我比较喜欢、我更讨厌
  /我的[偏好习惯][是为是]?/u,
  // 技术栈 / 工具（要求"用/使"动词必须出现）
  /我(一般|主要|常用|习惯)?[用使][着了]?/u, // 我用、我使用、我一般用
  /我[的]?项目[是是用]?/u,
  // 决策 / 约定
  /我们[决定确定约定]/u,
  /就这么[定了说]/u,
  // 地理位置 / 状态
  /我[在住来自][在]?/u, // 我住、我住在、我来自
];

/**
 * 检测用户输入是否包含"强信号"
 *
 * @param userInput 用户原始输入
 * @returns 是否命中强信号
 */
export function detectMemorableSignal(userInput: string): boolean {
  if (!userInput || typeof userInput !== 'string') return false;
  const text = userInput.trim();
  if (text.length < 4) return false; // 太短不可能含强信息
  if (text.length > 500) return false; // 过长是叙述/复制粘贴，不当信号处理

  for (const pattern of SIGNAL_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

/**
 * 提取信号中的"主题名"（用于 Memory.name 字段）
 *
 * 示例：
 * - "我叫张三" → "自我介绍"
 * - "记住我的生日是 5 月 20 号" → "个人事实"
 * - "我喜欢用 TypeScript" → "技术偏好"
 * - "我住在上海" → "地理位置"
 *
 * 用于归档时给生成的 Memory 记录一个可读的 name。
 * 优先匹配最具体的类别，匹配不到则返回默认 "实时记录"。
 *
 * @param userInput 用户原始输入
 * @returns 简短的主题分类名
 */
export function extractSignalName(userInput: string): string {
  const text = userInput.trim();

  if (/我的名字[是叫]?/u.test(text) || /你[可以能]叫我/u.test(text)) {
    return '自我介绍';
  }
  if (/我[叫是][^，。,.!！?？\s]{1,20}/u.test(text)) {
    return '自我介绍';
  }
  if (
    /[请帮]?记住[一下这那]?/u.test(text) ||
    /记[一]?[下]/u.test(text) ||
    /别[不要]?忘[了记]?/u.test(text) ||
    /不要[忘忘]?记/u.test(text)
  ) {
    return '用户主动记忆';
  }
  if (/我[比较更]?[喜欢爱讨厌]/u.test(text) || /我的[偏好习惯]/u.test(text)) {
    return '个人偏好';
  }
  if (/我(一般|主要|常用|习惯)?[用使]/u.test(text) || /项目[是是用]/u.test(text)) {
    return '技术栈';
  }
  if (/我们[决定确定约定]/u.test(text) || /就这么[定了说]/u.test(text)) {
    return '用户决策';
  }
  if (/我[在住来自]/u.test(text)) {
    return '地理位置';
  }

  return '实时记录';
}
