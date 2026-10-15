/**
 * 登录墙识别（SEARCH-QUALITY-1 P2-1）
 *
 * 问题：HTTP 200 的登录页被 `stripHtmlToText` 洗成「正文」——LLM 拿到一堆
 * 「请登录 / 输入密码 / 注册新账号」的表单碎片，还以为是目标页面内容
 * （「搜不准」的第二种形态：搜到了、也抓到了，但抓到的是一堵墙）。
 *
 * 判据（保守取向——**漏判 = 现状（可读页照常交付），误判 = 藏起可读页**，
 * 故宁漏勿误，两条路径都要求「不像普通内容」才判墙）：
 * 1. **URL 强信号**：host/path 的**段边界**命中 login/signin/logon/passport/sso
 *    （段边界 = 段首/段尾由 `/` `.` `?` 或串首尾界定——防 `how-to-login`
 *    教程、`mylogin` 之类词内子串误判；查询参数**值**里的 login 不算；
 *    `#fragment` 先剥除——锚点是**页内位置**不是页面身份，`article#login` 是文章）。
 *    只认重定向后的 finalUrl（`FetchedPage.url`）：带登录态参数的原始 URL
 *    常常恰恰是要抓的页面，不能拿它判墙。
 * 2. **弱信号组合**：标题登录词 **且** 正文密码词 **且** 正文很短
 *    （< `LOGIN_WALL_MAX_CONTENT_CHARS`）——单标题命中放行（教程/文档页
 *    常谈「如何登录」），三条件同时满足才判墙。
 *    ⚠️ 长度判据只在**正文未被截断到阈值以下**时可信：调用方须传 `contentCap`
 *    （本次抓取的截断上限），cap < 阈值时「短正文」可能是截断假象 → 弱信号禁用
 *    （强信号不受影响——URL 身份与正文长短无关）。
 *
 * 纯函数：无 IO、零依赖，判据集中单点（toolExecutor web_fetch case 消费）。
 * 命中后由调用方返回 hedged 提示（「可能」需登录——判据是启发式，不谎称确定）；
 * 「这页是否抓取失败」不归本函数（调用方以 `FetchedPage.fetchFailed` 先行排除）。
 */

/**
 * URL 登录段（段边界匹配）
 *
 * 段界定符：串首 `^`、`/`、`.`、`?`、串尾 `$`（`#fragment` 在判定前已剥除——
 * 锚点是页内位置不是页面身份，`article#login` 是文章不是登录页）。
 * `-` 刻意**不在**界定符内——`how-to-login` / `sign-in-page` 这类连字符复合词
 * 是教程页的高频形态，放行它们（漏判代价）优于误判（藏可读页）。
 * `sign-in` 以显式 alternation 收录（它是登录墙的常见路径形态）。
 */
const URL_LOGIN_SEGMENT_RE =
  /(?:^|\/|\.|\?)(?:login|logon|signin|sign-in|passport|sso)(?:\/|\.|\?|$)/i;

/** 标题登录词（中英；不含「密码」——谈密码的文章标题不应触发弱信号） */
const TITLE_LOGIN_RE = /登录|登陆|登入|sign\s*in|log\s*in|logon/i;

/** 正文密码词（登录表单/提示语特征） */
const PASSWORD_WORD_RE = /密码|password|passcode/i;

/**
 * 弱信号组合的正文长度上限（字符）
 *
 * 登录墙表单页天然短（几个输入框 + 按钮）；长正文即使带登录词也更是教程/文档。
 */
const LOGIN_WALL_MAX_CONTENT_CHARS = 600;

/**
 * 判定抓取结果是否为登录墙（保守启发式，见文件头「宁漏勿误」）
 *
 * @param finalUrl 重定向后的实际 URL（`FetchedPage.url`；空串 = 无 URL 信息）
 * @param title 页面标题（清洗后）
 * @param content 页面正文（清洗后）
 * @param contentCap 本次抓取的正文截断上限（toolExecutor 传 maxChars）：
 *   小于弱信号阈值时「短正文」可能是截断假象 → 弱信号禁用（强信号照常）；
 *   缺省 = 视为未截断（向后兼容既有调用形状）
 * @returns true = 判为登录墙（调用方应明示不可读并引导换源）
 */
export function isLoginWallPage(
  finalUrl: string,
  title: string,
  content: string,
  contentCap?: number,
): boolean {
  // 强信号：URL 段边界命中即判（不要求正文佐证——登录态 URL 抓到 200 就是墙）。
  // 先剥 #fragment：锚点是页内位置不是页面身份（article#login 是文章）；
  // split('#') 安全——合法 URL 中首个 # 即 fragment 起点（RFC 3986，查询串内 # 同义）
  const urlWithoutFragment = finalUrl.split('#')[0] ?? finalUrl;
  if (urlWithoutFragment && URL_LOGIN_SEGMENT_RE.test(urlWithoutFragment)) return true;
  // 弱信号组合：标题登录词 + 正文密码词 + 短正文，三条件同时满足才判。
  // contentCap < 阈值 → 长度判据失真（截断制造伪短正文）→ 整组禁用（宁漏勿误）
  const weakSignalsUsable = contentCap === undefined || contentCap >= LOGIN_WALL_MAX_CONTENT_CHARS;
  if (
    weakSignalsUsable &&
    title &&
    TITLE_LOGIN_RE.test(title) &&
    content &&
    PASSWORD_WORD_RE.test(content) &&
    content.length < LOGIN_WALL_MAX_CONTENT_CHARS
  ) {
    return true;
  }
  return false;
}
