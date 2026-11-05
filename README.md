# dsh-plugin-hop · 跨机接力

<img src="icon.svg" width="84" height="84" alt="跨机接力图标">

[English](README.en.md) | 中文

**插件版本** `0.4.1` · **DSH 版本要求** `>= 0.2.1-rc.5`

一个私有仓库装下所有项目。公司电脑 `/hop push`，家里点一下「下载」，会话、待办、附件和代码一起过去，点开会话接着干，不用再跟模型解释「做到哪了」。

## 它解决什么

DSH 的会话是**事件日志**：每一轮对话、工具调用、待办（`todo_write`）、目标（`goal`）、压缩摘要都在里面。把这份日志搬到另一台机器、挂回同一个项目，模型的上下文就是完整的——不是「总结一下再交接」，是原样续上。

| 内容 | 走哪 | 说明 |
|---|---|---|
| 会话、待办、目标、附件 | 私有 relay 仓库 | 插件导出/导入 |
| 项目代码 | 项目自己的 git | 快照提交到 `hop/<设备名>` 分支 |

## 安装

**方式一：npm**

在 DSH 的「添加插件」里填 `dsh-plugin-hop`，安装后刷新页面（⌘R）。

**方式二：源码**

1. `git clone <本仓库地址>` 到任意目录。
2. 在 DSH 里安装：`plugin_manager` → `install_bundle`，目标填这个目录。
3. 刷新页面（⌘R），侧边栏出现「接力」图标。

> 需要 DSH `>= 0.2.1-rc.5`；两台机器保持一致，会话格式跟随 DSH 版本。

## 配置

### 1. 准备一个私有仓库

在 GitHub 或 Gitee 新建一个**私有**仓库，只放接力状态，不放项目代码。例如 `dsh-hop-myrepo`。

### 2. 让这台电脑能直接访问它

如果这台电脑已经配过 git 凭据（`git ls-remote <仓库地址>` 能直接返回且不报错），跳过这一步。

**SSH**

```bash
ssh-keygen -t ed25519 -C "you@example.com"   # 已有密钥可跳过
cat ~/.ssh/id_ed25519.pub
```

把输出的公钥加到平台：

- GitHub：Settings → SSH and GPG keys → New SSH key
- Gitee：设置 → SSH 公钥

验证：

```bash
ssh -T git@github.com     # 或 git@gitee.com
```

> 返回 `successfully authenticated` 或欢迎语即成功；`Permission denied` 说明公钥没加对。

**HTTPS + 令牌**

```bash
# macOS
git config --global credential.helper osxkeychain
# Windows
git config --global credential.helper manager
# Linux
git config --global credential.helper libsecret

printf 'protocol=https\nhost=github.com\nusername=<账号>\npassword=<令牌>\n\n' | git credential approve
```

Gitee 把 `host` 换成 `gitee.com`。令牌在平台后台生成，GitHub 需要 `repo` 权限，Gitee 需要 `projects` 权限。

验证：

```bash
git ls-remote <仓库地址>
```

有 refs 输出、没有报错，就说明这台电脑已经能访问该仓库。

### 3. 填进插件

点面板右上角「设置仓库」，或直接：

```
/hop setup <仓库地址>
```

保存时会立刻 clone 一次做验证。认证失败会显示 git 的原始报错（常见 401 / 403 / `Permission denied`），按报错回到第 2 步修正即可。

面板里可以直接选 Gitee / GitHub、SSH 或 HTTPS；连不上时会给出「生成密钥」按钮、可一键复制的公钥和平台设置页链接，不需要自己敲命令。

之后**所有项目**共用这个仓库，不用再配第二次。

## 界面

侧边栏位置：

<img src="docs/images/sidebar.png" width="240" alt="侧边栏的接力图标">

第一次使用，先填仓库地址：

<img src="docs/images/setup.png" width="680" alt="设置接力仓库">

之后是项目清单，点「下载」：

<img src="docs/images/panel.png" width="720" alt="接力面板">

> 上图为示意图，实际界面跟随主题的深浅色。

## 使用

**面板**：左侧「接力」→ 项目清单（绿点=本机已有，灰点=没下载）→ 点「下载」。下载在后台跑，面板轮询进度，完成后自动刷新。

**命令**：

```
/hop              看清单
/hop push [备注]  把当前项目交上去
/hop pull 名字    在这台电脑下载
/hop status       看本机配置
```

`/hop pull` 不给名字时，仓库里只有一个项目就直接拉它；默认下载到 `~/dsh-projects/<项目名>`。

**工具**：`hop_setup`、`hop_push`、`hop_pull`、`hop_list`、`hop_status`——也可以直接说「把这个项目交棒到另一台电脑」。

**子会话**：push 自动带上当前会话派生的所有子代理会话，pull 时按父子顺序重建。

**关掉的会话**：给 `session` 参数即可，例如 `hop_push({"session":"session-cca62e...","project":"biao-live-v3"})`。

## 同步了什么

```
relay 仓库
├── relay.json                         # 项目清单：名字、时间、会话数、来源路径
└── projects/<项目名>/
    ├── manifest.json                  # 设备、时间、基线 commit、会话/附件清单
    ├── sessions/<id>.json.zst         # 会话日志（header + 每条事件，压缩 JSONL）
    └── attachments/<sha256>.bin       # 事件引用的图片/文件，内容寻址
```

会话包是压缩文本（157 轮约 6MB），附件按实际引用复制；导入时旧绝对路径整串改写成新目录。

## 常见问题

**代码没带过去？** 项目不是 git 仓库或没有 `origin`，插件会跳过代码同步并在输出里写明。

**路径不一样？** pull 时给目标目录，或使用默认的 `~/dsh-projects/<名字>`；日志里的旧路径会被整串替换。

**项目根和会话工作目录不一致？** `--project` 只影响代码同步，会话路径以**会话的工作目录**为准；需要路径完全对齐时，让会话工作目录就是项目目录。

**模型 key / 插件 / 技能没过去？** 这些**不同步**，也不该同步。每台机器各配一次，这是唯一绕不过去的准备。

**两边都改了同一个会话？** 接力是「交棒」，不是实时协同。会话还在本机跑时会导入成副本，历史分叉会另开新会话，绝不静默合并。

**仓库太大？** 长会话加大量截图会到几百 MB，建议阶段性新开会话，或定期清理旧项目。

**push 认证失败？** 插件里所有 git 命令都禁用了交互提示，认证不通直接报错；先在终端执行一次 `git ls-remote <仓库地址>` 确认凭据可用。

## 安全

- 会话日志里可能有粘贴过的密钥，relay 仓库**必须私有**。
- 令牌不要写进仓库 URL 或聊天记录，用 credential helper 或 SSH。
- 给出 relay 访问权，等于给出读取全部对话的权限。

## 开发

```
dsh-hop/
├── index.js          Host：命令、工具、JSON 接口、git/会话收发
├── client.js         面板：sidebar.panellist + main
├── cordis.patch.yml  插件行
└── locale/           中英文名称与描述
```

改完 host 代码需要先移除再安装才会加载新的 JavaScript；只改 `client.js` 刷新页面即可。
