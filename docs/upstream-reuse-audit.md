# 上游再实现审计（"我们在自己造轮子吗"）

> **触发**：owner 看到一处 `import "./log"` 后提出 ——「很多基础功能 Cordis 和 tauri 都是有提供的，
> 就比如日志，我需要你举一反三」。
>
> **方法**：对 `host/src`（23 个文件）与 `src-tauri/src`（19 个文件）逐块问一句
> 「这个能力上游有没有」，**并且真的去查**（`npm view` + 下载 tarball 读 API），
> 不靠印象判断。本文只记录**查证结果**，不记录猜测。
>
> **结论先行**：**发现 1 处真实的重复实现**（HMR/文件监视，1137 行），
> **其余 6 处经查证是有理由的**，理由逐条写在第 2 节。**没有发现第二处需要立即改的。**

---

## 1. ⚠ 真实重复：`@cordisjs/plugin-hmr` 与我们 1137 行的监视/重载体系

### 查证到的事实

```
$ npm view @cordisjs/plugin-hmr version license
version = '1.1.0'
license = 'MIT'                     ← 不是 AGPL，可用
dependencies: chokidar ^4.0.3, picomatch ^4.0.3, cosmokit, schemastery, @babel/code-frame
```

它的公开 API（`lib/index.d.ts`，1700 余字的声明）显示它做的是：

| 它提供 | 说明 |
|---|---|
| `ctx.hmr` 服务（`extends Service`） | 可直接 `inject` |
| `watch(path, callback)` | 监视单个文件，**即便在 `root` 之外或命中 `ignored` 也会监视** |
| `hmr/change` / `hmr/reload` 事件 | 含 `stalePlugins: Map<Plugin, StalePlugin>` 与 `runtime` |
| `analyzeChanges` / `partialReload` | **依赖图分析**：accepted（应重载）vs declined（不应重载），externals 一律走全量重载 |
| `getLinked(url)` | 解析依赖链 |
| `Hmr.Config` | 继承 `ChokidarOptions` + `base` / `root` / `debounce` / `ignored` |

### 我们写了什么

| 我们的文件 | 行数 | 覆盖的功能 |
|---|---|---|
| `host/src/watcher.ts` | 162 | chokidar 薄适配（`HostWatcher`），事件语义 `started/change/unowned/ambiguous/error/closed` |
| `host/src/watch-path.ts` | 123 | canonical path → Entry 映射（`EntryBinding`、`mapPath`） |
| `host/src/dev-watch.ts` | 492 | 装配层：把 HostWatcher 接到真实 Cordis include 树、per-entry reload 队列、debounced include refresh |
| `host/src/dev-reload.ts` | 360 | 一次 reload 事务（`reloadPluginEntry`） |
| **合计** | **1137** | |

⇒ **功能面明显重叠**：都在做「chokidar 监视 → 路径/依赖分类 → 决定重载谁」。

### ⚠ 但**不能**据此直接替换，先要判清三件事

写这份文档时**尚未**完成替换可行性判断，因此**不下"应当替换"的结论**。必须先回答：

1. **`plugin-hmr` 的重载语义与我们的 `Entry` 事务是否等价？**
   它按 **模块依赖图**（`getLinked` / externals）分类；我们按 **Cordis Entry 归属**
   （`watch-path.ts` 的 `EntryBinding` / `ambiguous` / `unowned`）。**这是两套不同的判据**，
   而我们的 `ambiguous` / `unowned` 是**给用户看的诊断事件**（`WATCHER.md` 明确定义了它们），
   `plugin-hmr` 没有对应物。⇒ 直接换会**丢失诊断能力**。
2. **它是否处理 `cordis.yml`（include 配置）本身的变更？**
   我们的 `dev-watch.ts` 明确负责 **Include EntryTree 的 debounced refresh**，
   且有一条硬边界：「Include refresh happens on the Include EntryTree,
   **never by rewriting `cordis.yml` from here**」。`plugin-hmr` 的 API 里**看不到** include 树概念。
3. **我们的 `WATCHER.md` 是一份已写死的契约**（36 行，定义了 `close()` 幂等、
   `getWatched()` 关闭后为 `{}`、无孤儿监听器/定时器、并发 `close()` 共享同一 Promise 等）。
   换成 `plugin-hmr` 会让这些**已用测试钉住的保证**失去依托。

**⇒ 处置建议（留给 owner 裁定）**：这不是"删掉 1137 行"那么简单，而是
「**用上游的依赖图分类替换我们的 Entry 归属分类**，还是**保留两层**（上游 HMR 负责模块热替换、
我们的 DevWatch 负责 Entry 诊断与 include refresh）」。**后者更可能是对的**，
但**必须先读 `plugin-hmr` 的 `lib/index.js`（18 KB）实现**才能定，本文不下结论。

