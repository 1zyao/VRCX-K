# `debug-probe` —— 在真 Linux 上跑 `serve_hands` 的独立探针

> **它测什么**：`src-tauri/src/debug_probe.rs` 的 `imp::serve_hands` ——
> 即「监听器接受一个 adb 客户端后，**在真实抽象 unix socket 上**挂载**真实生产
> handler**」的那条路径。
>
> **为什么要单开一个 crate**：`serve_hands` 要 `crate::hands` / `crate::kkrpc_peer` /
> `crate::hands_hello`，而**主 crate 无法交叉编译到 linux-musl**
> （`libdbus-sys` 的 build script 要系统库）。于是 crate 内的测试**只能在 Windows 上跑**，
> 而 Windows **没有抽象 socket**。这个 crate 用 `#[path]` 把生产源码**原样**拉进来，
> 补上那几个模块期望的少量 crate 级管线，让 socket 那条路能在**真正支持它的平台**上被执行。

## 两个探针

| 文件 | 跑在哪 | 测什么 |
|---|---|---|
| `src/main.rs`（Rust crate） | **真 Linux**（无设备） | `serve_hands` 的**传输层与握手**：抽象 socket 收帧、`Peer` 挂生产 handler、hello 的载荷与顺序 |
| `run-android.mjs`（node） | **真 Android 设备**（需 `adb`） | 上面那条链在**应用自己进程、自己 uid、自己目录**下的端到端行为 |

⚠ **两者都不能证明「Android 支持已就绪」** —— 见文末。

## `src/main.rs`：怎么跑

```bash
cd docs/probes/debug-probe
cargo build --target x86_64-unknown-linux-musl
# 产物是静态 musl 二进制，拿到任意 Linux（含 WSL）上直接执行
./target/x86_64-unknown-linux-musl/debug/debug-probe-linux
```

⚠ `.cargo/config.toml` 里把 linker 指成 `rust-lld`，这是**没有系统 C 工具链也能出 musl 二进制**的原因。

## `run-android.mjs`：怎么跑

```bash
adb devices                       # 一台真机/模拟器
# 装一个 **debuggable** 的 APK（CI 的 mobile job 默认就是 `-d` 构建）
# 启动一次应用，让 `.setup()` 跑起来、监听器绑上
node docs/probes/debug-probe/run-android.mjs
```

它做四件事，**每一步的判据都不是"应用说它成功了"**：

1. **发现 socket**：名字里带 pid，而 pid 由系统决定、事先不可知 ⇒ 从设备自己的
   `/proc/net/unix` **读出来**。⚠ 猜名字会失败成"连接错误"，看起来跟"功能坏了"一模一样。
2. **读 token**：从应用的外部目录读，并断言它是 **64 位十六进制**（形状不对就说明
   发布的不是它以为的那个东西）。
3. **`adb forward`**：`tcp:0` 让系统挑端口，再把**返回的端口号解析出来**
   （这行解析已对真实 socket 实测）。
4. **`hands.stat` + `hands.read`**：把随机文件 `adb push` 到**应用自己的外部目录**
   （即应用读得到的地方，而不是我们这个进程碰巧有权限的地方），
   然后断言 **读回来的字节 sha256 与推上去的一致** —— 判据是**字节**，不是应用的自我报告。

失败时它**说可能的成因**：找不到 socket 时，提示「应用没在跑，或者不是 debuggable 因此
**正确地**拒绝了监听」，并指出要确认 APK 来自 `-d` 构建。

## 它断言了什么（都会失败而不是打印）

| 断言 | 为什么它在 |
|---|---|
| 收到 `{"t":"boot"}` | 证明 `.try_clone()` 出的两个句柄 **各自可独立读写** —— 这不是显然的：写半边若能吃掉读半边的字节，握手之后的帧就全错位了 |
| hello 的写法是 **`"p":["hands","hello"]`** 且 `schemaVersion==1`、`node.platform=="linux"` | 证明**生产顺序**（handler 先于 reader、hello 后于 reader）在换传输后仍然成立；并证明负载**真的带着 schema 版本与节点标识**，而不是一个空壳 |
| `hands.stat` 的回复里 `"size":11` | ⭐ **最关键的一条**：11 是本进程刚写下的文件的真实字节数。任何别的数字都说明 handler **没有**跑在真文件系统上 |

## ⚠ 它们**证明不了**什么（读绿之前先读这段）

**`src/main.rs` 对 Android 一无所知。** 不涉及 Android 的权限模型、文件系统布局、
`FLAG_DEBUGGABLE`、SAF、`content://`，也不涉及 app 自己的 uid（那里跑的是 WSL 里的 root）。

**`run-android.mjs` 覆盖了上面这些的一半**，但**仍然证明不了**：

| 没证明的 | 为什么 |
|---|---|
| **SAF `content://` fd 桥** | ⚠ **它在代码库里根本不存在**。实测四个原语（`read`/`write`/`stat`/`watch`）**全部取 `str_arg` 路径**，`content://` 只出现在 `dialog_opts.rs` 的 picker 返回值处理里，`tauri-plugin-fs` **不是本仓依赖**。`hands-capability-proposal.md` §4.3 描述的是**未来需求**，不是"未验证的现有代码" |
| **release 形态** | CI 默认 `-d` 构建 ⇒ 本通道跑在 **debug 形态**上。这是刻意取舍（见 workflow 注释），需要核 release 时把 `android_release_apk` 设 1，那一次本通道**按设计跳过** |
| **iOS** | 判据与载体都是 Android 专有 |

⇒ **实现落地时"跳过"必须是响亮的**：一次 run 里若 e2e 被跳过，日志/摘要必须明说
「本次未验证 Android 行为」，**绝不能安静地绿**。

## 记录：写这两个探针时踩的坑

**① 拿猜的文本匹配协议（同一个错误的两副面孔）。** harness 最初断言 hello 帧里有 `m` 字段
—— **compact 协议没有 `m`**，于是它打印 `method: <none>`，看上去像"功能坏了"。
改成断言字面量 `"hands.hello"` 之后**又错了**：方法在线上是**路径数组**
`"p":["hands","hello"]`，**从来不是点号字符串**。
⇒ 两次都是"拿猜的文本去匹配协议，而不是解析它"。最终版**解析成 JSON 再断言字段**
（与 `docs/probes/hands-e2e/run.mjs` 一直以来的做法一致）。

**② 设计里的一个真错误：Tauri 给不出 adb 读得到的目录。**
设计文档原本说「把 token 写到应用的外部目录」，而实现时发现 **Tauri 没有那个 API** ——
`tauri-2.11.5/src/path/android.rs` 只提供 `app_data_dir` / `app_config_dir` / `app_cache_dir`，
**全部 resolve 到 `/data/data/<pkg>/` 之下**，而实测 `adb shell ls /data/data/` 返回
**`Permission denied`**。⇒ 按原设计写，**harness 永远读不到 token**。
修法是走 JNI 的 `Context.getExternalFilesDir(null)`（→ `/sdcard/Android/data/<pkg>/files`），
那是**唯一**同时满足「adb 可读 + app 免权限可写 + 其他 app 封闭」的位置。
