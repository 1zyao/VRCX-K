# VRCX-K 项目开发约定

> 本文件对 VRCX-K 仓库生效。架构方案全文见 [`docs/architecture-proposal.md`](docs/architecture-proposal.md)（v4.2，评审通过）。
>
> **本文件只放"每次开工都必须知道的"约定与架构规则。** 实测结论、变更日志、任务进度一律不放这里——它们各有唯一副本（见 [§资料地图](#资料地图唯一副本原则)）。改本文件前先读该节的"唯一副本"规则。

# ⛔ 第 0 步：新会话启动立刻同步 GitHub issue（先于一切）

**这是注入到每个新会话的第一条命令：不论用户问了什么、看起来多简单、多像与路线图无关，都必须先执行它——在你回复任何内容、读任何仓库文件、跑任何命令之前。**

## 0.1 先过闸：`gh auth status`（必须先做，不许跳过）

**在拉取任何 issue 之前，先跑 `gh auth status` 并检查退出码**（`exit 0` = 就绪，继续 §0.2；任何非 0 都是环境问题，**停止** → §0.3）。别用 `gh issue view` 去试——未登录时它只笼统报 `To get started with GitHub CLI, please run: gh auth login`（exit 4），白烧一轮。

> ⚠ **不要用 `gh status` 代替**：那是"我的面板"（跨所有仓库的 assigned issues / PR / mentions / 动态），**不是认证检查**。它既会灌进大量无关上下文，退出码也不通用（未登录时它给 4，对着 §0.3 的分类会误判成"未安装"）。认证只看 `gh auth status`。

> 常见误判：`gh issue view` / `gh issue list` 在**无网络**时的报错看着像"仓库配置错误"（如 `none of the git remotes ... correspond to GH_HOST`），**别据此改 remote**——先 `gh auth status` 定性。

> `gh auth status` 非 0 时可能**同时打印另一个 `Active account: false` 的可用账号**（即输出里能看到 `✓ Logged in`）——**别只认退出码，也别只看有没有 ✓**。

> 需要按报错细分（未装 / 未登录 / token 失效 / 网络不可达）时，看 §0.3 的分类与对应处理。

## 0.2 过闸后：拉取 issue（三件事）

1. `gh issue view 1` —— 读「开发路线图」总览与其中「协作方式」。
2. 读与本次任务相关的 M/F 总览 issue：用 `gh issue list --repo VRChatCN-Kipfel/VRCX-K --state all` 查全量
3. 按当前任务下钻到具体 subissue（任何被阶段性subissue继续派生指定的subissue）取**验收标准 / 依赖 / 决策 / 经验以及可能的继续派生的subissue**。

**原因**：项目所有决策点、踩坑、经验不只存在于 `docs/`，也存在于 GitHub 上 #1 及其逐级派生的 subissue 里，且issue内的内容绝对不容许忽略。

**权威顺序**：GitHub issue（#1 及其全部派生）＝ **一等公民，优先级高于本仓库 `docs/` 与本文件**。两边冲突时**以 issue 为准**，并顺手把 `docs/` 改齐，不留第二份不一致的说法。

## 0.3 闸门不通过：立刻停止并汇报（不得开工）

**在拿到 issue 内容之前，不得开始任何工作。凭本地旧状态贸然开工会导致共识不同步，这比停下来更糟。**

汇报必须包含三样：

1. **卡在哪一步**——粘贴 `gh auth status` 的原始输出，不要只说"gh 用不了"。
2. **判定属于哪一类**——未装 / 未登录 / 令牌失效 / 网络不可达（判据：未装＝`CommandNotFoundException`；未登录＝`You are not logged into any GitHub hosts`；令牌失效＝`Failed to log in … using token` / `The token in GH_TOKEN is invalid.`；网络不可达＝连接超时/DNS 失败/`none of the git remotes … GH_HOST`）。
3. **给用户可执行的手动指引**，按类别给出：
   - 未装：给出安装方式（winget/scoop/apt 或 https://cli.github.com），如果条件允许，可以代替用户安装好ghcli，并说明装完要重开会话/重载环境变量。
   - 未登录 / 令牌失效：`gh auth login`，或 `gh auth refresh -s repo`，并提醒需要 `repo` scope。
   - 网络不可达：请用户检查代理/VPN；或请用户**粘贴 #1 及相关 issue 正文**作为替代输入。

> **替代输入可用时也要说清楚**：改用用户粘贴的内容后，要在工作记录里注明"本轮同步来源＝用户手工粘贴，非 gh 实拉"，便于事后核对是否漏读了派生 issue。

---
## 项目结构（三层：大脑-双手-脸）

```
VRCX-K/
├── src-tauri/     ← 双手 · Tauri 2 / Rust 壳（系统代理：托盘/通知/快捷键/对话框）
│   ├── Cargo.toml        Rust 依赖（cargo workspace 成员）
│   └── tauri.conf.json   窗口/打包配置
├── src/           ← 脸 · React UI (Vite 19)
├── host/          ← 大脑 · Cordis (bun) 宿主（业务/插件/服务）
├── Cargo.toml     ← cargo workspace 根（成员 src-tauri）
├── package.json   ← bun workspace 根（含 host）
└── docs/          ← 设计/实测/进度文档（清单见 §资料地图）
```

**通信（kkrpc 三通道，均为双向）**：
- `src` ⇄ `host`：`kkrpc/ws`（业务 RPC + 事件推送）
- `host` ⇄ `src-tauri`：`kkrpc/stdio` 双向桥（系统能力 ⇄ 业务/系统事件）
- `src` ⇄ `src-tauri`：Tauri IPC

## 工具链（全部在根目录执行）

### Rust / Tauri 侧（cargo workspace）

| 命令 | 作用 |
|---|---|
| `cargo check` | 只查编译错误（快） |
| `cargo build` | 编译 debug |
| `cargo test` | Rust 测试 |
| `cargo clippy` | lint |
| `cargo fmt` | 格式化 |
| `cargo tauri dev` | **完整开发**：自动起前端 vite + 编译 Rust 壳 + 弹窗口 |
| `cargo tauri build` | **完整打包**：前端 build → Rust release → 安装包（exe/msi） |

> `cargo tauri dev/build` 会自动调 `bun run build`（前端），是"壳+前端"的一条指令入口。宿主（Cordis）由壳作为 sidecar 拉起，见 `src-tauri/src/host.rs`。

### JS / Bun 侧

| 命令 | 作用 |
|---|---|
| `bun install` | 装全部依赖（前端 + host） |
| `bun run dev` | 只起前端 vite dev server |
| `bun run build` | 只编前端 → dist/ |
| `bun run dev:host` | 起 Cordis 宿主（host/） |
| `bun run build:host` | 编译 host |
| `bun run typecheck` | 前端 + app + host 三套类型检查 |
| `bun run check:contracts` | schema ↔ 生成镜像逐字节比对（漂移闸门） |
| `bun run check:js` | JS/TS 格式化 + lint + import 排序（`biome ci`，**只读**） |
| `bun run format` | 按 biome 配置**写入**格式化（改文件） |
| `bun run lint` | 按 biome 推荐集**写入** lint 修复（改文件） |
| `bun run test` | 前端与 host 测试 |
| **`bun run verify`** | **= typecheck + check:contracts + check:js + test + build，提交前必跑** |

> `biome` 已 pin 在 devDependencies（`2.5.14`，与 `biome.json` 的 `$schema` 对齐）。
> 不要改用 `bunx @biomejs/biome@latest`：上游发新版会在没人改代码的情况下让门控变红。

### 环境要求

- Rust: stable-x86_64-pc-windows-msvc（rustc 1.97+）
- WebView2（Windows 自带，Tauri 依赖）
- bun 1.4+
- cargo tauri-cli（已装：cargo tauri 2.11.4 / @tauri-apps/cli ^2）
- **GitHub CLI（`gh`）——开发环境必须安装并 `gh auth login`**：**开工前同步决策内容（见文件头）**、上游状态取证（`gh api` 实测标签 `[gh-*]`，见 `docs/architecture-proposal.md` §4.5 / §A.2）、issue/PR 检索与创建都依赖它。
  - 常用拉取：`gh issue view 1`（路线总览）、`gh issue list --repo VRChatCN-Kipfel/VRCX-K --state all`（全量清单；**必须带 `--repo`**，否则报 "No default remote repository has been set"，用 `gh repo set-default` 可一次性修掉）、`gh api graphql` 查原生 subissue 层级。
  - ⚠ **issue 编号会被 PR 占用**：**不能**由 `max(issues)` 推断下一个编号（本轮预算 #14，实际 M2 拿到 **#16**，因 #14/#15 是同日新 PR）。建 issue 前先查 `state=all` 的完整列表。

### 交付前自检

> **提交前必须跑完全部五道门控。** CI 侧的 `static-gates` job 就是这五道
> （见 `.github/workflows/build.yml`），本地命令与 CI 判据**逐条对应**：
> 本地跑过就等于预演过 CI，不要只跑一部分就提交。

| # | 门控 | 本地命令 | 覆盖 |
|---|---|---|---|
| 1 | Rust 格式 | `cargo fmt --all --check` | `src-tauri/` |
| 2 | Rust lint | `cargo clippy --locked --manifest-path src-tauri/Cargo.toml -- -D warnings` | `src-tauri/`（警告即失败） |
| 3 | TS 类型 | `bun run typecheck` | 前端 + host + 五套 tsconfig |
| 4 | JS/TS 格式 + lint | `bun run check:js` | 见 `biome.json` 的 `files.includes`（biome，含 import 排序）。当前覆盖 **84 个文件**：`src/**`（ts/tsx/css）、`host/src`、`host/tests`、`host/plugins`、`scripts`、`packages`、`examples`、根 `vite.config.ts` / `index.ts` / `index.html`；**不含** `docs/probes/**`（一次性实验代码，见其 README）与 `*.generated.ts`（契约镜像，归 `check:contracts`）。warning 也阻塞（`--error-on-warnings`） |
| 5 | 契约漂移 | `bun run check:contracts` | schema ↔ 生成镜像逐字节 |
| 6 | android 冒烟判据 | `bash scripts/android-smoke.test.sh` | `scripts/android-smoke.sh` 的崩溃判据（6 场景，自带假 adb，**无需设备/SDK**；约几百毫秒） |

⚠ **本地自检只要求 1–5 道**（与 `verify` 的原始定义对齐）。第 6 道在 CI 里已接进
`static-gates` job；改动 `scripts/android-smoke.sh` 的判据时**必须**本地跑它 ——
它钉住了两个静默失效方向（误报别的进程崩溃、漏报原生崩溃）。

⚠ **`bun run verify` 只等于第 3–5 道加测试与构建**，它的定义是
`typecheck + check:contracts + check:js + test + build` —— **不含**
`cargo fmt` / `cargo clippy` / `cargo test` 三道 Rust 门控。**"verify 全绿"不等于
自检通过**，那三道必须单独跑（或用下面的一行脚本）。

一行跑完全部五道（PowerShell / bash 通用）：

```bash
cargo fmt --all --check \
  && cargo clippy --locked --manifest-path src-tauri/Cargo.toml -- -D warnings \
  && cargo test --locked --manifest-path src-tauri/Cargo.toml \
  && bun run verify
```

- 新增行为**必须有测试钉住**（回归测试优先于断言强度：宁可多写一条会失败的用例，也别把断言放宽）。
- 纯格式化/漂移修复**单独提交**，不与功能 diff 混在一起。
- **尽力而为，不要卡死**：若某道门控因**环境原因**（缺系统库、平台不支持、
  工具未装）在本地跑不起来，**照实说明跑不了哪一道、为什么**，不要把"没跑"
  说成"通过"，也不要为了让它通过而放宽断言或屏蔽规则。能让 CI 兜住的
  就交给 CI，但**必须在提交信息里写明**哪一道未在本地验证。

## Git 约定

### 提交信息（默认结构）

如用户无特殊说明，头部写成 `Type(Scope): 中文描述`；正文写中文三段（改了什么 / 为什么 / 怎么验证的）。

- **Type**：`feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `ci`（对照 `git log` 实际取值，不新造）。
- **Scope**：`host` / `ui` / `shell`（= `src-tauri`）/ `build` / `docs` / `probes` / `m2` / `agents`（后续里程碑同理）；**可选**，跨面时用 `feat(host,ui): …` 或省掉括号。
- 冒号后用一个空格；描述写"改了什么/为什么"，不写"修改了文件"。
- **保留既有标记**：`[ci skip]`、`(#NN)` 放头部描述末尾，不占正文；不写 `Co-Authored-By` 之类署名 trailer，除非当轮明确要求。
- ⚠ 本文件生效前的英文提交头部**不回改**；**仅当用户明确要求时**才改用英文（或其他）描述——用户的当场措辞**优先于本条默认**。

示例：`feat(host): 接入上游 plugin-timer，去掉手写定时器`
- `.gitignore` 只放通用忽略（node_modules/dist//target/ 等）。

### ⚠ 旧 clone 必须先刷一次行尾（否则门控 4 会一直红）

本仓库在 `.gitattributes` 落地**之前** clone 出来的工作区，文件是 **CRLF**
（受 `core.autocrlf=true` 影响），而 `biome.json` 的 `formatter.lineEnding: "lf"`
会让 `bun run check:js` 在这些机器上**持续报错**，且报错信息**不会**说明这是检出问题。

**在仓库根执行一次**（已实测：工作区 CRLF 2 → 0，且未提交改动被保留）：

```bash
git stash            # 收起未提交改动（关键，见下）
git rm --cached -r . > /dev/null
git reset --hard
git stash pop
```

⚠ **不要用 `git add --renormalize .` 代替** —— 实测它是**空操作**：工作区 CRLF 数
**2 → 2 不变**。它只重写索引，不重新检出工作区。先前有说法称"`--renormalize`
实测 0 个文件被改动，所以安全" —— 那 **0 改动恰恰是"它什么也没做"的证据**，不是
安全性证据。（`git reset --hard` 单独用确实能修好行尾，但会**丢弃未提交改动**，
故上面的 `stash` / `stash pop` 不能省。）

**更省心的替代**：直接重新 clone。

## 临时工作区（agent 专用）

- `.temp/`（已 gitignore，**不提交**）是 agent 的临时工作区：探针脚本、临时构建产物、中间实验都放这里，做完即弃，可随时整目录删除。仓库内任何**不打算进 git** 的实验性文件优先放 `.temp/`，别散落在根目录。
- 区分：`.temp/` 是仓库内临时区（随仓库存在但 gitignore）；`.agent-teams/` 等是每机工具状态（`.git/info/exclude`，各机器私有）。
- **要保留**的产物（报告/正式代码/文档）放正常位置（docs/、host/、src/…），不要留在 `.temp/` 里"假装提交"——临时区的东西一旦需要转正，就移出 `.temp/` 再提交。
- **转正触发点**：一旦某产物**被别人引用**——被 GitHub issue 引用、被 `docs/` 引用、或成为后续实现的依据——就**必须立刻移出 `.temp/`**。判断标准是"**是否有第二份副本**"：**`.temp/` 里的东西随时可能整目录删除，不能成为唯一副本**。探针若承担回归基线角色，应转正到 `docs/probes/` 或搬成 `host/tests/` 单测。

## 许可证红线（抄代码禁令）

- **严禁抄 `vrcx-0`（Map1en 系）的任何代码/结构/文件**——它是 **GPL** 协议，复制/改写/照搬其文件会污染本仓库。仅可观察其"产品方向可行性"（界面长什么样、功能有哪些），且须在文档记录为独立设计。我们与它同为"VRCX 能力 + Tauri 重写"是需求同源，架构是独立决策（见 docs/ROADMAP.md §参照）。
- 可安全借鉴（MIT/Apache）：**VRCX 官方**（MIT，功能复刻主参照，能力清单/数据模型思路）、**`cordis` / `@cordisjs/*`**（MIT，可直接依赖）、**kkrpc**（⚠ 见下条，上游许可证声明不一致）。
- ⛔ **`@koishijs/*` 的 console / WebUI 家族是 AGPL-3.0**（`plugin-console` / `-market` / `-config` / `-commands` / `-admin` / `client` …），**与 MIT 的兄弟包同在一个 npm scope 下，没有任何命名约定可区分** —— 而它们恰是 M2-4/M2-5 最想参照的那批。**取用前必须逐包查 `license`，不得按 scope 推断**（判据：`npm view <pkg> license`，见 `AGPL-3.0` 即禁区，不做例外）。
- ⚠ **`koishi` 核心不可复用**（虽然也是 MIT）：与 satori 深度耦合（`Context extends satori.Context`），且锁 **cordis 3**（我们 rc.9），实测混用抛 `Export named 'Schema' not found in cordis`。**通用层已被上游抽到 `cordiverse`** ⇒ 需要什么去那里找。
- 任何**GPL/AGPL 项目**的代码/文件一律不得进入本仓库（含引用/复制/改写其结构文件）；只允许行为/能力层面观察参照。
- ⚠ **AGPL 的精确边界 = 仅 `@koishijs/*`**，**不是**"console / WebUI 家族"这种按功能描述的说法。两个 scope 名字相近，**必须逐包实测**：
  - `@koishijs/client`、`@koishijs/plugin-market` → **AGPL-3.0**（禁区）
  - `@cordisjs/client`、`@cordisjs/components`、`@cordisjs/plugin-webui` → **MIT**（**可用**）
  早先的表述把这批统称为"console/WebUI 家族是 AGPL"，**连带把 `@cordisjs/*` 那半边也说成了禁区** —— 那是错的（2026-09 逐包实测修正）。**判据不变**：`npm view <pkg> license`，见 `AGPL-3.0` 即禁区，**不做例外，也不按 scope 推断**。
- ⚠ **kkrpc 的许可证靠推断，不是实测**：`npm view kkrpc@2.1.0 license` **返回空**（摘要页显示 `Proprietary`），发布 tarball 内无 LICENSE 文件；GitHub 仓库 LICENSE 为 **Apache-2.0**，README 却写 **MIT** —— **三处声明互相矛盾**。**不构成 AGPL 红线**，但如果要做严格合规审查或再分发，**这是"上游未把话说清"，不能当成已确认的 Apache-2.0**。
- **进程注入/读游戏内存/Unity 内 UI** 类能力是禁区（官方不背书，ToS 风险），agent 不得实现或建议实现。
- 本仓库自身许可证**待定**（倾向 MIT），决定后补 LICENSE；决定前按宽松许可方向管理借鉴边界。
- 详表见 `docs/ROADMAP.md` §参照与许可证卫生。

## 架构规则（违反 = 隐性坏掉，不报错）

> 下面三条**不是风格偏好**，是"写错了不会立刻炸、但语义已经错"的硬约束。全部有实测依据（见 [§资料地图](#资料地图唯一副本原则) → Cordis 运行时）。

- **能力服务必须 `extends Service`**：`ctx.provide(name, 普通对象)` 提供的方法**完全没有调用者归因**（两个插件调用的结果无法区分），护栏/审计/`access` 声明全都失去落点。**方法一律写成类方法**——写成箭头函数属性会**静默**丢失归因（`caller: null`），命名空间的每个子对象也必须是 `Service` 实例，普通对象字面量同样丢。
- **服务必须"先 provide、后 attach"**：`inject` 是**就绪门不是访问门**——未 inject 的插件照样能读服务，但注入尚未提供的服务的插件会卡在 `PENDING`，provide 后才 `ACTIVE`。（`host/src/index.ts` 的 tray/shortcut 即此模式。）
- **持久性来自 `COMMIT`，不是来自 `ctx.effect()` 的 disposer**：已提交的行即使被**硬杀**也存活；只写在 disposer 里的数据被硬杀时**全丢**。⇒ 数据落盘走**写入路径**；`ctx.effect()` 里只放**非持久性清理**（句柄、临时文件、WS 关闭）。
  配套两条硬事实：① 写在**根 `ctx`** 上的 effect 不进 `registry`、**不报错、disposer 永不执行**（只有插件 fiber 内的会被回收）；② **Windows 上 `SIGTERM`/`SIGINT` 根本不投递**（`kill()` 是硬 TerminateProcess，处理器不触发），那两个处理器在 Windows 是**死代码**。详见 [`docs/shutdown-strategy-review.md`](docs/shutdown-strategy-review.md)。
- **`ctx.*` 是 inject 门控的，缺 `inject` 是硬失败**：插件里碰 `ctx.interval` / `ctx.notify` 等而**没在 `inject` 数组里声明** ⇒ fiber **FAILED，插件永不加载**（零警告）。⚠ 写测试时**别把调用包在 try/catch 里**——那样 fiber 会保持 ACTIVE，读数会说"能用"而实际不能（实测踩过）。`host/tests/upstream-plugins.test.ts` 钉了两侧。

## ⚠ 动机制之前先查上游（四次里错四次换来的规矩）

> **cordis 的插件生态里已经有大量现成件。** 我们已四次准备自己造，结果每次都发现上游有：
>
> | 我们准备造的 | 上游已有 |
> |---|---|
> | #19「effect 纪律 + lint 拦裸定时器」 | **`@cordisjs/plugin-timer`**（`ctx.timeout/interval/...` 全部经 `ctx.effect`） |
> | base 分组命名空间（`base@storage`） | **`@cordisjs/plugin-group`**（cordis 原生 group，子项独立启停/配置） |
> | 手写 `log()` | **`@cordisjs/plugin-logger-console`** |
> | `base-state.json` 的 `entries`（启停/配置） | **`EntryOptions.disabled` / `.config`** |
>
> ⇒ **动手前先查**：`cordis` / `cordiverse` 组织的仓库（约 26 个），以及 `npm view <pkg>` 确认**是否已发布**（源码在 main ≠ 能用）。
>
> **判据**：**如果某能力听起来"框架应该自带"，先去上游找，再决定造不造。**
> **反例警告**：`base-state.json` 的 `entries` 已经写进文档与两条 issue 评论，才发现是第二份真源；`Dotnet/` 曾被预判"用不上"而跳过整块勘察，结果里面**有本 org 66 次提交的原创**。**两次都是"没查就下结论"。**

## 资料地图（唯一副本原则）

> **规则：同一批事实只允许有一个"主副本"。** 发现两份说法不一致时，以主副本为准并删掉另一边——**不要把本文件当第二副本维护**。
>
> **与 GitHub 的关系**：本表管的是 `docs/` 内部的唯一性；**跨源冲突时以 GitHub issue 为准**（理由与同步步骤见文件头）。issue 上做出新决定后，本表指向的 `docs/` 主副本**必须跟着更新**，不能只改 issue。

| 要查什么 | 去哪里（主副本） |
|---|---|
| 架构方案全文（v4.2） | [`docs/architecture-proposal.md`](docs/architecture-proposal.md) |
| **写插件 / 写服务 / 碰 Cordis 前必读** | [`docs/cordis-runtime-findings.md`](docs/cordis-runtime-findings.md) **§0 结论速查**（14 条实测，逐条给探针） |
| 优雅停机与落盘（退出路径、`ctx.effect` 归属、`bun:sqlite`） | [`docs/shutdown-and-persistence-findings.md`](docs/shutdown-and-persistence-findings.md)（probe21–23） |
| **持久化策略与信号处理（含独立审查结论）** | [`docs/shutdown-strategy-review.md`](docs/shutdown-strategy-review.md)（持久性来自 `COMMIT`、Windows 信号不投递、exit code 契约） |
| **写数据引擎 / 事务前必读（故障病历 + 跨引擎契约）** | [`docs/data-engine-fault-history.md`](docs/data-engine-fault-history.md)（旧工程五个真实故障 + 6 组跨引擎不变量 + DDL 回滚例外） |
| 插件源 / 索引 / manifest / tag 版本方案 | [`docs/plugin-source-and-index-design.md`](docs/plugin-source-and-index-design.md)（probe14–20 已入档）；目录布局见 [`docs/adr-plugin-layout.md`](docs/adr-plugin-layout.md) |
| kkrpc Rust↔npm 协议互通（M1-4 依据） | [`docs/kkrpc-interop-findings.md`](docs/kkrpc-interop-findings.md) |
| **旧工程勘察（血统 / 可复制性 / 经验点）** | [`docs/legacy-recon/`](docs/legacy-recon/) —— **先读其 [README](docs/legacy-recon/README.md) 的两条红线**：`old/main` 是 MIT fork 链（大部分非本 org 所写），且与 `rewrite` **无共同祖先**（取用必然是显式复制） |
| **任务进度 / 里程碑状态 / 决策记录** | GitHub **#1 及其派生 issue**（见文件头；**最高权威**）；`docs/ROADMAP.md` 只是同步过来的概览镜像，冲突以 issue 为准 |
| 可复跑探针（实测证据） | [`docs/probes/`](docs/probes/)（`bun run docs/probes/probeN.ts`）；写/跑探针自身的坑见其 [README](docs/probes/README.md) |
| **传输层实测（二进制/流/背压/队头阻塞/文件夹上传）** | [`docs/probes/transport-lab/FINDINGS.md`](docs/probes/transport-lab/FINDINGS.md) —— **先读 §0 结论表**；§8 写明 loopback 测量**不**能推出的东西、**§8.1 是已完成的跨机（WSL→Windows）实测**。它是一套 **client/server 仪器**（常驻 `server.mjs` + 每格一个探针进程），不是单文件探针。⚠ **§8 原称「`client.mjs` 支持 `--host`，跨机不需新代码」是错的**——server 三个绑定点硬编码 `127.0.0.1`，已加 `--bind`；跨机跑用 `--bind=0.0.0.0` |
| **手（`src-tauri`）与文件传输实测（stdio 编码成本 / kkrpc 流双方向 / Android `content://`）** | [`docs/probes/hand-io/FINDINGS.md`](docs/probes/hand-io/FINDINGS.md) —— **先读 §0 结论表**；§7 写明未测项、**§7.1 记录跨机（WSL）**。含一个 **Rust crate**（`rust/`，空 `[workspace]`，**不是** workspace 成员）。⚠ 它与 transport-lab **不矛盾、互补**：transport-lab 的 `raw` 走**它自造的 `makeFrame` 分帧 + 裸 ws**（不经 kkrpc），hand-io 走 **kkrpc 出厂 stdio 传输**；两边都同意「kkrpc 出厂传输装不下裸二进制」。§5.1 实测二进制分帧**可行且快约 1.8–2.1x**（配对实测，比值稳定、绝对值随尺寸与机器波动）但**需两端同改** ⇒ base64 是默认而非唯一。⚠ 跨机跑必须用**真 Linux** node，Windows `node.exe` 经 WSL interop 跑出来是 win32 进程、走的是 Windows loopback（假跨机） |
| **手能力面提案（给 SDK 定版：5 原语 + ctx 形状 + 审计插针 + 路径语义 + hello）** | [`docs/hands-capability-proposal.md`](docs/hands-capability-proposal.md) —— **已落地**（Rust 侧 5 原语 + `hands.hello`，以及宿主侧 `ctx.hands` 服务面，均在 PR #40）。⚠ **§1.1 记录了一次本提案自己的推理错误并被更正**：「目录遍历归脑」只在**调用方够得着磁盘**时成立，而本能力存在的理由正是**异机** ⇒ 枚举是能力（归手），递归/匹配/排序才是策略（归脑）；缺口是**实测**出来的（`stat(dir)` 无条目、`read(dir)` 报 `EISDIR`），不是推出来的。§6.2 记录了一次**自己被探针推翻**的断言（曾称 generator 体内记审计会丢归因，实测三种形状**都保留**）+ §6.2a 一条实测约束（`this` 是 per-caller shadow，**`#private` 会抛**）。**§7.1 是路径语义主副本**（`~`/`%VAR%` **不展开**、相对路径**以手的 cwd 为基准**、`..` **按字面折叠**、**无路径围栏**）。**§7.2 是手→脑 hello**（节点标识 + cwd/home + 环境；选**握手一次绑定节点**而非每字段打 source 标记，理由=后者是逐字段纪律、漏一个就静默错位）。§9.1：**流式帧在本仓当前配置下没有二进制载体**（base64 是**当前最便宜的选择**，⚠ **不是协议契约** —— kkrpc 允许替换 platform+codec，单管道上 raw 已验证可行且快 1.8–2.1x，只是要两端都改）+ **消费流的 RPC 必须用 deferred reply** |
| **手文件能力的端到端验证（真 kkrpc + 真管道 + 真生产源码）** | [`docs/probes/hands-e2e/`](docs/probes/hands-e2e/run.mjs) —— 驱动器是 **`src-tauri/examples/hands-e2e.rs`**（Cargo example），`use tauri_app_lib::{hands, hands_hello, kkrpc_peer}` —— **生产模块，走真实 crate 边界**（为此 `lib.rs` 里那三个改成了 `pub mod`；此前住在 `docs/probes/hands-e2e/rust/` 用 `#[path]` 拉同一批文件，编的是真源码但**组了棵私有模块图**）。由真 `StreamingRPCChannel` 驱动，9/9 通过、4 MiB 双向字节一致（~112 MiB/s）。跑法：`cargo build --release --locked --manifest-path src-tauri/Cargo.toml --example hands-e2e && node docs/probes/hands-e2e/run.mjs`；⚠ 二进制落在 **workspace 的 `target/release/examples/`**。⚠ **`cargo test` 会编译 examples，`check`/`clippy`/`build --release` 不会**。⚠ 不跑整个 Tauri app：它要 webview，无法在 CI 无头运行，而文件能力**完全不依赖 Tauri**。同目录 `hol.mjs` 测队头阻塞、**`hol-credit.mjs` 分离成因**：真因是 **`pump_producer` 在 reader 线程上跑完整批 credit 才回到 `read_line`**（不是「排队」也不是「对端忙」）。判别法 = 同一 credit 下批**中间** vs 批**末尾**探针：修前 MID p95 随 credit **线性**（~1.7ms/未完成块）、END 恒定≈空闲；修后**不再随 credit 缩放**（H3 PARTIAL）。**该缺陷已修**（`pump_producer` → `Peer::spawn_producer`，生产者自己的线程 + `Condvar` 唤醒）：**p95 70.25x → ~9x、吞吐 156→183 MiB/s，但 p50 由 1.03x 退到 ~8x** —— 后者是「独立写者共用一条通道的写锁争用」（256KiB 一块写一次 ~1.4ms ⇒ 等半块 ≈0.9ms），**改轮询间隔或加 `sched_yield` 都撼不动**，去掉它要第二条载体（协议决定）。⚠ **载体（raw）不是这个问题的解** —— 它只缩短每次迭代，不消除等待整批；⚠ **减小 credit 治标且买掉吞吐**（credit=1 时 87 vs 171 MiB/s），且**每 pull 只发一块会死锁**（kkrpc 的消费者 `!(consumedSincePull < 16)` 才补货） |
| **`ctx.hands` 宿主侧方案（含审计与流生命周期）** | [`docs/hands-host-design.md`](docs/hands-host-design.md) —— **已落地**（PR #40）。⚠ 本文是「**为什么这样设计**」的主副本，不是实现清单（实现以 `host/src/{hands,stdio,overreach}.ts` 为准）：§6 的落地步骤 1–5 全部已实现。三条实测前提：①宿主现用 `RPCChannel`，**收不到流**（`"sq"`/`"sr"` 在编译产物里出现 0 次）⇒ 须换 `StreamingRPCChannel`（对普通 RPC 是 drop-in）；②**收上来的块是 base64 字符串不是字节**，故 `AsyncIterable<Uint8Array>` 要求宿主侧解码、**不是透传**；③**流不绑生命周期会泄漏**（实测插件卸载后仍产出 16 块）。机制 = 方法内 `this.ctx.effect(...)`（**绑调用者 fiber**，实测），但**每条流结束必须释放注册**（实测 1000 次注册全留存到卸载）且**根 ctx 上的 effect 只在优雅停机时执行**（不是「永不执行」，曾误记）。⚠ 审计记「一次申请」不记每块；`#24` 落点 `this[symbols.caller]` |
| **Tauri v2 插件目录调研（98 项，防重复勘察）** | [`docs/tauri-plugins/tauri-v2-plugin-catalog.md`](docs/tauri-plugins/tauri-v2-plugin-catalog.md) —— 30 个官方插件 + 2 个 core 行 + 50 个社区插件 + 16 个集成，**逐项列平台支持**。⚠ **平台矩阵不能靠读页面**：官网用 SVG 图标 + `title` tooltip 渲染，dokobot 与 web_fetch 都只能拿到空表格；真值取自生成器读的 `Cargo.toml` 的 `[package.metadata.platforms.support]`（官网自己也是这么生成的）。开头的「Corrections applied after review」记录了一条**被本仓库证伪**的结论：报告的「`opener:default` 缺 `allow-open-path` 是 live bug」在本项目**不成立** —— 我们走的是 Rust 侧 `OpenerExt`（**不做 scope 检查**），而 `#[tauri::command]` 那层才检查；前端从不 import `@tauri-apps/plugin-opener` |
| **三个决策的上游先例（URL scheme / bulk vs 交互 / 资源生命周期）** | [`docs/hands-prior-art.md`](docs/hands-prior-art.md) —— 每条都带出处，未证实的一律标 unconfirmed。**已独立复核的三条硬结论**：①**VRCX 只注册 `vrcx`，明确不认领 `vrchat://`**（`Installer/installer.nsi` 全 `HKCU`；它把 `vrchat://launch?ref=vrcx.app&…` 转发给 VRChat 自己的 `VRChatURLLaunchPipe`）⇒ 认领 `vrchat://` **无先例**，且 `vrcx://` 已被 VRCX 占用（两 app 会在同一注册表键上打架）。⚠ **无 scheme 就只在 Windows/Linux 有意义**（macOS 必须写进 config）。②**没有项目在单条无分帧通道里解决 bulk vs 交互**；kkrpc **已有 credit 流控但零优先级**（`priority|writeQueue` 在 dist 里零命中），正是「p50 平 / p95 爆」的形状；muxado README **明确警告**光多路复用不解决。③绑 owner 生命周期是主流但**从不足够** —— 每个成熟系统都另加**宿主强制清理**路径。⚠ 报告基于 **shallow clone** 的 `refs/remotes/VRCX/master`（`rev-list --count` 返回 2 是 graft 截断）；`refs/heads/VRCX/master` 是**另一个 commit、无共同祖先**，引用必须用全限定名 |

**实测结论的写法**：不要只把结论写进文档——把**探针留在 `docs/probes/`**，并在生产代码注释里引用它（本仓库既有惯例：`host/src/capability.ts` 引 probe8、`host/src/stdio.ts` 引 probe9、`host/tests/plugin-manifest-contract.test.ts` 引 probe20/11）。这样改到那段代码的 agent 会顺着注释找到证据，比"某文档第 N 条"可靠。
