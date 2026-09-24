# `ctx.hands` 宿主侧方案（含审计）

> **状态**：**方案，待实现**。手侧四个原语已落地（PR #40）；本文是把它们接成
> 插件可用能力面的宿主侧设计。
> **日期**：2026-09。
> **关系**：形状来自 [`hands-capability-proposal.md`](hands-capability-proposal.md)；
> 本文只增补**宿主侧的新实测**与落地步骤。冲突以实测为准。

---

## 0. 一句话与三个前提

把 `hands.stat/read/write/watch` 包成 `ctx.hands`（`Service` 子类），**每条流绑调用者
的生命周期**，并让每次调用**可归因、可审计**。

落地前必须先解决三件事，三件都有本轮实测：

| # | 前提 | 结论 | 证据 |
|---|---|---|---|
| 1 | 宿主的 stdio 通道**现在根本收不到流** | 现用 `RPCChannel`，编译产物里 `"sq"`/`"sr"` 出现 **0 次** ⇒ 流帧到达即被丢弃。必须换 `StreamingRPCChannel` | `probes/probe-host-streaming-channel.ts` Q3 |
| 2 | 换通道不能回归既有 RPC | `StreamingRPCChannel` 对普通请求/回复**双方向都是 drop-in**（嵌套命名空间、`expose` 均正常） | 同上 Q1 |
| 3 | 流不绑生命周期会**泄漏** | 不绑的流在插件卸载后**继续产出 16 块**；绑了则在卸载时**立即停** | `probes/probe-host-stream-leak.ts` |

---

## 1. 通道切换（#1 前提）

```ts
// host/src/stdio.ts —— 现在
import { RPCChannel, type RPCMessage, type Transport } from "kkrpc"
const channel = new RPCChannel<HostStdioAPI, ShellSysAPI>(transport, {...})

// 改为
import { StreamingRPCChannel } from "kkrpc/streaming"
const channel = new StreamingRPCChannel<HostStdioAPI, ShellSysAPI>(transport, {...})
```

⚠ **两条不能想当然的地方**（都已实测）：

1. **`StreamingRPCChannel` 不是 `RPCChannel` 的别名** —— 它是另一个类，同样接受
   `onClose` / `expose` / 测试注入的 `transport`，所以调用点不用改，但**它给每条流
   维护状态表**（`localStreams`/`remoteStreams`/`pendingStreams`），因此
   `destroy()` 的语义比原来更重：通道销毁会**主动关闭所有在途流**。这是我们要的行为，
   但它是新增的拆除路径，必须覆盖测试。

2. **收上来的块是 base64 字符串，不是字节。** 实测：Rust 侧发 `"AAEC"`，
   Node 侧 `for await` 拿到的 `typeof === "string"`。
   原因与手侧同一个：kkrpc 出厂 JSON codec 没有二进制形态（transport-lab §2）。
   ⇒ 提案 §2 的 `AsyncIterable<Uint8Array>` 签名**要求宿主侧解码**，
   它**不是**透传。这是实现细节，但**签名与实现的落差**必须写下来，否则下一个人会以为
   拿到的是 `Uint8Array` 而写出静默错读的代码（本仓已犯过一次同类错）。

   > ⚠ **但这不是「只能用 base64」**：出厂 codec 可替换
   > （`createTransport({ platform, codec })`，`kkrpc/transport` 是公开入口），
   > 长度前缀二进制分帧在**同一条管道**上实测可行且快 **1.8–2.1x**
   > （[`probes/hand-io/04-binary-framing.mjs`](probes/hand-io/04-binary-framing.mjs)）。
   > 代价是**两端都要改**。**载体**与**通道数**是两个独立轴 —— 详见 §5。

---

## 2. 服务形状

沿用 [`host-sessions-design.md`](host-sessions-design.md) §6.1 的写法基准与
`host/src/capability.ts` 的既有形状：

