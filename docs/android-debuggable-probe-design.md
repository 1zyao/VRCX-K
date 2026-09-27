# 可调试自检监听器（Android 真机 e2e 的「指使应用」通道）· 设计

> **状态：核心已实现（`src-tauri/src/debug_probe.rs`），端到端尚未接通。**
> 本文是「为什么这样设计」的主副本；实现以代码为准。
>
> | 部分 | 状态 |
> |---|---|
> | `policy`（纯判据：是否服务 / token 比较 / socket 命名） | ✅ 已实现，**全平台可测**（Windows 跑 4 条） |
> | `imp` 的 socket 半边（绑定 / 握手 / accept loop / token 发布 / **`run` 入口**） | ✅ 已实现，**在真 Linux 上跑过 19 条**（`cfg(any(linux, android))`） |
> | `imp::run` —— **唯一入口**，把「判据 + 绑定 + 发布 token + 服务」收在一处 | ✅ 已实现。⚠ 判据与启动**放在一起**，调用方无法绕过检查单独启动监听 |
> | `imp::is_debuggable` 的 Android 分支（读 `FLAG_DEBUGGABLE`） | ✅ **已实现且 `cargo check --target aarch64-linux-android` 编译通过**（含一个钉住 wry 回调签名的编译期断言）。⚠ **仍未在设备上运行过** |
> | `jni = "0.21"` 依赖 | ✅ 已加（`[target.'cfg(target_os = "android")'.dependencies]`）。⚠ 它本就在树里（`tao → jni 0.21.1`），但**传递依赖不可命名**；`Cargo.lock` 的改动是**纯新增一行**，无版本变动 |
> | 接进 `.setup()` | ❌ **未做**（见 §8） |
> | 探针侧「连接而非 spawn」的 transport | ❌ **未做** |
>
> **它解决什么**：`docs/hands-capability-proposal.md` §9 缺口 6 —— 手的文件能力
> （`hands.read/write/stat/watch`）在 Android 上**只经过源码阅读**，`cargo check`
> 通过 ≠ 能跑。本文给出一个能在**真机**上以**应用自己的身份**驱动这些能力的通道。

---

## 0. 一句话

**应用在启动时问自己一句「我现在能被调试吗」；只有答案是「能」的时候，它才在
一个抽象 unix socket 上挂一个真正的 kkrpc 端点，让持有 adb 的人连进来驱动
`hands.*`。** 判据是**运行时的环境事实**，不是构建产物标记。

---

## 1. 为什么不是「编个 debug 变体去测试」

先说被否掉的方案，因为它看起来更省事：

| 方案 | 为什么不行 |
|---|---|
| adb 推一个 `hands-e2e` 二进制上去跑 | 它以 **`uid=2000(shell)`** 运行，**不是 app**。它能读的东西比应用多，于是会在「应用本来就读不到」的权限问题上**通过** —— 这是本仓库明确要避免的那类掩盖（用特权身份测非特权代码） |
| `adb root` 后跑 | 同上，且更严重：root 能读任何东西。**root 是搭夹具的工具，不是被测对象可以持有的特权** |
| 编一个 debug 变体专门用于测试 | 被测物与发布物**不是同一个二进制**（`debug_assertions`、优化级别、包名都可能不同），"测过了"就不再等于"发出去的那个能跑" |
| 让 app 监听一个固定 TCP 端口 | 端口对**同机所有应用**可见，比抽象 socket 宽；且固定端口会冲突 |

**owner 的方案**：让「监听」成为**环境的函数**。同一个二进制，在可调试的环境里
自动提供调试入口，在用户机上不提供。**没有"忘了关"这个状态** —— 因为不存在一个
需要记得关的开关。

---

## 2. 判据：为什么 `FLAG_DEBUGGABLE` 是正确的那个谓词

Android 上「外部能不能伸进这个 app」**已经有**一个权威谓词，而且平台自己在用它。
本机实测（同一台设备，两个真实应用）：

```
run-as io.github.qauxv          → run-as: package not debuggable     （伸不进去）
run-as unity.SUPERHOT_...       → uid=10107(u0_a107) ...             （伸得进去）
```

- `run-as` 的准入、`jdwp` 的准入（`adb jdwp` 只列 debuggable 进程）、以及
  **WebView DevTools** 的 abstract socket（`@webview_devtools_remote_<pid>`）
  —— 全都由**同一个 flag** 决定。
