# 手能力面提案（给 SDK 定版）

> **状态**：**提案 + 已落地的传输层实现**。形状本身仍是提案（`ctx.hands` 服务面尚未存在，
> 那是 SDK 的事）；但提案可以决定的那一半 —— **五个原语、流式背压、取消、错误码、
> 路径语义、手→脑 hello** —— 已在 `src-tauri/src/hands.rs` / `hands_hello.rs` 落地，
> 并由 [`probes/hands-e2e/`](probes/hands-e2e/run.mjs) 对**真 kkrpc 2.1.0** 端到端验证
> （实测 4 MiB 文件 **~112 MiB/s**，双向字节一致）。
> **目的**：在插件 SDK 定版**之前**，把「手（`src-tauri` / Rust 壳）可实现的能力」尽可能
> 收成 SDK 能直接消费的形状。SDK 一旦定版，形状再改就要付兼容成本；现在是唯一的
> 低成本窗口。
> **日期**：2026-09。
>
> **本文不是新建的事实来源**。每一条结论都有一个**实测主副本**，本文只做「实测 → 可消费
> 形状」的转换，并在每节标明来源。冲突时以主副本为准。
>
> ⚠ **本次落地**：`hands.stat` / `hands.read` / `hands.write` / `hands.watch` / **`hands.list`**
> 已在 Rust 侧实现并可跑；**它们不构成 SDK**，也**不主张排期**（§9 第 7 项仍未决）。SDK 侧要做
> 的是把它们包成 `ctx.hands`（含审计插针，§6）。
>
> ⚠ **本轮修正了一处本提案自己的推理错误**：初版写「目录遍历归脑」，依据是 transport-lab §6。
> 那个前提**只在调用方够得着那台磁盘时成立**。详见 §1 与 §1.1 —— 这是本文档第三次被自己的
> 实测推翻（前两次见 §6.2、§9.1），记录在此以免被当作新结论。

## 0. 一句话

手要向插件暴露 **5 个原语**（`stat` / `read` / `write` / `watch` / **`list`**），全部
**无状态、可取消、有背压**；**递归、通配符、排序、跨目录批量、重试一律归脑**。
**枚举本身是能力，不是策略** —— 见 §1.1。

---

## 1. 为什么是这几个原语（而不是更多）

推导链，每一步都有实测依据：

| 步骤 | 结论 | 来源 |
|---|---|---|
| 手必须有文件能力 | 异机时宿主**够不着**那台机器的磁盘 —— `host/src/watcher.ts` 是**宿主自己**的文件监视，路径解析在宿主侧 | [`probes/hand-io/FINDINGS.md`](probes/hand-io/FINDINGS.md) §7.1 |
| **枚举也必须是手的**（⚠ 初版此处写错，见 §1.1） | 「遍历归脑」只在**脑够得着磁盘**时成立；而本能力存在的理由正是**异机**。没有 `list`，脑**连一个文件名都发现不了** | 实测：`stat(dir)` 无条目、`read(dir)` 报 `EISDIR` |
| 但**不要**给手「打包/递归技能」 | 递归 / 通配符 / 批大小 / 重试是**业务策略**，不需要碰盘；实测每文件成本 = 一个完整 RTT（5 ms 下逐文件比打包慢 **320x**），修法是**脑侧批量请求**，不是手侧变聪明 | transport-lab §6 |
| 故手的原子能力是**单文件 + 单目录** | 读一个文件、写一个文件、看一个文件、列一个目录 —— 再加一个查大小/存在性（批量与续传都要它来决定 offset） | 由上行推出 |
| 续传**不需要新原语** | `seek(SeekFrom::Start(n))` 就是全部机制（实测逐字节回读一致）；把 offset 作为**参数**，而非新方法 | [`rust-crates/FINDINGS.md`](probes/hand-io/rust-crates/FINDINGS.md) §3 |
| 监视**必须是手的**（不能复用宿主 watcher） | 同第二条：宿主看不见异机磁盘 | 同 §7.1 |

**⇒ 5 个原语，不是 40 个。**

### 1.1 ⚠ 自查出的推理错误：我把两条正确的结论拼成了错误的推论

初版把「目录遍历」和「打包」一起归给脑，依据是 transport-lab §6 的原话：

> "Directory walking, batch sizing and retry are **business policy and belong in the brain**,
> which needs only two stateless primitives from the hands: **read one file, write one file**."

**那句话在它自己的语境里是对的** —— §6 测的是**「N 个文件名已知」**的传输成本，
比较逐文件 vs 打包。但它推出的「遍历归脑」有一个**未写出的前提**：**脑够得着那些文件**。

而同一份文档的 §7.1（以及本能力存在的**全部理由**）恰恰是**异机**：脑看不见那台磁盘。

| 前提 | 单独看 | 拼起来 |
|---|---|---|
| 遍历是策略，归脑 | ✅ 对（递归/通配符/排序确实是策略） | |
| 异机时脑够不着磁盘 | ✅ 对 | |
| ⇒ **脑能自己遍历异机目录** | | ❌ **不成立** |

**「谁来做」和「在哪台机器上做」是两个问题**，初版把它们合并了。正确的切分：

| | 归属 | 判据 |
|---|---|---|
| **枚举**（这目录里有什么） | **手** | 只有手够得着那台磁盘；这是**能力** |
| **递归 / 通配符 / 排序 / 批大小 / 重试** | **脑** | 纯计算，不需要碰盘；这是**策略** |