```ts
declare module "cordis" {
  interface Context {
    hands: HandsService
  }
}

export class HandsService extends Service {
  // 构造期捕获：`this.ctx` 在方法内是【调用者的 ctx】（findings §1.3）
  constructor(ctx: Context, private readonly bridge: HandsBridge) {
    super(ctx, "hands")
  }
  // ⚠ 全部类方法。箭头函数属性会【静默】丢归因（findings §1.8）。
  // ⚠ 不要用 #private：`this` 是 per-caller shadow，`this.#x` 直接抛（proposal §6.2a）。
}
```

**无壳语义**（与 `ShortcutService` 一致）：没有壳时返回 `no-shell` 语义的结果或抛
带 `code` 的错，**不静默挂起**。`inject` 是就绪门不是访问门，服务必须**先 provide、
后 attachShell**。

---

## 3. ⚠ 审计：三个落点，一个已实测的坑

`#17` 把透明调用记录列为护栏，`#24` 定了落点
（`this[symbols.caller]` → `.fiber.entry` → `.options`，越权 **warn 不硬拒**）。
`ctx.hands` 是**流式**服务，所以有三点要注意：

### 3.1 照抄 `buildNode` 的形状

`host/src/capability.ts` 已有正确实现：`buildNode` 把方法包成**普通函数**，
调用时同步 `handle.record(this, "<ns>.<method>", args)`。
`ctx.hands` 用**同一形状**，并登记进
[`host/src/contracts/capabilityInventory.ts`](../host/src/contracts/capabilityInventory.ts)
的 `HOST_SERVICES` 与 `REQUESTABLE_CAPABILITIES`
—— 那是单一真源，`capability-surfaces.test.ts` 与 `swap-ability-contract.test.ts` 钉住它，
**不登记就是契约测试红**。同时 `contracts/plugin-manifest/v1/plugin-manifest.schema.json`
的 `Permissions.properties` 要加 `hands`（`$defs.Permissions` 的键集合与
`REQUESTABLE_CAPABILITIES` 逐字对齐，由 `swap-ability-contract.test.ts` 钉住）。

### 3.2 一个流只记**一条**审计行

审计的语义是「**这个插件申请读这个路径**」，不是「读了多少块」。每块记一次 ⇒ 一个 GB
文件上万行，**真正的越权调用反而被淹没**。块数/字节数/耗时属于 metrics，不进 `[cap]` 行。

⚠ 实测（`probes/probe-hand-attribution.ts`）：三种形状**都保留归因**，包括把 record 写进
async generator 体内。所以选哪种是**日志量**问题，不是正确性问题。推荐「调用时记一次」，
另有一个**实际**理由：generator 体内那句要等首次 `next()` 才执行，
调用方「拿到迭代器但不消费」就**不留痕**。

### 3.3 ⚠ 流比调用者活得久 —— 这是审计救不了的那条

`#24` 的落点在**调用时定死**归因，这对普通调用足够。但流是异步延续的：
**插件卸载后，流可能还在读盘**。归因行仍然指向发起者，但**没有任何东西会停它**。

实测（`probes/probe-host-stream-leak.ts`）：

```
A unguarded                    chunksAfterUnload= 16  disposerRan=false  halted=false
B guarded by caller ctx.effect chunksAfterUnload=  0  disposerRan=true   halted=true

RESULT A CONFIRMED LEAK: 插件卸载后，未加护栏的流又产出了 16 块。
```

⇒ **必须显式绑生命周期**，机制见 §4。

---

## 4. 流生命周期：`this.ctx.effect` 就是那个机制（已实测）

提案 §8 第 4 项原写「未实现、未测」。本轮测了：

