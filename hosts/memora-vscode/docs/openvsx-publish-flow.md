# Open VSX 发布流程（从零到「打 tag 自动发布」）

> **本文给谁看**：需要把 Memora VS Code 插件发到 Open VSX 的人（一次性配置，之后全自动）。
> **为什么做这个**：Open VSX 是 Eclipse 基金会运营的开源插件市场，Cursor / VSCodium / Windsurf /
> Trae 等编辑器都从它拉插件。**全程零信用卡**——这是它相对 VS Code Marketplace 最大的好处
> （Marketplace 的自动化路线要 Azure DevOps PAT，而 PAT 需要绑 Azure 订阅，且 2026-12-01 退役）。
>
> **总时长**：约 30 分钟操作 + 一次人工审核等待（无时间承诺，通常几天）。
> **不可逆的两步**：namespace 名字、Trusted Publisher 注册时填的 workflow 文件名——定下就不好改。

---

## 零、先记住这六条，能省你两小时

| # | 坑 | 后果 |
| - | ---- | ---- |
| 1 | **不签 Publisher Agreement** | 发布必然失败，且报错信息不直说原因——**第一大坑** |
| 2 | Eclipse 账号的 GitHub 用户名与登录 open-vsx.org 的 **不是同一个** | 两个系统连不上，卡在「看不到 Publisher Agreement 按钮」 |
| 3 | 想跳过「首发」直接上 OIDC | 不行。Trusted Publishing 的硬前置是**扩展已存在且 ≥1 个 active 版本**，首发必须用手动 token |
| 4 | 扩展已在 VS Marketplace，就直接 `ovsx publish` | 会被拒。Marketplace 上已存在的扩展，**必须先在 Open VSX 拿到 namespace ownership** 才能发同名 |
| 5 | 注册 Trusted Publisher 后**改 workflow 文件名** | 匹配失效（按**文件名**匹配，不是数字 ID），须删掉重注册 |
| 6 | 切到 OIDC 后**留着 `OVSX_PAT`** | PAT 优先级更高 ⇒ 等于没切。必须删掉 |

---

## 一、账号准备（一次性）

### 1. 注册 Eclipse 账号

打开 <https://accounts.eclipse.org/user/register> 注册。

⚠️ **两个必须填对的字段**：
- **GitHub Username**：填 `zooique`（必须与你登录 open-vsx.org 用的 GitHub 账号**完全一致**）
- 邮箱：用常用邮箱，需要收验证邮件

### 2. 用 GitHub 登录 Open VSX

打开 <https://open-vsx.org> → 右上角头像 → 用 **GitHub** 登录（不要用别的）。

### 3. 关联 Eclipse 账号

头像 → Settings → 找 **Log in with Eclipse** → 授权。
成功后页面会出现 **Show Publisher Agreement** 按钮。

> 看不到这个按钮 = 第 1 步的 GitHub 用户名没填对，或 Eclipse 账号没验证邮箱。

### 4. 签 Publisher Agreement（**不做这步后面全白做**）

点 **Show Publisher Agreement** → 拉到底 → **Agree**。

> 注意别和「Eclipse Contributor Agreement (ECA)」搞混——那是给 Eclipse 开源项目贡献代码用的，
> **不是**这个。

---

## 二、Token 与 namespace（一次性）

### 5. 生成 access token

头像 → Settings → **Access Tokens** → Generate New Token。
描述填 `memora-CI`（方便以后辨认是哪台机器/CI 用的）。

⚠️ **token 只显示一次**，关掉对话框就再也看不到。立刻存到密码管理器或 CI secret。

### 6. 创建 namespace

namespace 就是 Open VSX 上的「发布者」，对应 `package.json` 里的 `publisher` 字段。我们的是 `zooique`。

```bash
cd hosts/memora-vscode
npx ovsx create-namespace zooique -p 你的token
```

成功会输出 namespace 创建成功的提示。

> 如果提示「已存在」——说明有人（可能是以前的你）建过了。那就跳过这步。
> 但注意：**建了 namespace 只是 contributor，不是 owner**——下一步的 ownership 才是关键。

---

## 三、首发第一版（一次性，**必须用手动 token**）

### 7. 打包并发布

```bash
cd hosts/memora-vscode
npm run package                          # 产出 memora-vscode.vsix
npx ovsx publish memora-vscode.vsix -p 你的token
```

⚠️ **这一步不能用 OIDC**。Trusted Publishing 要求扩展已经存在且至少有一个 active 版本，
首发这一版必须用手动 token 推出去。

**验证成功**：打开 <https://open-vsx.org/extension/zooique/memora-vscode> 能看到插件页面。

⚠️ 此时页面上会有个提示「This namespace is not verified」——**这是正常的**，
因为你还只是 contributor，不是 owner。下一步解决。

---

## 四、申请 namespace ownership（一次性，等审核）

### 8. 发一个公开的 GitHub issue

打开 <https://github.com/EclipseFdn/open-vsx.org/issues/new>，选 **namespace** 模板，按模板填。

模板会问几个选项，我们命中**最好的那档**：

- ✅ The namespace is also a publisher account on the VS Code Marketplace,
  **and has an extension published there with a repo specified in its package.json**