- 所以本设计**不创造新边界**：它只是在**门本来就开着**的时候，承认门开着。
  ⚠ 注意「debug 签名」**不等于** debuggable —— 现有 CI 是 release 构建 + 一次性
  debug 证书，那种包**不可调试**，本设计下会**正确地拒绝监听**。

**为什么不用 `ro.debuggable`**：那是**整个系统**可调试（userdebug 构建），不是
**我这个 app** 可调试。用它会让监听器在"系统可调试但本 app 不可调试"时也打开 —— **更宽**。

**读取方式**（已核实可达，无需 `JNI_OnLoad`、无需新依赖）：

```
WebviewWindow::with_webview(|w| …)          tauri 2.11.5 src/webview/webview_window.rs:2371
  → PlatformWebview::jni_handle()           tauri 2.11.5 src/webview/mod.rs:233，cfg(target_os = "android")
    → JniHandle::exec(|env, activity, webview| …)   wry 0.55.1 src/android/mod.rs:479
      → env.call_method(activity, "getApplicationInfo",
                        "()Landroid/content/pm/ApplicationInfo;", &[])
        → env.get_field(&info, "flags", "I") & 0x2 == FLAG_DEBUGGABLE
```

`jni 0.21` **已在依赖树里**（经 `tao → tauri`）；但要 `use jni::…` 必须在
`[target.'cfg(target_os = "android")'.dependencies]` 里**显式声明**（该模式仓库已在用）。

⚠ **实现约束**：`jni_handle()` 挂在 **webview** 上 ⇒ 判据只能在**窗口建好之后**
（`.setup()` 里）求值。不是"进程一起来就监听"。

---

## 3. 载体：为什么是抽象 unix socket + `adb forward`

| 性质 | 说明 |
|---|---|
| **不开 TCP 端口** | 抽象 socket 不是网络端口，不被任何端口扫描看到 |
| **adb 能到达**（已实测） | `adb forward tcp:N localabstract:<name>` 对**别的进程绑的**抽象 socket 有效 —— 判据必须是**可区分**的：连不存在的 socket 立即 EOF，连活着的 `@remote-crash64` 阻塞（= 连上了在对端等数据）。⚠ 我用 `Test-NetConnection` 测过两次，**真实与虚假 socket 都返回 True** —— 那只证明本地监听器存在，**什么都没证明**，是一次无效测量 |
| **生产机上有先例**（已实测） | `/proc/net/unix` 里有 18 个抽象 socket，含 `@INSTANCE_DETECTOR:<pid>`、`@jdwp-control`、`@webview_devtools_remote_*` 家族 |
| **Rust std 支持**（已实测） | `std::os::android::net::SocketAddrExt::from_abstract_name` 为 `aarch64-linux-android` **编译通过**。⚠ **不是** `std::os::linux::…` —— 我第一版写的就是那个，直接编译失败；两者模块路径不同 |

---

## 4. 服务的内容：复用生产的 `Peer`，不另起一套

监听器**必须**跑真代码，否则测的不是生产路径。已核实两者都是泛型的：

```rust
kkrpc_peer::Peer::new(writer: impl Write + Send + 'static) -> Arc<Peer>   // :587
Peer::start_reader<R: Read + Send + 'static>(self: &Arc<Self>, reader: R) // :678
hands::register_hands_handlers(peer: &Arc<Peer>)                          // hands.rs:90
hands_hello::send_hello(peer: &Arc<Peer>)                                 // hands_hello.rs:265
```

⇒ 一条 `UnixStream` 上 `try_clone()` 一读一写，套进同一个 `Peer`，装上**同一批
handler**。这与 `src-tauri/examples/hands-e2e.rs` 的做法**同构**，区别只是传输从
stdin/stdout 换成 unix socket。**驱动侧**（`docs/probes/hands-e2e/run.mjs`）需要加一个
"连接而不是 spawn"的 transport —— 它的 `childTransport` 已抽成函数（`:71`），
改动在**探针侧**，不动生产代码。

---

## 5. 认证：token，以及它为什么必须有

抽象 socket **可能**对同机其他应用可见（SELinux 对 `untrusted_app` 的抽象 socket
规则我**未能在生产设备上实测** —— shell 只能看到自己的 12 个 socket fd，
`/proc/*/fd` 不可遍历，所以"谁拥有那些 socket"我查不到）。