| 问题 | 结果 | 证据 |
|---|---|---|
| Service 方法内 `this.ctx.effect(...)` 绑到谁？ | **调用者的 fiber**（从插件调用时 `this.ctx.fiber.name` = 插件名） | `probe-host-stream-lifecycle.ts` Q1 |
| 插件卸载会执行它吗？ | **会** | 同上 |
| 它真能停流吗？ | **能**（`chunksAfterUnload=0`） | `probe-host-stream-leak.ts` B |
| `ctx.effect` 返回 disposer 吗？ | **返回**，可提前释放 | `probe-host-effect-economy.ts` Q_A |

### 4.1 ⚠ 但那不是「注册了就不用管」

文件能力是**在循环里调用**的：一个插件同步 10000 个文件就调 10000 次 `read()`。
实测：**1000 次注册全部留存到卸载时**才执行（`probe-host-effect-economy.ts` Q_C2）。

⇒ **每条流结束时必须释放它自己的注册**：

```ts
read(path, opts) {
  this.record(this, "hands.read", [path, opts])   // 3.2：只记一次
  const release = this.ctx.effect(() => () => abortStream(handle))
  return wrap(stream, { onEnd: release, onCancel: release })  // 正常结束/取消都释放
}
```

不释放的话，护栏自己变成一个无界增长的表 —— 与它要防的泄漏同一量级。

### 4.2 从**根 ctx** 调用时：effect 不会在插件卸载时执行（但会在**优雅停机**时执行）

⚠ **本条被修正过一次，务必读完整。** 第一版探针只等到超时就下结论说「根 ctx 的 effect
永不执行」—— **那是错的**，它只是没等到宿主真正停机。补测后完整事实是：

| 场景 | 根 ctx 上的 effect | 证据 |
|---|---|---|
| 插件卸载 | **不执行**（它不属于任何插件 fiber） | `probe-host-root-effect-shutdown.ts` Q4 |
| 宿主**优雅停机** | **执行** —— 因为 `host/src/lifecycle.ts:104-114` 显式 `root._disposables.clear()` 并逐个 await | 同 Q2 |
| 宿主**硬杀**（TerminateProcess） | **不执行**（进程没了，任何 disposer 都不跑） | —— |

⇒ 关键区别不是「根 effect 有用没用」，而是 **「谁负责停」**：

- **插件调用** `ctx.hands` → 卸载时自动断（`this.ctx` 是调用者 fiber）；
- **宿主自己调用** `ctx.hands` → **插件卸载与它无关**，它只在宿主优雅停机时被清理；
  若宿主开了流却不自己关，**它会一直活到进程结束**（硬杀时连清理都没有）。

这直接影响「宿主自己能不能用 `ctx.hands`」这个产品问题，**不替你定**。三个处置：

- **(a) 服务在宿主 ctx 上再注册一份兜底**：插件调用走调用者 fiber，宿主调用走宿主 ctx。
  代价是多一层注册与释放。
- **(b) 只在有 `fiber.entry` 时依赖 `ctx.effect`**：无 entry 的调用者（宿主自身、
  裸 `ctx.plugin()`）由调用方自己管生命周期。更简单，但宿主自己用时没有自动保护。
- **(c) 宿主内部禁用 `ctx.hands`**：只给插件用，宿主内部走别的路径。
  边界最清晰 —— 而且**宿主内部确实有别的路径**：`host/src/watcher.ts`、
  `dev-watch.ts`、`watch-path.ts` 等已有 6 处直接用 `node:fs`，
  它们操作的是**宿主自己那台机器的**磁盘，与「手」的能力不是一回事。

#### 4.2.1 ⚠ 方案 A 的成本**被实测推翻**（原先的描述是错的）

上表把 (a) 写成「两边都注册，代价是多一层注册 + 一次释放」。实测
（[`probes/probe-host-option-a-cost.ts`](probes/probe-host-option-a-cost.ts)）显示**不是这样**：