理由：我们的 `package.json` 里有

```json
"repository": { "type": "git", "url": "git+https://github.com/zooique/memora.git" }
```

repo 的 org 是 `zooique`，与申请用的 GitHub ID **一致** ⇒ **不需要额外证明**，基本必过。

**Claim evidence 里照抄这段**（按实际改）：

```
Namespace: zooique
GitHub account: https://github.com/zooique
Repository: https://github.com/zooique/memora
Publisher: zooique（package.json 的 publisher 字段）
Extension name: memora-vscode

扩展已发布在 VS Code Marketplace：
https://marketplace.visualstudio.com/items?itemName=zooique.memora-vscode

package.json 的 repository 字段指向 github.com/zooique/memora，
org 与申请用的 GitHub ID 一致。
```

**审核**：Eclipse 管理员人工处理，公开透明，**没有时间承诺**（几天到几周）。
通过后 issue 会被打上 `granted` 标签，插件页面的「not verified」提示消失。

> 等待期间可以先做下一步之前的一切，并且 GitHub Release 自动发布那条链已经能用了。

---

## 五、注册 Trusted Publisher（一次性）

ownership 到手后：

### 9. 在 Open VSX 登记你的 workflow

头像 → Settings → **Trusted Publishers** → 选 namespace `zooique` → 填：

| 字段 | 填什么 |
| ---- | ------ |
| Provider | GitHub Actions |
| Owner | `zooique` |
| Repository | `memora` |
| Workflow filename | **`host-release.yml`** |
| Environment | 留空（我们的 workflow 没声明 environment） |

⚠️ **红线**：这里按**文件名**匹配。填了 `host-release.yml` 之后，
`.github/workflows/host-release.yml` **就不能改名了**（改名必须删掉这条注册重来）。
仓库名和 owner 是按**数字 ID** 记的（改仓库名没关系），但文件名是按字符串记的。

### 10. 删掉手动 token（关键！）

如果你在 CI 里配了 `OVSX_PAT` 或命令里带了 `--pat`，**必须删掉**。
PAT 的优先级高于 OIDC，留着等于没切换。

---

## 六、以后每次发版（全自动）

`host-release.yml` 里加一步（ownership 到手后我来加，或你自己加）：

```yaml
      - name: 发布到 Open VSX（Trusted Publishing，OIDC 零密钥）
        run: npx ovsx publish --trusted-publishing
        working-directory: hosts/memora-vscode
```

`permissions: id-token: write` 已经在 workflow 里声明好了，不用再改。

然后发版就是：

```bash
# 1. 先把内核发了（如果内核有变动）—— 宿主 workflow 会校验内核已先行发布
# 2. 改 hosts/memora-vscode/package.json 的 version
# 3. 提交 + 打 tag
git tag "vscode@0.2.0"
git push origin "vscode@0.2.0"
```

CI 跑完门禁 → 自动出 vsix → 挂 GitHub Release → 发到 Open VSX。

---

## 七、验证清单

| 阶段 | 怎么确认成了 |
| ---- | ------------ |
| 签了协议 | 个人设置页能看到 Publisher Agreement 已签 |
| namespace 建好 | <https://open-vsx.org/namespace/zooique> 能打开 |
| 首发成功 | <https://open-vsx.org/extension/zooique/memora-vscode> 能打开 |
| ownership 到手 | issue 被打 `granted`，插件页面的 unverified 提示消失 |
| Trusted Publisher 生效 | 打一个 tag 跑 CI，日志里出现 trusted publisher 相关输出且发布成功 |

---

## 八、当前状态与下一步

- ✅ VS Code Marketplace：已上架（手动上传），publisher `zooique`
- ❌ Open VSX：**未上架**——等本文流程走完
- 🔒 **VS Marketplace 自动化：定案不做，保持手动上传**（2026-10-23 复核）。理由：
  ① 干净路线 `vsce publish --oidc`（GitHub OIDC 直连 Marketplace、零密钥、免订阅）
    尚未进 @vscode/vsce 稳定版，且 Marketplace 侧**没有策略注册 UI**
    （`microsoft/vscode-vsce#976` 类问题）→ 现在不可用；
  ② 稳路线 `vsce publish --azure-credential`（Entra 托管标识）需要 **Azure 订阅**
    ⇒ 重新触发已撞过的「国外银行卡」拦路石，个人开发者负 ROI；
  ③ 旧路线 `vsce publish -p $VSCE_PAT` 现在能用，但全局 PAT **2026-12-01 退役**
    （仅剩约 6 周），搭了即拆。
  手动上传已验证可用（0.1.0 上架），每版 marketplace.visualstudio.com/manage 传一次
  .vsix，成本可忽略 ⇒ 手动为最优解。未来唯一可升级路径是 `--oidc` 路线，
  待 Marketplace 开放策略注册 UI 后再评估（约 2026-12-01 前后回看）。
- ✅ GitHub Release 自动分发：已能用（打 `vscode@*` tag 即出包）

> 相关：`.github/workflows/host-release.yml`（宿主发布链）、
> `tasks/待完成任务.md` 的 `REL-TAG-AUTO` 条（方案与待办清单）。