`hands.list` 因此只列**一个**目录、**非递归**、**不收 pattern**。

⚠ **缺口是实测出来的，不是推出来的**：对已交付的 peer 调用 `stat(dir)` 只返回
`{"kind":"dir","size":0}`（**无条目列表**），`read(dir)` 报 `EISDIR` ⇒ 四原语**无法发现
任何文件名**。而且即使调用方**已知**文件名，光是为了知道大小仍需 **N 次 `stat`**
（实测 200 次 = 44 ms loopback；5 ms RTT 下 1000 个文件 = **5 秒**）—— 而 `list`
一次调用就能带回一批。这正是 §6 推荐的「批量」在**元数据**上的对应物。

---

## 2. 建议的形状（含 `ctx` 命名与类型）

按 [`host-sessions-design.md`](host-sessions-design.md) §6.1 的**写法基准**：`extends Service`、
**类方法**、**命名空间展平**。理由见 [`cordis-runtime-findings.md`](cordis-runtime-findings.md)
§1.2（普通对象零归因）、§1.3（`Service` 有归因且 per-caller）、§1.7（命名空间子对象也必须是
`Service`）、§1.8（**箭头函数方法静默丢归因**）。

```ts
declare module "cordis" {
  interface Context {
    hands: HandsService
  }
}

/** 一个文件的身份与大小。批量与续传都靠它决定 offset。 */
export type HandsStat = {
  /** 逻辑大小。可能与物理占用不同（稀疏/压缩）。 */
  size: number
  /** 单调递增的文件身份。**跨 rename 稳定**，用于检测轮转。 */
  id: string
  /** 最后修改时刻（epoch ms）。仅作提示，不用于正确性判断。 */
  mtimeMs: number
  /** 是否为目录。`stat` 对目录也有效，便于调用方决定后续动作。 */
  kind: "file" | "dir" | "other"
}

export type HandsReadOptions = {
  /** 从该字节偏移开始读。续传即传上次的 offset。默认 0。 */
  offset?: number
  /** 单块上限（字节）。手的实现据此分配缓冲；调用方不应假设块边界。 */
  chunkSize?: number
  /**
   * 期望的文件身份。若与实际不符 ⇒ 立刻以 `ESTALE` 失败，**不要**继续读。
   * 这是轮转检测的**调用方**一侧：手不替调用方猜语义。
   */
  ifId?: string
}

export type HandsWriteOptions = {
  /** 起始偏移。默认 0（覆盖）；传 offset 即续写。 */
  offset?: number
  /** 打开模式。`truncate` 与 `offset>0` 互斥。 */
  mode?: "create" | "truncate" | "append"
}

export type HandsWatchOptions = {
  /** 目录递归。默认 false。 */
  recursive?: boolean
  /**
   * 从既有内容的该偏移开始投递（`tail -f` 语义）。省略 = 只看新增。
   * 这让「先读历史、再跟进」不需要两次握手。
   */
  fromOffset?: number
}

export type HandsChange = {
  kind: "create" | "modify" | "remove" | "replace"
  path: string
  /** 该文件当时的身份，便于与 `stat` 的结果比对。 */
  id?: string
}

/** 错误面：手只报这几种，调用方不需要解析字符串。 */
export type HandsErrorCode =
  | "ENOENT"      // 不存在
  | "EACCES"      // 无权限 / 授权失效
  | "EISDIR"      // 期望文件却是目录
  | "ENOTDIR"     // 期望目录却是文件（⚠ 与 EISDIR 镜像，修法不同，见 §2.3）
  | "ESTALE"      // 身份已变（轮转）或偏移超出
  | "ENOSPC"      // 目标盘无空间
  | "ECANCEL"     // 调用方取消
  | "EUNSUPPORTED" // 该平台不支持（例如移动端的某些路径）

/** 一个目录条目。`symlink` 单列：列出的是**链接本身**，不是它的目标类型。 */
export type HandsListEntry = {
  name: string
  kind: "file" | "dir" | "symlink" | "other"
  /** 目录为 0；符号链接是**链接自身**的长度。 */
  size: number
}

export class HandsService extends Service {
  // 构造期捕获自身依赖：Service 的 per-caller 代理上 `this.ctx` 是【调用者的 ctx】，
  // 不是提供者的（findings §1.3）—— 故方法内不要用 `this.ctx` 取 logger/配置/设备表。
  constructor(ctx: Context, deps: HandsDeps) {
    super(ctx, "hands")
    this.deps = deps
  }

  // ⚠ 全部写成类方法。写成箭头函数属性会【静默】丢归因（findings §1.8）。

  /** 查一个路径的身份与大小。**不抛**「不存在」，而是返回 null（见 §2.2 的错误约定）。 */
  async stat(path: string): Promise<HandsStat | null>

  /**
   * 读一个文件，返回**异步可迭代的字节块**。
   *
   * 背压由 credit 窗口保证：消费者不取，生产者就停（实测停在 32 块）。详见 §3。
   * 取消 = 退出 `for await` / 调 `.return()`，实现必须立即停读并关闭句柄。
   */
  read(path: string, opts?: HandsReadOptions): AsyncIterable<Uint8Array>

  /** 写一个文件。返回实际写入字节数与**结束偏移**（续传的下一个 offset）。 */
  write(path: string, data: AsyncIterable<Uint8Array>, opts?: HandsWriteOptions):
    Promise<{ bytes: number; endOffset: number }>

  /**
   * 订阅一个路径的变化。
   *
   * 返回的迭代器结束即取消订阅；实现必须保证**取消后不再投递**。
   * ⚠ 轮转语义：见 §4 —— 这是本提案里**唯一**有平台陷阱的原语。
   */
  watch(path: string, opts?: HandsWatchOptions): AsyncIterable<HandsChange>

  /**
   * 列**一个**目录的条目，返回**批次流**（每批 `HandsListEntry[]`）。
   *
   * ⚠ **非递归、不收 pattern、不排序** —— 那些是策略（§1.1）。这是**能力**：
   * 异机时只有手够得着那台磁盘，没有它调用方**连一个文件名都发现不了**。
   *
   * 流式而非单帧回复：目录大小在读完前不可知，单帧会重新引入实测「≥1 MiB 传不动」
   * 的那个形状（§3）。
   */
  list(path: string, opts?: { batch?: number }): AsyncIterable<HandsListEntry[]>

  /** 取消某个进行中的操作（也可用迭代器的 return/throw）。 */
  cancel(handle: HandsHandle): Promise<void>
}
```