| 问题 | 实测 |
|---|---|
| 一条流要注册几次？ | **1 次**，不是 2 次（Q4：根调用者只加 1 条） |
| 注册本身多贵？ | **≈ 7.4 us**（10000 次实测），相对一次 RPC 往返（~150 us 量级）可忽略 |
| 不释放会怎样？ | 累积（1000 条留存；释放后归 1）⇒ **释放是纪律，不是可选** |
| 插件流何时停？ | 插件卸载即停（Q3a） |
| 宿主自己的流何时停？ | 优雅停机步骤 3（Q3b）—— 不是「插件卸载时」 |

**为什么只有一套**：服务方法内 `this.ctx` **本来就是调用者的 ctx**（findings §1.3）。
所以 `this.ctx.effect(...)` **一行就是方案 A 本身**：

- 插件调用 → 落在插件 fiber → 卸载自动停；
- 宿主调用 → 落在根 ctx → 优雅停机步骤 3 停。

而 gracefulStop **先处置插件 fiber（步骤 1-2）再清根（步骤 3）**，
所以插件的流早被自己的 fiber 停掉了，**不需要**第二份根注册。

⇒ **A 反而是最省事的写法**：B 要额外分支（判断有无 `fiber.entry`），C 要额外拦截。
**成本不构成取舍理由** —— 这个决策应由**语义**决定（谁负责停、宿主是否该走这条路径），
不该由工程量或性能决定。

⚠ 仍存的缺口（不夸大）：**硬杀时两边都不执行**；宿主自己的流在会话期内
只受「调用方记得释放」约束。

---

## 5. ⚠ 单管道队头阻塞：提案 §5 的推论**被本轮实测部分修正**

提案 §5 说 bulk 会与交互调用抢道，引的是 transport-lab 的 **ws** 数字
（交互 p50 0.66 → 321 ms），并自陈那是**推论**。本轮在**真 Rust peer + 真管道**上测了
（`hands-e2e/hol.mjs`，128 MiB，n=100）：

| | idle | 传输中 | 倍数 |
|---|---|---|---|
| `hands.stat` p50 | 0.15 ms | 0.19 ms | **1.28x** |
| `hands.stat` p95 | 0.37 ms | 18.85 ms | **51x** |
| 传输后 p95 | — | 0.21 ms | 恢复 |

**⇒ 要修正的是「p50 会劣化」这一半：中位数几乎不动（1.28x），真正的代价在尾部
（p95 51x）。** 机制上说得通：手侧 `write()` 是**逐帧持锁**（不是整个文件持锁），
所以一次交互调用最多等**一块**写完；大多数时候它插得进去，偶尔要排队 ——
这正是「中位数不变、尾部爆炸」的形状。

**这对 SDK 的含义变了**：

- 提案 §5 的三条出路里，**(c) 不解决**比原来更站得住：p50 无感的卡顿，
  用户多半感觉不到「托盘卡住」；
- 但 **p95 51x 是真实的**，且**本地管道是下界** —— 异机（提案 §7 的场景）上
  一块的写入时间随链路放大，尾部的绝对值会显著更差。**跨机未测**。
- ⚠ **本测量不能推出跨机结论**（transport-lab §8 同款纪律）：loopback 测不出慢链路。
  要决定「加不加第二条通道」，得先在**真跨机**上量一次尾部。

⚠ **成因已分离（2026-09，实测）。** 此前这里写「可能是排队，也可能是对端忙」——
两个都不是。真因是**第三种**，且它有**可证伪的预测**：

`kkrpc_peer.rs::pump_producer` 在**reader 线程**上跑 `for _ in 0..credit { … }`，
**在整批发完之前不会回到 `read_line`**。所以一个入站请求要**等完剩下的整批**。

**判别实验**（[`probes/hands-e2e/hol-credit.mjs`](probes/hands-e2e/hol-credit.mjs)）：
同一 credit 下，在批**中间**探针（还有 credit 未用完、生产者在泵）vs 批**末尾**探针
（credit 用尽、生产者阻塞等下一次 pull）。二者吞吐/块数/往返数完全相同，
**只有「生产者是否正在泵」这一个变量**：

