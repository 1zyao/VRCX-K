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

## 怎么跑

```bash
cd docs/probes/debug-probe
cargo build --target x86_64-unknown-linux-musl
# 产物是静态 musl 二进制，拿到任意 Linux（含 WSL）上直接执行
./target/x86_64-unknown-linux-musl/debug/debug-probe-linux
```

⚠ `.cargo/config.toml` 里把 linker 指成 `rust-lld`，这是**没有系统 C 工具链也能出 musl 二进制**的原因。

## 它断言了什么（都会失败而不是打印）

| 断言 | 为什么它在 |
|---|---|
| 收到 `{"t":"boot"}` | 证明 `.try_clone()` 出的两个句柄 **各自可独立读写** —— 这不是显然的：写半边若能吃掉读半边的字节，握手之后的帧就全错位了 |
| hello 的写法是 **`"p":["hands","hello"]`** 且 `schemaVersion==1`、`node.platform=="linux"` | 证明**生产顺序**（handler 先于 reader、hello 后于 reader）在换传输后仍然成立；并证明负载**真的带着 schema 版本与节点标识**，而不是一个空壳 |
| `hands.stat` 的回复里 `"size":11` | ⭐ **最关键的一条**：11 是本进程刚写下的文件的真实字节数。任何别的数字都说明 handler **没有**跑在真文件系统上 |

## ⚠ 它**证明不了**什么（读绿之前先读这段）

**它对 Android 一无所知。** 不涉及 Android 的权限模型、文件系统布局、`FLAG_DEBUGGABLE`、
SAF、`content://`，也不涉及 app 自己的 uid（这里跑的是 WSL 里的 root）。
**Android 才是目标平台，且在真机跑通之前始终是未验证的。**
不要把这个探针的绿读成「Android 能跑」。

## 记录：写这个探针时踩的两个坑（同类错误的两副面孔）

harness 最初断言 hello 帧里有 `m` 字段 —— **compact 协议没有 `m`**，
于是它打印 `method: <none>`，看上去像"功能坏了"。改成断言字面量 `"hands.hello"`
之后**又错了**：方法在线上是**路径数组** `"p":["hands","hello"]`，
**从来不是点号字符串**。

⇒ 两次都是同一个错误的变体：**拿猜的文本去匹配协议，而不是解析它**。
最终的版本是**解析成 JSON 再断言字段**，这也正是 `docs/probes/hands-e2e/run.mjs`
一直以来的做法。