### 2.1 为什么把 `stat` 单列

不是为了「方便」，是两个**必需**用途：

1. **批量上传**要预先知道每个文件的大小，才能算 batch size 与进度（transport-lab §6 的批量法）。
2. **续传**必须先知道当前远端大小，才能算 `offset`；而**只有身份 + 大小一起**才能判断
   「该续写，还是文件已被轮转、必须重来」（见 §4）。

### 2.2 错误约定：三种「失败」必须可区分

插件的代码要能**分支处理**，而不是解析错误字符串。三种情形语义不同：

| 情形 | 约定 | 为什么不能合并 |
|---|---|---|
| **查询类**（`stat`）目标不存在 | 返回 **`null`**，不抛 | 「不存在」对 `stat` 是**正常答案**；抛异常会逼调用方用 try/catch 做流程控制 |
| **操作类**（`read`/`write`/`watch`）失败 | 抛 **`HandsError`**，带 `code: HandsErrorCode` | 调用方必须区分 `ESTALE`（该重来）与 `EACCES`（该提示用户） |
| **取消** | 抛 **`ECANCEL`**（或迭代器正常结束） | 「用户取消」不是故障，**不应**被上报为错误告警 |

⚠ 关键的一条：**`ESTALE` 必须与 `ENOENT` 分开**。轮转后的「文件换了」与「文件没了」
需要**完全相反**的处置 —— 前者重来并重置 offset，后者通常该放弃。合并成一个错误码，
会逼调用方去读错误消息文本，而那是**不稳定的接口**。

`HandsErrorCode` 的完整集合见 §2 的类型定义；**新增错误码是破坏性变更**，
SDK 定版后要按版本走。

### 2.3 `stat` 在目录上的**有界预览**（三态，不可合并）

`stat` 仍只回答「这是什么」，但**当目标是目录**时额外带一个**有界预览**，
让「这是我要的那个目录吗」这个**常见**问题**不需要第二次往返**：

```ts
type HandsStat = {
  size: number; id: string; mtimeMs: number
  kind: "file" | "dir" | "other"
  entries?: { items: HandsListEntry[]; truncated: boolean; error?: string } | null
}
```

⚠ **三态必须可分**（合并任何两个都会产生静默错读）：

| 状态 | 表示 | 若合并会怎样 |
|---|---|---|
| **不是目录** | `entries: null` | 与「空目录」混同 ⇒ 调用方以为目录存在且为空 |
| **空目录** | `{items: [], truncated: false}` | 同上 |
| **列不出**（如只有执行权限） | `{items: [], truncated: false, error: "…"}` | 与「空目录」混同 ⇒ 调用方以为里面没东西 |

- `truncated: true` 是**关键**：目录条目超过预览上限时必须置位，否则调用方**以为已经看完**
  而永远不会去调 `list` —— 多出来的条目**静默丢失**。
- **预览上限小且固定**（实现为 16）：`stat` 会在**热路径**被调用（`read` 每块都重查身份），
  它的回复必须**可预期地便宜**，不能因为调用方还没见过的某个目录而变大。
- 列目录**失败不使 `stat` 失败**：size/mtime/kind 仍然为真且有用（与「身份取不到」同样处理）。

### 2.4 ⚠ 「不该出现却出现了」的形状：`ENOTDIR`

`read(dir)` ⇒ `EISDIR`，`list(file)` ⇒ **`ENOTDIR`**。二者**镜像且必须分开**：
「你要文件内容但那是目录」（改列它的条目）与「你要列目录但那是文件」（改 stat 它）
修法不同，合并成一个会让一句错误信息同时解释两件事。

⚠ 实测（Windows）：**`read_dir` 对一个文件会成功并返回空迭代器**。
若不在**读取器内部**（而非只在 handler 里）挡这一下，「文件」与「空目录」就**不可分** ——
调用方会对一个存在的路径得出「里面没东西」的**静默错答**。


---

## 3. 背压：为什么不是可选项

**实测**：消费者取 1 块后停手，生产者**精确停在 32 块**（= kkrpc 的初始 credit 常数）；
无流控的对照组跑了 2048 块。来源：transport-lab §4。

⇒ **形态必须是 `AsyncIterable` + credit 窗口**，不能是「一次调用返回全部字节」。
内存占用是 `credit × chunkSize`，**不是文件大小** —— 这正是「流式」名副其实之处。