| credit | MID p95 | END p95 | 比值 |
|---|---|---|---|
| 4 | 6.91 ms | 0.34 ms | 20x |
| 8 | 16.34 ms | 0.37 ms | 44x |
| 16 | 28.48 ms | 0.55 ms | 52x |
| 32 | 50.76 ms | 0.32 ms | **159x** |

- **MID 随 credit 线性增长**（4→32 是 8x，p95 涨 7.3x ⇒ **每未完成块 ≈ 1.7 ms**）；
- **END 恒定 ≈ 空闲**（1.1–1.9x）。

**它同时解释了原始的 51x**：kkrpc 自己的消费者**首发 pull=32、之后每次补 16**
（从 `node_modules/kkrpc/dist/streaming.js` 提取）。1.7 ms × 32 ≈ 54 ms ≈ 实测 max 55.7 ms；
1.7 × 16 ≈ 27 ms ≈ 实测 p95 24.3 ms。

⚠ **这不是「排队」也不是「对端忙」。** 载体（raw）只缩短每次迭代，**不消除等待整批**；
第二条通道能绕过，但**远比在块之间让出昂贵**。

> ⚠ **我先前那个 `hol-credit` 版本是无效的，记录在此**：它在**批末尾**探针，
> 而那一刻生产者恰好 credit 用尽、**必然空闲** —— 于是量到「与 credit 无关」（1.2–1.8x）。
> **一个不随变量变化的失败，是仪器的问题**（probe README 的既有纪律，我又犯了一次）。
> 这正是为什么 MID/END 必须**同 credit、同一次运行**内对比。

#### 5.1 ⚠ **载体**与**通道数**是两个独立轴（本节省一度把它们混为一谈）

「要不要用 raw 二进制」和「要不要加第二条通道」是**两个决定**，不是一件事：

| | 一条管道 | 两条管道 |
|---|---|---|
| **base64** | 今天的状态 | 可能 |
| **raw 二进制** | **已验证可行**（[`04-binary-framing.mjs`](probes/hand-io/04-binary-framing.mjs) 用的就是 `stdio: ["pipe","pipe","pipe"]`，单管道，1.8–2.1x） | 可能 |

⇒ **要 raw 不需要第二条通道。** 反过来，尾部问题的修法（限流 / 分片让出 / 优先级）
也**不**取决于载体。

⚠ 我此前在本节把二者写成「第二条通道 vs 廉价化每块成本」的二选一 —— 那**缩小了**可选项。
且「廉价化每块成本」里其实混着两件不同的事：**换载体**（raw）与**减小编码开销**
（例如把 base64 移出应答交互调用的那个线程）。

**因此第 7 节的待决项应按这个轴拆开**：(i) 载体是否换 raw；(ii) 是否加第二条通道；
(iii) 尾部成因究竟是排队还是对端忙。三者可独立决定。

---

## 6. 落地步骤（不含排期主张）

1. `stdio.ts` 换 `StreamingRPCChannel`；**先只换通道，不带 `ctx.hands`**，
   跑既有全部测试证明零回归（`stdio-ready` / `stdin-loss` / `tray-wire` /
   `shortcut-wire` / `stdio-lost-exit`）。
2. `host/src/hands.ts`：`HandsService`，四个方法 + §4 的生命周期绑定 + §3.2 的审计。
3. 登记 `capabilityInventory.ts` + manifest schema 的 `Permissions`；
   `bun run generate:contracts` 重生成镜像。
4. 回归测试（照 `service-attribution.test.ts` 的风格）：
   - 归因：插件调 `ctx.hands.read` → 断言 caller 解析到该插件；
   - **泄漏回归**：起流 → 卸载插件 → 断言流停（对应 §3.3，这是本轮实测出的真缺陷）；
   - **注册不累积**：N 次读完成后不残留注册（对应 §4.1）；
   - 无壳语义：不挂起、不静默。