⇒ **不把可达性当安全边界**。每次启动生成 **32 字节随机 token**（`getrandom` 已在树里），
客户端必须**先出示 token**，否则连接被立即关闭。这样"别的 app 能不能连上"就不重要了。

**token 怎么交给合法客户端**（不给其他 app）：
写到**应用自己的外部目录** `/sdcard/Android/data/<pkg>/files/`。
- adb shell **能读**（已实测：我在该目录写过 64 KiB 随机文件并 `adb pull` 回来，
  md5 一致）；
- 其他应用**读不到**（Android 11+ 的分区存储把 `/Android/data/<pkg>` 对别的应用封闭）。

⚠ 不用 logcat 传 token：那要求接收方读日志，而日志是更宽的通道。

---

## 6. 「指使」与「判据」：不靠应用自证

owner 的要求：**生成一个稍大的随机文件放进去，让应用去读，在模拟器外接收并对比原文件。**

⇒ **判据是「取回的字节 == 原始字节」**，而不是"应用说它读成功了"。后者是自证。
具体（已在生产设备上把两段跑通）：

```
① 放进去   adb shell dd if=/dev/urandom of=/sdcard/Android/data/<pkg>/files/rand.bin   ✅ 实测
② 指使应用 hands.read(...) 经 kkrpc over 抽象 socket                                   ← 待实现
③ 取回来   adb pull … && md5sum 对比                                                    ✅ 实测
```

⚠ 注意 ①③ 是**同一目录**：`/sdcard/Android/data/<pkg>/files` 对 adb 可写、
对 app 可读（那是它自己的目录）、对其他 app 封闭 —— 三个性质同时成立，这正是它合适的原因。

---

## 7. ⚠ 这个设计**证明不了**什么（必须与实现同时落地）

**它证明**：`hands.*` 五原语在**真实 Android 内核 + 应用自己的 uid + 应用自己的目录**下能跑，
且 kkrpc over 这条传输 + 真 `Peer` + 真 handler 端到端可用（含 4 MiB 级别的双向字节一致）。

**它证明不了**（且极易被误读成全绿 —— 这是本设计最大的风险）：

1. **SAF `content://` fd 桥**。实测：`hands.read/write/stat/watch` **全部取 `str_arg(&args,0)`
   即路径**，`content://` 只出现在 `dialog_opts.rs:93` 的 picker 返回值处理里；
   `tauri-plugin-fs` **不是本仓库的依赖**。⇒ **所谓"SAF fd 桥"在本代码库里并不存在**
   （`hands-capability-proposal.md` §4.3 描述的是**未来需求**）。本设计**不覆盖**它，
   而它需要真人操作 picker 才会产生 `content://` URI。
2. **`notify` 的 inotify 后端在真实应用语境下的行为**：本设计能让 `hands.watch` 跑起来
   （`notify 8.2.0` 在 `cfg(any(linux, android))` 下 `RecommendedWatcher = INotifyWatcher`，
   非 poll 回退 —— 已核实源码），但**真机上的事件语义**（权限、被观察目录是否在应用可达范围）
   仍需 ② 真跑才算数。
3. **release 形态**：CI 默认用 `-d` 构建（见 `.github/workflows/build.yml` 的
   `android_release_apk` 输入），所以本通道跑在 **debug 形态**的包上。
   ⚠ 这是**刻意的取舍**：需要核 release 形态时把该输入设成 1，那一次本通道会
   **按设计跳过**（应用不可调试 ⇒ 拒绝监听）—— 那是检查在工作，不是失败。

⇒ **实现落地时必须让"跳过"是响亮的**：一次 run 里若 e2e 被跳过，
**日志/摘要必须明说"本次未验证 Android 行为"**，绝不能安静地绿。

---

## 8. 待决 / 未验证清单