⚠ 一个实现约束（实测）：`Buffer.alloc(N)` 是**同步 CPU**，1 GiB 冻结事件循环约 0.25 s
⇒ 手与脑**都必须分块分配**，禁止 `Buffer.alloc(fileSize)`。来源：transport-lab §5。

---

## 4. ⚠ 每个原语的平台陷阱（**本节是提案里最需要 SDK 作者读的部分**）

### 4.1 `watch`：轮转是**免费**的，但「不存在的路径」不是

| 情形 | 实测行为 | 对 SDK 的含义 |
|---|---|---|
| 日志轮转（rename + 新建同名） | **投递继续** —— Windows 下 `notify` 靠监视父目录实现 | 调用方**不需要**重订阅 |
| 轮转**检测** | `file_id` 变化（Windows u128 HighRes，优于 `same-file` 的低位索引） | 由调用方比对 `HandsStat.id`，手只提供 `id` |
| 截断（原地变小） | 身份**不变**，只是 size 变小 | 调用方比对 `size < offset` |
| **路径尚不存在** | **无法预挂 watch**（实测：报错且 0 事件） | ⚠ **手必须在内部改为「监视父目录 + 按路径过滤」**，否则「应用启动时 tail 一个还没建的日志」直接失败 |

来源：[`rust-crates/FINDINGS.md`](probes/hand-io/rust-crates/FINDINGS.md) §4.1–4.3。

### 4.2 `watch` 在**网络/异机路径上不可靠**

`notify` 自己的文档与 issue #254 都写明：NFS/SMB 可能**完全不投递事件**，且
**WSL 程序监视 Windows 路径**是典型受害者。

⇒ **手必须站在文件所在的那台机器上**。这不是性能建议，是正确性前提——
它也是「为什么监视必须是手的原语」的根本理由（§1）。

### 4.3 `read`/`write`：Android 的 `content://` 不是路径

Android 上用户选择返回的是 `content://` URI，**不是文件路径**：

- `into_path()` 对它**必然失败**（by design）—— 别先转路径。
- 取得可 seek 的真 `File` 的**唯一**途径是 `tauri-plugin-fs` 的 `Fs<R>::open`
  （SAF fd 桥）。来源：[`rust-crates/FINDINGS.md`](probes/hand-io/rust-crates/FINDINGS.md) §8.1。
- ⚠ **已知上游缺陷**：该路径在 provider 显式 `return null` 时会 `unimplemented!()`
  **abort 进程**，且**无法从我们侧捕获**（`panic="abort"` + Cargo 拒绝 per-package 覆盖
  + 跨 FFI 展开是 UB）。判据与上游 PR #3236 见同节 §8.2。
  **裁定：轻微缺陷，通过不修**（最坏崩溃重启、触发路径窄；复现需真机 + SDK）。

### 4.4 `write` 的追加语义

`append` 模式**忽略被移动的游标**（实测）—— 这是**多写者下滚动日志唯一正确**的写法，
因为 `seek(End)` 后 `write` 之间存在竞态。来源：`rust-crates/FINDINGS.md` §3。

⚠ Windows：以 append-only 打开的文件**无法加锁**（std 文档）；若需既可锁又可追加，
用 `.read(true).append(true)`。

---

## 5. ⚠ 单管道队头阻塞：**推论已被实测部分修正**

> **本节原为纯推论**（引 transport-lab 的 **ws** 数字：交互 p50 0.66 → 321 ms）。
> 本轮在**真 Rust peer + 真管道**上测了（[`probes/hands-e2e/hol.mjs`](probes/hands-e2e/hol.mjs)，
> 128 MiB，n=100），结论**要改一半**：中位数几乎不动，代价在尾部。
> 详见 [`hands-host-design.md`](hands-host-design.md) §5。

| | idle | 传输中 | 倍数 |
|---|---|---|---|
| `hands.stat` p50 | 0.15 ms | 0.19 ms | **1.28x** |
| `hands.stat` p95 | 0.37 ms | 18.85 ms | **51x** |
| 传输后 p95 | — | 0.21 ms | 恢复 |

**⇒ 「用户会感到托盘卡住」这个说法被削弱了**：p50 无感，用户多半感觉不到。
但 **p95 51x 是真的**，且机制上说得通 —— 手侧 `write()` **逐帧持锁**（不是整个文件），
所以交互调用最多等**一块**写完：多数时候插得进去，偶尔排队 ⇒ 中位数不变、尾部爆炸。

> ⚠ **本节写于修复之前，保留作记录；真因与结局见
> [`hands-host-design.md`](hands-host-design.md) §5。** 两处更正：
> ①上面「逐帧持锁」只是**推测**，真因是由 `hol-credit.mjs` 分离出来的
> **`pump_producer` 在 reader 线程上跑完整批 credit**；
> ②该缺陷**已修**（生产者改为自己的线程）：**p95 70x → ~9x**，但
> **p50 由 1.03x 退到 ~8x** —— 上面这把写锁现在成了主要成本。

⚠ **仍未决的两点**（不因本次测量消失）：

- **跨机未测**。本地管道是**下界**；异机上一块的写入时间随链路放大。尾部已压低，
  但**绝对值的跨机表现仍未知**。**本测量不能推出跨机结论**（transport-lab §8 同款纪律）。
- **未分离的疑因**：尾部可能来自**排队**，也可能来自**对端忙**（手侧 reader 线程既要泵块
  又要处理入站帧）。两者修法不同（第二条通道 vs 廉价化每块成本），本测量**不足以区分**。

