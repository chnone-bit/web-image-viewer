# 仓库初始化说明

本目录已初始化 git 仓库（分支 `main`），`.gitignore` 已就位。
**还差一步**：配置提交者身份，然后做首次提交。

---

## 一、先配身份（二选一）

### 方案 A：全局配置（推荐，一次配好所有仓库）

```bash
git config --global user.name "markli"
git config --global user.email "your@email.com"    # ← 换成你的邮箱
git config --global init.defaultBranch main        # 新仓库默认用 main
git config --global core.autocrlf true             # Windows 换行符安全
```

> 邮箱不必真实可用；只是写进每条提交的 `Author` 字段。
> 若之后要推到 GitHub/Gitee，**建议用该平台账号绑定的邮箱**，
> 这样提交能正确归属到你名下。

### 方案 B：仅本仓库

```bash
cd "C:/Users/lidt/WorkBuddy/2026-10-05-16-56-29"
git config user.name "markli"
git config user.email "your@email.com"             # ← 换成你的邮箱
```

---

## 二、首次提交

```bash
cd "C:/Users/lidt/WorkBuddy/2026-10-05-16-56-29"

git add .
git commit -m "chore: 初始化版本库（v1.5.1）

- forum-image-viewer.user.js: 论坛图片浏览器油猴脚本
- CHANGELOG.md: 版本改动记录
- .workbuddy/test/: jsdom 测试套件（10 套 / 218 断言）
- test-demo.html: 演示页
- .gitignore: 排除 .workbuddy/memory/ 等个人/临时内容"
```

验证：

```bash
git log --oneline          # 应看到 1 条提交
git status                 # 应为 clean
```

---

## 三、日常用法

```bash
git status                          # 看改了什么
git diff                            # 看具体改动
git add forum-image-viewer.user.js  # 只暂存某个文件
git commit -m "fix: xxx"            # 提交
git log --oneline -10               # 近期历史
```

### 强烈建议：改前先存一个还原点

这个脚本每次迭代改动很大，出问题的概率不低。**动手大改之前先提交一次**：

```bash
git add -A && git commit -m "wip: 改动前快照"
```

一旦改崩了，一条命令回滚：

```bash
git restore forum-image-viewer.user.js      # 丢弃未提交的改动
# 或
git reset --hard HEAD                       # 回到上次提交（危险，会丢未提交内容）
```

**这次 v1.5.1 误删 7 个函数的坑，如果有 git 就不会发生** ——
`git diff` 一眼就能看出多删了什么。

---

## 四、关于 .gitignore

| 路径 | 是否入库 | 原因 |
|---|---|---|
| `forum-image-viewer.user.js` | ✅ | 主交付物 |
| `CHANGELOG.md` | ✅ | 版本记录 |
| `.workbuddy/test/` | ✅ | 测试是代码资产 |
| `test-demo.html` | ✅ | 演示页 |
| `.gitignore` | ✅ | 规则本身也要版本化 |
| `.workbuddy/memory/` | ❌ | 个人工作记忆（含项目上下文，不宜入库） |
| `tmp-*.js` | ❌ | 开发期临时脚本 |
| `node_modules/` | ❌ | 依赖（本项目实际用不到） |

---

## 五、之后想加远程仓库

```bash
# GitHub / Gitee 上先建好空仓库，然后：
git remote add origin git@github.com:<你的用户名>/<仓库名>.git
git push -u origin main
```

> 若用 HTTPS 地址（`https://...`）推送时需要输入凭据；
> 用 SSH 地址则需要把公钥加到平台。你本机已有 `.ssh` 目录，
> 但现有 `n1_key` 是给家里 N1 盒子用的，**建议为 git 单独生成一把**：
> ```bash
> ssh-keygen -t ed25519 -C "your@email.com" -f ~/.ssh/id_ed25519
> ```