5. 端到端：扩展 `probes/hands-e2e/run.mjs`，让**宿主侧**（不是脚本）消费一次真流。

---

## 7. 未决（**不替你决定**）

> ⚠ 第 2 项原本把**载体**与**通道数**写成一个取舍（见 §5.1 的更正）。按两个独立轴拆开：

1. **§4.2 的处置 (a) 还是 (b)** —— 决定「宿主自己能否用 `ctx.hands`」。
2. **§5 的取舍 —— 成因已分离（H3 确认），剩下的是选修法**：
   真因 = `pump_producer` 在 reader 线程上跑完整批 credit 才回到 `read_line`。
   **代价曲线**（实测，64 MiB）：
   | credit | 吞吐 | MID p95 |
   |---|---|---|
   | 1 | 87 MiB/s | 0.44 ms（≈空闲；此时 MID 与 END 是同一点，退化为无意义） |
   | 4 | 150 MiB/s | 8.0 ms |
   | 32 | 171 MiB/s | 50.8 ms |
   三个候选修法，按代价从低到高：
   - **(i) 让出**：把每块的发送改成「发一块 → 回读循环一次」。**注意不能只是减小 credit**：
     kkrpc 的消费者**首发 32、每 16 块补一次**，所以「一次 pull 只发一块」会让消费者
     等不到补货阈值 ⇒ **死锁**。真正的让出需要**生产者有自己的线程**（与
     `open_event_stream` 同一形状 —— 那里的注释已经写明「阻塞 reader 线程会连取消帧都收不到」，
     **生产者路径有同一个缺陷，我当时只想到了 watch**）。
   - **(ii) 减小 credit**：最省事，但**直接买掉吞吐**（上表），且治标 —— 它只是把
     「等待整批」变短，没有消除结构。
   - **(iii) 第二条通道**：能绕过，但成本最高（socket + 握手 + 重连保活 + ownership），
     而且**不解决** reader 线程被占这个根因。
   ⇒ **载体（raw）现在明确不是这个问题的解**：它只缩短每次迭代，不消除等待整批。
   第 (i) 项是本节的推荐方向，实现前应补一条回归（MID p95 降到接近 END）。
3. **`ctx.hands` 的授权粒度** —— 已定为**按原语分**（`stat|read|write|watch`）；
   路径前缀粒度**未做**（需双方都认的 matcher，属 #13/M4）。
4. **审计行的路径** —— 记完整路径还是脱敏？路径本身可能含用户名。
5. **归属哪个里程碑** —— 仍未定（提案 §9 第 7 项）。

---

## 8. 主副本对照

| 本文内容 | 主副本 |
|---|---|
| 手侧四原语、错误码、背压、平台陷阱 | [`hands-capability-proposal.md`](hands-capability-proposal.md) + `src-tauri/src/hands.rs` |
| 通道/流帧/宿主消费 | [`probes/probe-host-streaming-channel.ts`](../docs/probes/probe-host-streaming-channel.ts) |
| 生命周期绑定与泄漏 | [`probes/probe-host-stream-lifecycle.ts`](../docs/probes/probe-host-stream-lifecycle.ts)、[`probe-host-stream-leak.ts`](../docs/probes/probe-host-stream-leak.ts)、[`probe-host-effect-economy.ts`](../docs/probes/probe-host-effect-economy.ts) |
| 队头阻塞（真 peer 真管道） | [`probes/hands-e2e/hol.mjs`](../docs/probes/hands-e2e/hol.mjs) |
| 服务写法 / 归因 / inject 纪律 | [`host-sessions-design.md`](host-sessions-design.md) §6.1、[`cordis-runtime-findings.md`](cordis-runtime-findings.md) §0/§1 |
| 审计落点与越权策略 | GitHub `#24`（M2-8）、`#17`（M2-1） |