> ⚠ **载体（base64/二进制）与通道数（一条/两条）是两个独立轴，别混为一谈。**
> 二进制分帧在**单条管道**上已验证可行（§9.1 ①），所以「要 raw」**不**需要第二条通道。
> 而尾部问题的修法（限流/让出/优先级）也**不**取决于载体。四种组合都成立。
> 本节原本把「第二条通道」与「每块成本」并列成二选一，那**缩小了**可选项。

事实：

- 手⇄脑今天**只有一条 stdin/stdout 管道**（`src-tauri/src/host.rs:1217-1219`）。
- 手侧的写入是**单锁串行**（`kkrpc_peer.rs` 的 `write()` 持 `writer.lock()` 后
  `write_all`）。

**三条出路（提案不替 SDK 决定，但必须让它知道这个取舍存在）**：

| 出路 | 代价 | 何时合适 |
|---|---|---|
| **(a) 给手⇄脑加第二条通道**（大流量专用） | 壳要开第二个 fd / socket；生命周期与现管道一并管 | 若**跨机尾部**实测确实不可接受 |
| **(b) 脑侧限流**：一次只挂一个 bulk 流，且实现**分片让出** | 无需改协议；但交互延迟仍会恶化，只是有上界 | 若文件传输是**偶发功能** |
| **(c) 不解决**，接受传输期间交互劣化 | 零成本 | **比原先更站得住**：p50 已证明无感 |

⚠ 实测的另一半：共享隧道里那 75 ms 的残留在**独立连接**下依然存在，
说明**发送端必须分片让出**是**无论选哪条出路都要做的**（transport-lab §3）。

**这项必须进 SDK 决策**：它决定 `ctx.hands` 是「挂在现有通道上的普通服务」，
还是「需要一条独立通道的传输服务」。

---

## 6. ⚠ 审计插针：`ctx.hands` 必须可归因

`#17`（M2-1）把**透明调用记录**列为随决定一起采取的 4 条护栏之一，并明示理由：

> 领域服务可能被绕过……raw 路径的 warn 归因需额外做工（对象方法不读 `this`）

`#24`（M2-8）进一步定了落点与要求：

> `this[symbols.caller]` → `.fiber.entry` → `.options`；**两条路径都要覆盖**；
> 越权检测 + **warn 日志**；**不做硬拒绝**

⇒ **`ctx.hands` 不能只是「能跑」，它必须能被审计。** 因为它是**流式**服务，
实现时有两个具体的落点要注意：**审计记几次**（§6.2）与 **`this` 是什么**（§6.2a）。

### 6.1 照抄现有形状

现有唯一的正确实现是 [`host/src/capability.ts`](../host/src/capability.ts)：
`buildNode` 把每个方法包成**普通函数**（**不能是箭头函数** —— 见 findings §1.8），
在调用时同步 `handle.record(this, "<ns>.<method>", args)`，再由 `ShellHandle.record`
经 `callerName(this)` 解析 `symbols.caller` → `fiber.entry.id`。

`ctx.hands` 必须**同一形状**，且同样落在 `HOST_SERVICES` / `REQUESTABLE_CAPABILITIES`
（[`host/src/contracts/capabilityInventory.ts`](../host/src/contracts/capabilityInventory.ts)）
—— 那是**单一真源**，由 `capability-surfaces.test.ts` 与 `swap-ability-contract.test.ts` 钉住。
**新增能力必须同时登记，否则契约测试会红。**

### 6.2 流式方法：审计**记一次**，不要每块记

> ⚠ **本节初稿断言「在 generator 体内 record 会丢归因」—— 该断言已被探针推翻。**
> 实测（[`probes/probe-hand-attribution.ts`](probes/probe-hand-attribution.ts)）：
> **三种形状都保留了归因**，包括「记录写进 async generator 体内」。
> 我原先是把 findings §1.8 的「箭头函数丢归因」**外推**到了 generator，没有实测 ——
> 记录在此，避免后人重犯。

实测结果（A/B/C 由同一个 plugin 调用，走真实 Service per-caller 代理）：

```
A sync method                      when=at call      who=namedPlugin
B record inside generator          when=first next() who=namedPlugin
C record at call, return gen       when=at call      who=namedPlugin
```

⇒ **归因本身不是问题**。真正要守的是**另外两条**：

| 规则 | 为什么 |
|---|---|
| **一个流只记一条审计行** | 每块都记 ⇒ 一个 GB 文件上万行，**日志被淹没**，真正的越权调用反而看不见。审计的语义是「**这个插件申请读这个路径**」，不是「读了多少块」 |
| 块数/字节数/耗时属于 **metrics**，不属于审计 | 不要塞进 `[cap]` 行；观测需求走另一条路 |

两种写法**都能归因**，所以选哪种是**日志量**的问题，不是正确性问题：

```ts
// ✅ 推荐：调用时记一次。「申请读」是审计事件，「读了多少」是指标。
read(path: string, opts?: HandsReadOptions): AsyncIterable<Uint8Array> {
  this.handle.record(this, "hands.read", [path, opts])
  return this.impl.readStream(path, opts)
}

// ⚠ 可行但不推荐：generator 体内记 —— 归因正常（已实测），但若放在循环里
//    就会按块刷审计
async *read(path: string, opts?: HandsReadOptions) {
  this.handle.record(this, "hands.read", [path, opts])   // 只记一次，仍在 next() 时才执行
  ...
}
```