| 项 | 状态 |
|---|---|
| `getApplicationInfo().flags & 0x2` 的实际 JNI 调用串 | ⚠ **已编译**（`cargo check --target aarch64-linux-android` 通过，且有一个钉住 wry 回调签名的编译期断言），**但从未在设备上运行过**。「类型正确」是真实证据；「这个 bit 的含义符合预期」**不是** —— 后者只能靠真机 |
| `with_webview` 的 `PlatformWebview` 在 `.setup()` 时是否已可拿到 | ✅ **已从源码核实**：tauri `app.rs:2524` 先按 config 建窗口，`:2530` 才调用户的 `.setup()` ⇒ `.setup()` 里窗口已存在 |
| 抽象 socket 名 | ✅ 已定：`vrcxk-debug-probe:<pid>`（pid 在名字里，见 §3.1） |
| 其他应用能否连上抽象 socket | ⚠ **未实测**（生产设备无法装第二个测试应用；故第 5 节的 token 是**不依赖该答案**的防御） |
| `-d` 产出的 APK 实际文件名 | ⚠ 未实测（需 NDK）；CI 的 `Locate APK` 因此**不猜文件名**，只要求"恰好一个 universal APK" |
| `AndroidManifest` 是否需要额外权限 | 未查（抽象 socket 的 bind 通常不需要权限；须编译后确认） |
| iOS | 本设计**只针对 Android**（判据与载体都是 Android 专有） |
| 接进 `.setup()` | ❌ 未做。⚠ 约束已核实：判据要读 webview 的 JNI handle ⇒ **只能在窗口建好之后**求值，而 `.setup()` 满足该条件 |
| token 发布到真实 app 外部目录 | ❌ 未做（`run` 接受候选目录列表，但还没人传真实路径） |
| 探针侧「连接而非 spawn」的 transport | ❌ 未做。`docs/probes/hands-e2e/run.mjs` 现在 `spawn(BIN)`；要加一个 connect 变体 |
| 服务内容接真 `hands.*` handler | ❌ 未做。`run` 的 `serve` 闭包由调用方提供，**还没人接 `hands::register_hands_handlers` / `hands_hello::send_hello`** |

---

## 9. 实现期发现的两个**真 bug**（记录以免重犯）

两个都是**我自己写的代码**里的，且都是**测试先放过去**的 —— 值得记下来，因为它们
说明"看起来测了"与"真的测了"之间的差距。

### 9.1 ⚠ `BufReader::read_line` 会**吞掉 token 之后的第一帧**

第一版 `handshake` 把 stream 包进 `BufReader` 再 `read_line`。`read_line` 一次读最多
8 KiB，返回 token 行后**把多读的部分连同 reader 一起丢弃**。而 token 行**紧跟 kkrpc 帧**，
于是 RPC 层永远等一批**已经被扔掉的字节**。

⚠ 更值得注意的是**它的注释声称已经避免了这个问题**（"Only ONE line is read…"），
代码做的正好相反。**注释描述意图、代码决定行为，两者可以背离** —— 这正是需要
可证伪测试而非注释的原因。

**修法**：逐字节读（`Token` 64 字节 ⇒ 最多 65 次 `read`，每次调试会话只开一次连接）。
这是唯一**不可能 over-read** 的形状。另加 `MAX_TOKEN_LINE` 防止不发 `\n` 的客户端
让 reader 无限增长。

**为什么第一轮 12 条测试全都抓不到它**：它们都只发 token、不发后续帧 ⇒
缓冲读**永远没有东西可多读**。补的
`the_handshake_does_not_swallow_bytes_that_follow_the_token` 让客户端**一次写入**
「token 行 + 一个帧」，注入验证确认：恢复 `BufReader` ⇒ 该用例 FAILED。

### 9.2 ⚠ accept loop 的一个**naive 形状会让单个坏客户端终结整个会话**

`accept_loop` 里若写成 `handshake(...)?` 或 `listener.accept()?`，那么一个**端口扫描器**
或**一次拼错的 token** 就会让探针**永久消失** —— 恰好发生在有人正要用它的时候。

**修法**：accept/握手/handshake 的错误**一律只记录、不传播**，循环继续。
`a_bad_client_does_not_end_the_session_and_the_next_good_one_is_served` 钉住它：
先一个错 token 的客户端，再一个对的，**admitted 必须 ≥1**（0 = 循环死了）。
注入验证：让 `Rejected` 分支 `return` ⇒ 该用例 FAILED。

⚠ 该用例**第一次写也是错的**：它用 `connect_and_send` 发完 token 后**另开第三条连接**
发 payload，而循环每次只服务一个客户端、然后等下一次 accept ⇒ serve 闭包记录到空行。
**payload 必须走握手刚放行的那条连接**。这是"测试自身有 bug"的又一例 ——
若当时只断言 `admitted >= 1` 而不检查 payload 内容，这个错误会被掩盖。