---

## 2. 经查证**有理由**的 6 处（不是轮子）

| # | 我们写的 | 上游有吗 | 为什么仍然是对的 |
|---|---|---|---|
| 1 | `host/src/log.ts`（315 行）—— 落盘日志 + 轮转 + 脱敏 + **patch `console.log/info/debug`** | ✅ `@cordisjs/plugin-logger-console`（**已在依赖里，且 index.ts:245 真的在用**） | **两者不是同一件事**。`LoggerConsole` 是 cordis 的 **Exporter**：把 `ctx.logger` 的 `Message` 渲染到 console。而 `log.ts` 解决的是**两个 cordis 不处理的真问题**：① **stdout 是 kkrpc/stdio 协议通道**，所以必须把 `console.log` 改道到 **stderr**（否则协议帧被日志污染）——`index.ts:239-243` 写明了这一点；② **落盘 + 轮转 + secret 脱敏**（`logWithSecret` / `REDACTED` / `redactUserPath`）。上游没有 `@cordisjs/plugin-logger-file`（**实测 404**）。⇒ **不是重复，是互补**。⚠ 但**`console` patch 与 LoggerConsole 的先后关系是隐式契约**（靠 `import "./log"` 排在第一行），这对局外人很脆 —— 已在新的测试里钉住 |
| 2 | `host/src/fiber.ts`（34 行）—— `FIBER_ACTIVE = 2` / `FIBER_FAILED = 3` | ✅ cordis 有 `FiberState` | ⚠ **必须自己写**：cordis 导出的是 `declare const enum FiberState`，**没有运行时值，无法 import**。文件注释与测试都写明「cordis 升级若重编号会响」 |
| 3 | `src-tauri/src/kkrpc_peer.rs` —— 手写 kkrpc compact-protocol peer | ✅ kkrpc 有 Rust crate | ⚠ **已实测不互通**：文件头写明「the published `kkrpc` Rust crate … which does **not** interoperate with npm kkrpc 2.1.0's compact protocol」。这是**已验证的缺口**，不是偷懒 |
| 4 | `host/src/signal.ts` / `lifecycle.ts` / `restart.ts` / `stdin-watch.ts` | ⚠ 未见等价物（`@cordisjs/plugin-daemon` **实测 404**） | 它们做的是**反向序 dispose + 与 Rust 壳的退出码契约**（exit 51/52）、以及 **fd 0 失联自退**（#33，无壳启动时的孤儿问题）。这是 cordis 不拥有的进程生命周期层 |
| 5 | `host/src/stdio.ts`（884 行） | ✅ kkrpc 有 `nodeStdioTransport` | **我们就是在用它**（`stdio.ts:3` import `{{nodeStdioTransport}}`，`StreamingRPCChannel` 来自 `kkrpc/streaming`）。884 行是**桥接与业务面**（能力转发、审计、流解码），不是重写传输 |
| 6 | `host/src/ws.ts`（53 行） | ✅ kkrpc 有 `webSocketTransport` | 同上，**就是在用**（`ws.ts:4-5`） |

---

## 3. 本轮**明确查过、确认上游没有**的（防将来重复提议）

| 查了什么 | 结果 |
|---|---|
| `@cordisjs/plugin-logger-file` | **404**（不存在）⇒ 落盘日志必须自己写 |
| `@cordisjs/plugin-watch` | **404**（不存在） |
| `@cordisjs/plugin-daemon` | **404**（不存在） |
| `@cordisjs/plugin-hmr` | ✅ **1.1.0 存在**，见 §1 |

已确认**存在且已被我们使用**的：`plugin-timer` 1.1.3、`plugin-group` 1.0.0、
`plugin-include` 1.0.5、`plugin-loader` 1.0.0-rc.x、`plugin-logger-console` 1.0.0。
⚠ `plugin-server` 1.7.0 存在但**本项目未用**（WS 走 kkrpc 而非 cordis server）—— 记录在此以免将来重复发现。

---

## 4. 方法上的要求（写给下一次做这个审计的人）

**不要靠"这听起来像是框架该有的"来判断** —— 那次教训正是上游查证四次错四次。
本次的做法是：**`npm view` 查是否发布 + 下载 tarball 读 `.d.ts` 的真实 API**，
再逐条对我们的代码问「覆盖的是同一件事吗」。

⚠ **特别注意"看起来重叠、其实分层"的情况**：§1 与 §2.1 都是表面重叠但语义不同。
判据不是「行数多就是轮子」，而是「**上游那个东西解决的是不是同一个问题**」。