⚠ 第二条写法还有一个**延迟**差异：generator 体内那句要等**首次 `next()`** 才执行。
若调用方「拿到迭代器但不消费」，审计就**不会**记 —— 于是「申请了但没用」不留痕。
**这是选第一种写法的实际理由**，而不是归因。

### 6.2a ⚠ `this` 在 Service 方法里**不是实例**（实测踩到）

写探针时发现的**实现约束**，与归因同理但更硬：

cordis 的 `createShadowMethod` 会把 `thisArg` 换成 per-caller 的 **shadow 对象**
（`host/node_modules/cordis/lib/index.js:136-143`），所以 Service 方法里的 `this`
只**原型链地**看得见公开成员。

⇒ **`this.#privateField` / `this.#privateMethod()` 会直接抛**
`TypeError: Cannot access private method`（实测）。实现 `HandsService` 时：

- ✅ 用公开字段/方法，或**模块作用域的闭包**持有内部状态
- ✅ 构造期捕获 `deps`（findings §1.3 已要求 —— `this.ctx` 也是调用者的）
- ❌ 不要用 `#private`，也不要假设 `this === 服务实例`

### 6.3 流式方法与 M2-8 的交互

`#24` 的落点是 `this[symbols.caller] → .fiber.entry → .options`。流式的麻烦是：
**长流可能活得比调用者的关注点更久**（例如插件已卸载，流还在跑）。

⇒ 两条要求：

1. **归因在调用时定死**（§6.2），这样即使之后 fiber 变化，审计行仍指向发起者。
2. **流的生命周期必须绑 `ctx.effect`** —— 插件卸载即断流。这条**今天未实现、未测**
   （§8 第 4 项），但它是 `ctx.hands` 能被安全授予的前提：**一个卸载后仍在读盘的服务，
   审计也救不了它。**

---

## 7. 多机维度：现在钉「本机/主手」，但**给 SDK 留形状**

`#17`（M2-1，已 closed）已钉死：

> `ctx.shell` 的语义钉为**本机 / 主手**……**多设备定向（「推给哪台设备」）归 `#13`**

⇒ 本提案**遵守**该边界：`ctx.hands` 同样是**本机/主手**。

但 SDK 定版时要预留一件事——**别把「本机」写进类型签名**：

```ts
// ✅ 形状可扩展（未来 #13 落地时加可选 device 参数，不破坏调用方）
read(path: string, opts?: HandsReadOptions): AsyncIterable<Uint8Array>

// ❌ 把「本机」焊进名字/类型，将来要改签名
readLocalFile(path: string): ...
```

理由：**「多机」≠「移动端」**——桌面→桌面、桌面→Web、第二窗口同样成立。
把本机写进类型，会让 #13 落地时变成一次**破坏性**变更。

### 7.1 ⚠ 路径语义（实测，**SDK 必须照此写，别猜**）

手的路径**直接交给 OS**，所以语义由 OS 决定。本轮全部实测过，且**初版提案里一个字都没有** ——
这是缺口，因为调用方会**猜**（`~` 看起来就该展开），而猜错的后果是**静默的**。

| 输入 | 实测行为 | 该怎么做 |
|---|---|---|
| **绝对路径** | 正常 | ✅ SDK 文档只承诺这一种 |
| **相对路径** | **能解析**，以**手的进程 cwd** 为基准 | ⚠ 异机时无意义（调用方不知道手的 cwd）；**不要依赖** |
| `..` | **按字面折叠**：`NOSUCHDIR\..\..` 照样解析成功 | 它**不是权限边界**，别当沙箱用 |
| `~` / `~/x` | **不展开**，当**字面名** ⇒ 静默 `null` | **脑侧展开**：用 `shell.path.dir().home`（那是**手的** home） |
| `%VAR%` / `$VAR` | **不展开**，当字面名 | **脑侧展开**；平台相关语法不该进手的跨平台契约 |
| 尾斜杠 | 正常 | — |

> ⚠ **我先前写错过两条，都记在这里**：
> ①「相对路径不支持」—— **错**。当初用了一个「相对该 cwd 并不存在」的路径去测，
> 而 `null` 在**「不支持」与「不存在」之间有歧义**，我把它读成了「不支持」。
> ②「`..` 会被拒绝」—— **错**，见上表。
>
> **⇒ 无路径围栏**：手进程能到达的任何路径都可达（实测读到 `C:\WINDOWS\win.ini`）。
> 这是本层**已知且接受**的性质（提案的授权粒度停在**原语**级，不做路径级），
> 写在这里是为了**没有调用方会误以为它是沙箱**。

**`~` 的正确做法**（为什么「脑侧展开」不是限制，而是唯一不会搞错的做法）：

```
const { home } = await ctx.shell.path.dir()   // 手的 home，不是脑的
await ctx.hands.read(path.replace(/^~/, home))
```

⚠ **不要让手展开**：手是壳进程，它的 `$HOME`/`%APPDATA%` 可能是**从脑继承来的**
（脑由壳 spawn，`host.rs` **没有** `env_clear`）—— 那会**静默展开到脑的环境**而非用户的环境。

### 7.2 ⚠ 手 → 脑 `hello`：节点标识与环境（**新增**，SDK 需要知道）

**问题**：stdio 通道此前在**身份意义上是单向的** —— 脑自报家门（`ready` 带**脑的**
cwd/execPath/runtime），**手一声不吭**。于是脑无法判断「我在跟哪台机器 / 哪个进程说话」，
从手读到的每个事实都**没有归属**。

**修法选型（为什么不是「每个字段打 `source` 标记」）**：

| 做法 | 性质 | 后果 |
|---|---|---|
| 每字段打 `{source:"hands"}` | **逐字段纪律** | 必须处处记得；**漏一个**就得到一个「看起来是本机、其实来自别处」的值 |
| **握手一次绑定节点**（采用） | **构造性** | 通道绑定节点 N ⇒ 之后所有事实**构造上**属于 N，**没有可忘的地方** |

这与本仓库既有的教训同源（`host/src/capability.ts:34`：「`fiber.name` 不是身份，要沿父链走」）——
**看似是键的东西不是键**。

**负载**（`hands.hello`，**每壳进程一次**）：

| 字段 | 为何在此 |
|---|---|
| `schemaVersion` | 手是**更可能先升级**的一侧，脑需要它把版本偏斜变成**具名拒绝**而不是一堆 undefined |
| `node.launchId` | ⚠ **每次启动**，**不是持久设备身份**：壳还没有持久化，任何 id 每次都会变。持久身份是 `#13`（要凭据，不是随机串） |
| `node.platform/arch/family` | 让脑不必反问 |
| `node.shellVersion` | 区分「手升级了」与「手行为异常」 |
| `cwd` + `cwdError` | 相对路径的基准；`cwdError` 让 `""` **不含歧义** |
| `home` | **展开 `~` 的正确基准**（§7.1） |
| `env` | 见下 |

⚠ **`env` 的两条边界**（都写进了类型注释，别当安全机制）：
1. **凭证形状的名字按名脱敏**为 `"<redacted>"`。这是**日志辅助**，**覆盖是部分的**，
   **不是安全边界** —— 同机时脑本来就共享这份环境（壳 spawn 脑时**没有 `env_clear`**）。
2. **这是「节点 N 的环境」，不是「脑的环境」**。同机时二者恰好一致，**异机时不同**。
   这才是插件会搞混的**真正位置**：同名键在两台机器上指向不同东西。

⚠ **本机（今天）**：脑读自己的 `process.env` 就够。**异机才是这个字段的意义所在** ——
也正是「手≠脑」这个能力存在的场景。

---

## 8. 反模式（**别做**，每条都有实测代价）

| 反模式 | 代价 | 来源 |
|---|---|---|
| 给手加**递归/通配符**技能 | 策略进错层：递归深度、跳过规则、匹配语义都是业务决定。**注意与「枚举」区分** —— 枚举是能力（§1.1），这两个是策略 | transport-lab §6 + §1.1 |
| 让手**打包文件内容**（zip/tar） | 把归档格式、进度语义、续传全绑进手里；实测每文件成本 = 一个 RTT，修法是脑侧批量 | transport-lab §6 |
| ⚠ 以为「遍历归脑」所以手不需要枚举 | **脑在异机时够不着磁盘**，四原语下连一个文件名都发现不了 | 实测：`stat(dir)` 无条目、`read(dir)` 报 `EISDIR` |
| 用 kkrpc 出厂的 JSON 载体传二进制 | `Uint8Array` → `{"0":12,…}`，膨胀 11.4x、慢 29.7x，≥1 MiB **基本传不动** | transport-lab §2 |
| 为文件 I/O 上线程池 | 不需要：所有异步文件 API 都不阻塞事件循环（1 GiB 下 ≤3.2 ms） | transport-lab §5 |
| 一次 `Buffer.alloc(fileSize)` | 同步 CPU，1 GiB 冻结循环 ~0.25 s | transport-lab §5 |
| 把 bulk 与 RPC 混在一条带优先级语义的通道 | **kkrpc 没有优先级/QoS**；共享隧道交互 p50 0.66→321 ms | transport-lab §3 + 本次核实 |
| 让手解析 `content://` 为路径 | `into_path()` 对它必然失败 | `rust-crates` §8.1 |
| 以为手会展开 `~` / `%VAR%` | 实测**不展开**：当**字面名**处理，静默 `null`。展开是脑的活（只有它知道用户约定） | 本轮实测（§7.1） |
| 以为 `..` 被沙箱挡住 | **无路径围栏**：`..` 由 OS **按字面**折叠（`NOSUCHDIR\..\..` 照样解析），绝对路径可达整盘 | 本轮实测（§7.1） |

---

## 9. 未解 / 未验证（**SDK 不应假设这些已定**）

> **落地进度**（2026-09 本轮）：第 2 项部分解决（`offset` 参数已实现并端到端验证），
> 第 3 项的**机制**已验证（见下），第 4 项仍未做。**其余仍未决** —— 落地了传输层
> 不等于回答了这些问题。

1. **单管道队头阻塞的取舍**（§5）—— 三条出路选哪条，**未决**，且需要 SDK 参与。
   ⚠ 本轮落地**没有**改变这一点：`hands.read` 的块仍然与 `shell.notify` 共用那条管道，
   `src-tauri/src/host.rs` 依旧只开一条 stdin/stdout。**这是落地后反而更紧迫的问题。**
2. **断点续传的编排**：`offset` 参数与 `ESTALE` 检测**都已实现并验证**（§4.1 的轮转
   检测在 `read` 中途也会触发）；但**「谁记 offset、何时校验身份、失败如何回退」**
   仍是脑侧协议，**未设计**。
3. **进度上报的粒度与开销**：**未测**。落地后 `hands.write` 的 deferred reply 只回报
   最终 `{bytes, endOffset}`；**中途进度没有任何上报** —— 需要时是脑侧按块计数，
   而不是让手加一个 progress 回调。
4. **流生命周期绑定 `ctx.effect`**：**仍未实现**（这是脑侧 SDK 的事）。
   Rust 侧已做到的是**传输层**的对应物：`open_event_stream` 的 `return` 与传输 EOF
   都会 `close()` 那个 watch（有单测钉住），所以「流断了但 watch 还在」在**手侧**
   不会发生。**但「插件卸载 → 断流」必须由 SDK 侧接上 `ctx.effect`。**
5. **审计插针的落地**（§6）：形状已由 `host/src/capability.ts` 给出，但 `ctx.hands`
   尚未实现。⚠ 落地后发现一条**新的实现约束**：`hands.*` 是 kkrpc 方法，**不经过
   cordis 的 per-caller 代理**，所以 §6.2 的「调用时记一次」必须由 **SDK 侧的 wrapper**
   完成 —— 不能指望 Rust 侧归因（它根本看不见 cordis）。
6. **Android 真机**：文件访问的 SAF fd 桥与 `notify` 的 inotify 后端**都只经过源码阅读**。
   本轮新增的只是**交叉编译验证**：`hands.rs` 与 `kkrpc_peer.rs` 在
   `aarch64-linux-android` 上 `cargo check` **通过**。**编译通过 ≠ 能跑**，证据缺口不变。
7. **手的文件能力归属哪个里程碑**：**未定**。本提案只提供输入，不主张排期。

### 9.1 落地时**新发现**的两条（不在原提案里）

**① kkrpc 的流式帧没有二进制载体 —— 但那**只在保留出厂 platform+codec 时成立**。**
第一次端到端跑就撞上了：host 侧 `yield new Uint8Array(...)` 得到的**不是二进制**，
而是 `{"0":65,"1":66,…}`（11.4x 膨胀），Rust 侧报 `unrecognised stream value shape`。
⇒ 在**当前**实现里，`hands.write` 的调用方**必须**自己编码，base64 是其中最便宜的一种
（1.33x）。手侧现在三种形状都认（base64 / Node `Buffer` / `Uint8Array` 数字键），
因为「发送方忘了编码」若变成静默错读或不可解的错误，都比「正确但费带宽」更糟。
见 `kkrpc_peer.rs::decode_chunk`。

> ⚠ **本节初稿称「base64 是流式通道上的**实际契约**」，那个措辞是错的，已改。**
> 它把**平台**限制说成了**协议**限制 —— 而
> [`hand-io/FINDINGS.md` §5.1](probes/hand-io/FINDINGS.md) **早就把同一类错误改过一次**
> （原称二进制分帧「会与行分割器冲突」，实际只在保留 `stdioPlatform` 时成立）。
> 我引用了那条更正，却又在别处重犯了它 —— 记在这里，避免第三次。
>
> 准确的说法是：**kkrpc 允许替换 platform 与 codec**
> （`createTransport({ platform, codec })`，`kkrpc/transport` 是公开入口），
> 实测（[`04-binary-framing.mjs`](probes/hand-io/04-binary-framing.mjs)）长度前缀二进制
> 分帧在**同一条管道**上可行、无失步，且比 base64 快 **1.8–2.1x**。
> 代价是**两端都要改**（JS 侧 platform+codec，以及 `kkrpc_peer.rs` 的行读取循环）——
> 那是成本，不是不可能。
>
> ⚠ 并且它与「第二条通道」（§5）是**两个独立决定**，不是一回事：
> `04` 用的就是**一条**管道（`stdio: ["pipe","pipe","pipe"]`）。
> 四种组合都存在：单/双管道 × base64/二进制。**要 raw 不需要第二条通道。**

**② `hands.write` 的回复无法在 handler 内产生，必须是 deferred。**
「写了多少字节」只有收到最后一块才知道，所以这条 RPC 的回复由流的完成回调发出，
而不是 handler 的返回值。这把 `kkrpc_peer.rs` 的 `Peer` 从「一请求一回复」扩成
**两种 handler**（`Sync` / `Deferred`）；`hands.read` 则不需要它 —— 它立刻返回
一个流引用。**SDK 侧无感，但任何后续「消费流的 RPC」都要走这条路。**


---

## 10. 与既有文档的关系

| 本文内容 | 主副本（冲突以它为准） |
|---|---|
| 背压 / 编码 / 队头阻塞 / 批量 / 反模式 | [`probes/transport-lab/FINDINGS.md`](probes/transport-lab/FINDINGS.md) |
| 手侧传输 / 跨机 / Android 授权 | [`probes/hand-io/FINDINGS.md`](probes/hand-io/FINDINGS.md) |
| 用哪些 crate / 文件访问层 / 上游缺陷 | [`probes/hand-io/rust-crates/FINDINGS.md`](probes/hand-io/rust-crates/FINDINGS.md) |
| `notify` 版本 A/B | [`probes/hand-io/notify-version/`](probes/hand-io/notify-version/) |
| 服务写法基准（`extends Service` / 类方法 / 展平） | [`host-sessions-design.md`](host-sessions-design.md) §6.1 |
| Cordis 归因与 inject 纪律 | [`cordis-runtime-findings.md`](cordis-runtime-findings.md) §0/§1 |
| `ctx.shell` 语义与多机边界 | GitHub `#17`（M2-1）、`#13` |
