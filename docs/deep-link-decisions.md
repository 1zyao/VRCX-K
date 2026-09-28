# `shell.deepLink` 四缺口裁定建议书（issue #41）

> **状态：待裁定。本文不改变任何代码。**
> 依据：issue #41 全文、PR #40（已并入 `rewrite`，merge `7f7edf4d`）、`rewrite` 分支的
> `src-tauri/src/shell_sys.rs` / `src-tauri/src/lib.rs` / `src-tauri/tauri.conf.json` /
> `host/src/stdio.ts` / `host/src/index.ts`、`docs/hands-prior-art.md`（PR #40 引入）、
> 以及 Tauri `dev` 分支的 bundler 模板与官方文档（`tauri-bundler`）。
>
> ⚠ **本轮的核实全部是源码/文档级。** 写这份文档时本机 `pwsh` 执行器不可用
> （`exit 0xC0000142`，即 `STATUS_DLL_INIT_FAILED`），所以**没有任何真机注册表实验**，
> 也**没有在 macOS 上验证过任何一次**。凡属推断或未验证的，写进 §8 而不是含糊过去。

---

## 0. 摘要：四条里两条已经可动，两条卡在裁定

| 缺口 | 现在缺什么 | 建议结论 |
|---|---|---|
| ① 没有 unregister 路由 | **要裁定**：谁能调 | 采用 issue 倾向的 **(c) + 内部**：只暴露给 UI/宿主，插件面**永不**暴露 `unregister` |
| ② `tauri.conf.json` 无 `schemes` | **要裁定**：认领哪个名字 | 只差一个名字。写进 config 后，四个平台的注册都由**打包器/安装器**完成，运行时 `register` 反而变成冗余 |
| ③ 卸载不清理注册表 | 要选：只发 NSIS 还是 NSIS+MSI 都发 | ⚠ **修正 issue 的原判**：Tauri 的 NSIS 模板**已经自带带判据的清理**；我们仍需一条以自有前缀为界的兜底。「覆盖已有类键无法还原」这条**依然无解**，与 ① 无关 |
| ④ `deepLink.opened` 无消费方 | **要裁定**：脑侧谁处理 + URL 早于宿主到达怎么办 | 建议加 `ctx.deepLink`（Service 子类，与 `ctx.tray`/`ctx.shortcut` 同形）+ **shell 侧未投递队列** |

**要 owner 回答的问题集中在 §7**，可以只答那四条。

⚠ 与本文初版相比有一处**证据升级**：**macOS 侧已经实测到端到端** —— 先用探针量机制（§5.4），
再在那台 Mac 上装好工具链、用**临时 scheme** 真机构建并让 URL 一路落到宿主日志（§5.5）。
所以 ② 在 macOS 上不再是「零验证」；仍未定的只有**名字**（§7.1）和 ④ 的消费方（产品侧）。

---

## 1. 现状核实（每条都给了可复查的位置）

| # | issue 的说法 | 核实 | 证据 |
|---|---|---|---|
| ① | 只注册 `register`/`isRegistered`，没有 unregister | ✅ 属实 | `shell_sys.rs` 的 `peer.on("shell.deepLink.register", …)` 与 `"shell.deepLink.isRegistered"` 两处；同文件 `validate_deep_link_scheme` 的文档注释自陈「There is no `shell.deepLink.unregister` route … The permanence is OUR gap, not the plugin's」 |
| ① | 上游 Windows `unregister` 是真的 | ✅ 属实（issue 引的是上游源码，本轮未重读该 crate） | issue 引 `tauri-plugin-deep-link` 2.4.10 `src/lib.rs:380-392`（`LOCAL_MACHINE` + `CURRENT_USER` 两处 `remove_tree`）；`src/lib.rs:145` 的 `UnsupportedPlatform` 是 mobile 的 `imp` |
| ② | 零 `schemes` ⇒ 事件路径永不触发 | ✅ 属实 | `tauri.conf.json` 无 `plugins` 段；`lib.rs` 中 `init()` 与 `.setup()` 的两处注释均已写明 `handle_cli_arguments` 在 config 为 `None` 时第一行 return，`on_open_url` 与 `forward_deep_link` 至今**从未在真实启动中运行过** |
| ② | macOS 完全不可用 | ✅ 属实（原因见 §2） | 同上：macOS 必须由 `Info.plist` 的 `CFBundleURLTypes` 声明 URL type，没有 config 就没有任何东西可被投递 |
| ③ | 无 `.nsi`/`.wxs`/`.nsh`，conf 无 `nsis`/`wix` 段 | ✅ 属实 | `tauri.conf.json` 的 `bundle` 只有 `active`/`targets`/`externalBin`/`icon`；`src-tauri/` 下无任何安装器脚本 |
| ③ | 覆盖已有类键无法还原 | ✅ 属实且**是本文最重要的一条** | 上游 Windows `register` 写 `<scheme>` + `DefaultIcon` + `shell\open\command`；`unregister` 是 `remove_tree`（删整棵），**不是恢复覆盖前的值**。任何清理方案都补不了这一条，只能在**注册前**规避 |
| ④ | `deepLink.opened` 有 fanout 与 `onOpen`，无消费方 | ✅ 属实 | `stdio.ts` 有 `fanout<DeepLinkEvent>("deepLink.opened")`、`expose.deepLink.opened`、`ShellDeepLinkBridge.onOpen`；`host/src/index.ts` 的接线里**没有任何一处**调用 `deepLink.onOpen` |
| ④ | （issue 未提）URL 早于宿主就绪时会**被丢弃** | ⚠ **本轮新增**：`forward_deep_link` 在 `state.peer()` 为 `None` 时只回 `"no-host"`，**没有队列、没有重放** | `lib.rs` 的 `forward_deep_link`：`Some(peer) => notify(...) / None => "no-host"`，两支都不保存 URL |

---

## 2. 缺口②：现在只差一个名字（本轮证据把这一条从「待决」降到「待命名」）

Tauri 的打包链路是现成的，**config 里写一个名字，四个平台同时被覆盖**：

| 环节 | 位置（Tauri `dev` 分支，Apache-2.0/MIT 双许可） | 行为 |
|---|---|---|
| 读取 config | `tauri-cli/src/interface/rust.rs` | 读 `plugins.deep-link.desktop` → `settings.deep_link_protocols` |
| Windows NSIS | `tauri-bundler/…/windows/nsis/installer.nsi` | 安装：写 `Software\Classes\<scheme>`（`URL Protocol`、`URL:<bundle-id> protocol`、`DefaultIcon`、`shell\open\command = "<exe>" "%1"`），root 取 `SHCTX`（perUser ⇒ **HKCU**） |
| Windows MSI | `tauri-bundler/…/windows/msi/main.wxs` | 写 `Software\Classes\<scheme>`，模板里 **`Root="HKLM"`**，旁边注释写着「perUser 安装要自行改成 HKCU」 |
| Linux | `tauri-bundler/…/linux/freedesktop/mod.rs` | `.desktop` 的 `MimeType` 追加 `x-scheme-handler/<scheme>` |
| macOS | `tauri-bundler/…/macos/app.rs` | `Info.plist` 写入 `CFBundleURLTypes` |

**两个直接推论：**

1. **② 不是「要不要做」，而是「叫什么」** —— 名字一定，② 自动闭合（macOS 那一条仍需真机验收）。
2. **运行时 `register` 在 config 声明之后是冗余的，而且是「买到副作用、买不到功能」的那一半**：
   上游插件在 Windows 上只处理**config 里列出的** scheme，动态注册的 scheme「WON'T be processed」
   （`lib.rs` 的注释已引用该上游说明）。⇒ 我们**没有理由**再把它放回插件面（见 ①）。

### 需要裁定的（②）—— ✅ 2026-09-28 已裁定：`vrcxk`

- **名字**：建议 **`vrcxk`**（与 `docs/hands-prior-art.md` §5 既有建议一致）。
  候选：`vrcxk`（推荐，短、与仓库/产品名同源、与已装的 VRCX 不冲突）、`vrcx-k`、`vrcxkapp`。
  **不可用**：`vrcx`（已被 VRCX 占用，见 `docs/hands-prior-art.md` §2.1）、
  `vrchat`（属 VRChat 客户端；VRCX 自己都只做转发、不认领，§2.3）、
  `http`/`https`/`file`/`mailto`/`javascript`/`data`/`about`、`ms-` 前缀、以及
  任何已存在的 Windows 类键名（`exefile`/`lnkfile`/`directory`/`clsid`/…，见 `shell_sys.rs` 的 `RESERVED_REGISTRY_CLASSES`）。
- **`desktop.schemes` 是否只放一个名字**：建议**先只放一个**。数组形态会同时写多条注册表记录，
  多一个名字就多一份「卸载残留 + 类键冲突」的面。
- **安装器范围**：`bundle.targets = "all"` ⇒ 我们**同时**产出 NSIS 与 MSI，而两者的注册表 root 不同
  （NSIS perUser → HKCU；MSI 模板 → HKLM）。三选一，见 §3。

---

## 3. 缺口①：unregister 的暴露面（要裁定）

issue 给了 (a)/(b)/(c) 三条路，倾向 (c)。**建议 (c) + 内部自动撤销，插件面永不暴露**，理由：

| 方案 | 代价 | 判断 |
|---|---|---|
| (a) 暴露给插件 | 插件能改用户机器注册表；且 `register` 刚因这一条被移除，等于原路返回 | ❌ 与 PR #40 的裁定直接冲突 |
| (b) 仅宿主内部撤销 | 安全，但引入「谁注册了什么」的第二份状态，且**今天没有任何自动注册路径**（config 声明后由安装器负责）⇒ 这份状态没有写入者 | ⚠ 暂时无用武之地，但**应作为内部 API 存在** |
| **(c) 暴露给用户/UI** | 要动 `src/`（脸）；需要一份「本应用认领了哪些 scheme」的读取路径 | ✅ **推荐**，与本项目「可见性归用户」一致；也是唯一能解释「为什么我的 `.exe` 变成本应用了」的入口 |

落地上建议三件一起：

1. shell 侧补 `shell.deepLink.unregister(scheme)` 路由（上游 Windows 实现可直接调，**不需要自研**），
   并复用现有的 `validate_deep_link_scheme` 做同一道门（拒绝的输入永远不碰插件）。
2. 宿主侧**内部**可用（`ShellSysAPI` 类型面 + 宿主自己的调用），但**不进 `capability.ts` 的
   curated/raw 镜像**，也就是插件够不到 —— 与 `register` 今天的处置同形。
3. 脸（`src/`）出一个「本应用认领的 scheme」列表 + 撤销按钮。⚠ 这需要一条**只读**能力先落地
   （`isRegistered` 已在，但「我们认领了哪些」目前只存在于用户脑子里）。
4. ⚠ **不要**把 `unregister` 做成卸载以外唯一的安全网：它删的是整棵键，**恢复不了被覆盖的值**（缺口③）。

**要裁定的一条**：`unregister` 是否允许通过 UI **撤销安装器写入的 scheme**（那会让深链在下次安装前失效）？
建议：允许，但撤销后 UI 必须常驻提示「本应用的深链已关闭」，否则用户会把「链接不响应」当 bug 报。

---

## 4. 缺口③：卸载清理 —— 修正 issue 的原判，并补一条兜底

### 4.1 修正：NSIS 侧**已经**有带判据的清理

Tauri 的 NSIS 模板卸载段里有（`installer.nsi`，handlebars 块 `deep_link_protocols`）：

```
; Delete deep links
ReadRegStr $R7 SHCTX "Software\Classes\<scheme>\shell\open\command" ""
${If} $R7 == "<exe 的完整命令串>"
  DeleteRegKey SHCTX "Software\Classes\<scheme>"
${EndIf}
```

⇒ 结论有两面，**两面都要说**：

- ✅ **卸载残留不是必然的**：只要 scheme 是通过 config 声明的，NSIS 卸载会把键删掉，
  而且**判据是「这条键确实指向我们」**——不会去删别的应用认领的同名键。issue ③ 的严重程度被这一条显著降低。
- ⚠ **判据是完整命令串等值**，所以下列情形**仍会残留**：
  1. 应用装到过另一个路径（升级换目录 / 用户改安装目录）后卸载：`$INSTDIR` 变了，等值失败；
  2. 键曾被**运行时** `register` 写过（那时写的是当时进程的可执行文件路径），形态与安装器写的未必相同；
  3. 用户手工改过 `shell\open\command`（安全软件、旧版残留、用户自改）；
  4. scheme 名换过（旧名字没人再声明，也就没人再清理）。
- ⚠ **MSI 侧未核实**：模板默认 `Root="HKLM"`，删除依赖 MSI 组件的卸载语义。本轮**没有实机验证**。
  若我们继续同时产出 MSI，这一格必须在真机上补测，否则「卸载清理」这件事等于只有 NSIS 有证据。

⇒ **建议**：仍然补一条 `NSIS_HOOK_POSTUNINSTALL`（config 键 `bundle.windows.nsis.installerHooks`）
做**自有前缀为界**的兜底清理 —— 它只删我们声明过的名字，不碰任何别的类键。
不要在 hook 里做「扫描并猜测哪些键是我们的」。

### 4.2 无解的那一条（必须写进文档，而不是绕过）

**覆盖已有类键无法还原。** 这不是 ① 能补的（`unregister` 是删整棵），也不是 ③ 能补的
（卸载清理是删整棵）。唯一有效的手段是**注册前规避**：

- **allowlist（不是黑名单）**：只允许我们**在 config 里声明过**的名字通过运行时注册路径。
  这一条今天已经半成品：`validate_deep_link_scheme` 是黑名单 + 语法门，其自身的注释就写着
  「The defensible long-term fix is an ALLOWLIST, not a longer blacklist」。
- **可选加固**（代价：多一份状态）：注册前读一次目标键，若已存在则**拒绝**（而不是覆盖），
  把冲突原样报给调用方。这比「备份再恢复」诚实得多 —— 恢复要处理值类型、子键、权限，
  而我们真正需要的能力只是「别覆盖」。
- **文档义务**：把「已存在的类键一旦被覆盖就回不去」写进用户可见的已知边界。

---

## 5. 缺口④：消费方 + 一个 issue 没写的时序陷阱

### 5.1 时序陷阱（今天必然踩）

`forward_deep_link` 只在 `state.peer()` 有值时才投递，`None` 时记 `"no-host"` 就结束，**URL 被丢掉**。
而两条最常见的路径恰好都可能在 peer 未就绪时到达：

- **冷启动**：用户双击一个 `vrcxk://…` 链接 → 壳起进程 → 壳拉起宿主 → 宿主 `ready` 需要时间，
  而 OS 的 URL 事件可能先到；
- **宿主重启**（崩溃/升级/`host_reload`）：窗口期内的 URL 一律丢失。

⇒ 「④ 的消费方」不只是「谁来处理」，而是「**怎么保证 URL 不丢**」。两个方向：

- **(A) shell 侧排队重放**（推荐）：`forward_deep_link` 在 `no-host` 分支把 URL 压入有界队列，
  在 peer 就绪（`host-ready` / `promote_ready`）后按序重放；加一条上限与「丢弃即日志」。
  优点：宿主侧完全不必知道「我启动晚了」这件事，语义与 `tray.action` 的「未投递就报出来」一致。
- **(B) 宿主侧拉取**：shell 只记「有未投递的 URL」，宿主就绪后主动 `shell.deepLink.pending()`。
  优点：宿主掌握投递时机；代价是多一条路由 + shell 侧仍要存。

两者都需要 shell 侧存储，差别只在**谁决定重放时机**。建议 (A)，与现有 `TrayService`
「先 provide 后 attachShell，未 attach 时记住请求」的形状同形。

### 5.2 消费方形态

建议照 `ctx.tray` / `ctx.shortcut` 的既成形状做 `ctx.deepLink`：

- **`Service` 子类**（不是 `provide` 普通对象）——否则调用者归因丢失（`docs/cordis-runtime-findings.md` 的实测结论）；
- **方法必须是类方法**（箭头函数属性会静默丢归因）；
- **先 provide、后 attachShell**：未注入的插件也能读，但未提供服务的插件会卡在 `PENDING`；
- 若将来暴露给插件，**必须同时**登记 `capabilityInventory` / manifest schema，
  并补「`maxItems == enum.length`」那类契约测试（PR #40 第一轮的教训：schema 漂移会让声明校验静默失效）；
- 同时补 `#24` 越权检测接线（`host/src/index.ts` 的 `lookup` 列表 + `record()` + `useManifests`）——
  这份列表已经因为漏项错过两次，新服务一定要一起改。

**URL 语义**先不定死，但 `docs/hands-prior-art.md` §2.2 提供了 VRCX 的既成形状（MIT，可安全参照行为）：
`vrcx://user/usr_x`、`vrcx://world/wrld_x` 这类**路径即命令**的写法（VRCX 侧 `LaunchCommand` 存的就是
`user/usr_1` 这样的串）。建议我们也用「`<scheme>://<verb>/<id>`」，并把**解析放在脑侧**
（壳只证明 URL 到了 —— 这条分工 `lib.rs` 的注释已经写明）。

### 5.3 要裁定的一条

**能不能在脑（宿主）缺席时也不丢 URL？** 即是否接受 5.1(A) 的队列（带一个上限）。
如果选择「丢掉就算了」，请明确写下来 —— 因为用户双击链接没反应时，这就是唯一的解释。

### 5.4 macOS 侧：机制已**先**验证（实测，见探针）

issue 的验收标准要求「若写 `schemes`：macOS 上一条真机验证」，而 scheme 名字还没定、那台 Mac 上也
还没有 Rust/bun。为了不让这一段在裁定前完全空白，本轮用一个**不依赖 Tauri、不依赖 scheme 名**的
探针把 macOS 的机制先量了一遍：`docs/probes/mac-deeplink/`（`run.sh` + `FINDINGS.md`），
在 macOS 26.6.2 arm64 上**经 SSH 驱动**、全部断言通过。

三条结论（都对将来的验收方式有直接影响）：

1. **`CFBundleURLTypes` 就够，投递走 Apple Event，不是 argv。** URL 到达应用是 `kAEGetURL`，
   由 `NSApplication` 转交 **delegate 的 `application:openURLs:`** —— 这正是 Tauri/WRY 映射成
   `RunEvent::Opened` 的那条路径（探针把「只装 delegate」与「额外自己装 AE handler」分成两模式分别量，
   以免测到一条生产不走的路）。一个纯 C 处理器在同样条件下只会记 `argc=1`。
2. **⚠ `open` 的退出码不能当判据**：实测两个方向都有 —— 返回 0 而 URL 根本没到应用（纯 C 处理器），
   以及 claim 存在但返回非 0。⇒ macOS 验收必须**断言应用侧**（宿主是否收到 `deepLink.opened`），
   这与本仓库「skip 不算 pass」是同一条纪律的另一种外衣。
3. **⚠ bundle 放在 `/tmp` 下会「登记成功但不被投递」**：`lsregister` 能查到 claim，`open` 却报
   `kLSApplicationNotFoundErr (-10814)`。这是**给验证仪器自己挖的坑**（安装到 `/Applications` 的真实
   应用不受影响），手搓 bundle 或 CI 临时目录都会踩。

**仍未验证的**：真实 Tauri 应用的端到端（含 bundler 生成 `Info.plist` 的那一半）——那台 Mac
**没有 rustup 也没有 bun**（已实测），所以「build + install + 双击/`open` + 断言宿主收到」仍是第 1 步的事。
探针本身留着：它能区分「macOS 不投递」与「我们的应用没收到/没转发」。

### 5.5 macOS 侧：**真实 Tauri 应用**也已经在真机上跑通了（同日补齐）

§5.4 写完后又把工具链装上（rustup 1.98.1 + bun 1.4.2）、并在一个**临时工作树**里用
**临时 scheme**（`vrcxkscratch`）+ 一个**临时日志消费方**把真实应用构建、安装、跑通：

| 断言 | 结果 |
|---|---|
| bundler 把 `plugins.deep-link.desktop.schemes` 变成 `.app` 的 `CFBundleURLTypes` | ✅ `CFBundleURLSchemes = [vrcxkscratch]`（此前**只有源码阅读**） |
| LaunchServices 把 scheme 判给我们的 bundle | ✅ `claimed schemes: vrcxkscratch:` |
| `open "vrcxkscratch://hello?a=1"`（从 SSH 会话）→ 壳 → kkrpc/stdio → 宿主 | ✅ 宿主日志：`[probe] deepLink.opened received urls=["vrcxkscratch://hello?a=1"]` |

⇒ **② 在 macOS 上从「机制」到「我们的链路」全部有实测证据**，含 62.9 MB 的 `host` sidecar 随包
（release 构建 4m53s，8 核/16G）。仪器与原始输出：`docs/probes/mac-deeplink/run-real-app.sh` +
`FINDINGS.md` §5。

⚠ **两条必须写在结论旁边的限定**：

1. 用的是**临时 scheme 名**（真名仍待裁定），所以这一条证明的是**链路**，不是**名字**。
   —— 真名 `vrcxk` 的验收后来补做了，见 `docs/probes/mac-deeplink/run-real-name.sh` 与 FINDINGS §6：
   内置 `.app` 带 `CFBundleURLTypes=vrcxk`、LaunchServices 认领、**冷启动与热启动都到达宿主**。
   ⚠ 真名验收还**暴露并修掉了一个真实缺陷**：宿主侧「expose 已注册、消费方尚未订阅」的窗口会把通知
   丢进空的 handler 集合（`fanout` 现在为 deepLink 保留最新一条，交给第一个订阅者）。这一条**不是**
   壳侧队列能覆盖的 —— 当时 `peer=true`，走的是「已投递」分支。
2. 「宿主收到」是靠**临时插进 `host/src/index.ts` 的一行日志**观测到的 —— 因为产品今天**没有**
   `deepLink` 消费方（那正是缺口④）。⇒ 这条验证**恰好演示了④为什么必须落地**：没有消费方，
   URL 到达与否在产品里根本不可观测。
3. 未测：第二次启动/single-instance 转发、`LSUIElement` 的影响。

---

## 6. 建议的落地顺序

**第 0 步（不需要任何裁定，现在就能做）**

1. 补 `shell.deepLink.unregister` 路由（**仅 shell 侧**，宿主类型面可加，插件面不加）。
2. 加「认领已存在的类键会被拒绝」的**真实注册表**语义测试（§9 第 2 条验收）。
3. `forward_deep_link` 的未投递队列（5.1(A) 的机制部分，与「谁消费」无关）。
   ⚠ **本项等 §7 第 4 条**：若裁定的结果是「脑缺席就丢」，本项改成**把丢弃写进文档与日志**，不做队列。
4. 把「覆盖已有类键无法还原」写进已知边界文档。
5. 保留并复跑 macOS 机制探针 `docs/probes/mac-deeplink/run.sh`（§5.4）——它在真实应用就绪前
   是唯一能把「macOS 不投递」与「我们没收/没转发」分开的仪器。

**第 1 步（§7 的 1/2/3 已裁定 ⇒ 现在可做；仅第 8 项依赖 #4 的消费方设计）**

6. 写 `plugins.deep-link.desktop.schemes`，四个平台一起生效；macOS 真机验收（机制已由 §5.4 先验证，
   剩下的是 Tauri 那一半 + bundler 的 `Info.plist`）。
7. `NSIS_HOOK_POSTUNINSTALL` 兜底清理（含 MSI 侧的决定）。
8. `ctx.deepLink` Service + 宿主侧消费方 + `#24`/契约登记。

**第 2 步**

9. 脸的「本应用认领了哪些 scheme」+ 撤销入口（(c) 的 UI 部分）。

### 6.1 落地现状（2026-09-28，三个 PR）

| PR | 内容 | 覆盖裁定 | 状态 |
|---|---|---|---|
| [#44](https://github.com/VRChatCN-Kipfel/VRCX-K/pull/44) | 本文档 + `docs/probes/mac-deeplink/`（机制探针、真实应用探针、**真名验收探针**） | 裁定记录 | CI 绿 |
| [#45](https://github.com/VRChatCN-Kipfel/VRCX-K/pull/45) | 壳：声明 `vrcxk`、归属探测 + 声明白名单门、`unregister` 路由、未投递队列、**NSIS 卸载清理**（第 0 步 1–4 与第 1 步 6–7 的 NSIS 侧） | ①②③(NSIS 侧)④(壳侧) | CI 绿 |
| [#46](https://github.com/VRChatCN-Kipfel/VRCX-K/pull/46) | 宿主：`ctx.deepLink` 消费方、`HostWsAPI.deepLink` 注销入口、契约登记、**通知保留槽**（第 1 步 8 + 缺口④） | ②(宿主/脸侧)④(宿主侧) | CI 绿 |

⚠ **两条与原计划不同的实测结论**（详见 §5.5 与 `docs/probes/mac-deeplink/FINDINGS.md` §6）：

1. **macOS 的冷启动 URL 是「晚到」的** —— 它在 `ready` **之后**才到壳（实测两次）。所以壳侧
   未投递队列**不覆盖 macOS 冷启动**；覆盖它的是**宿主侧的通知保留槽**（`fanout(..., {retainUntilSubscribed})`），
   因为真正丢 URL 的窗口是「宿主的 expose 已注册、`ctx.deepLink` 还没订阅」。
   队列仍然覆盖**peer 确实不存在**的窗口（宿主重启，以及在进程启动时就投递 URL 的平台）。
2. **加一个插件可见的服务必须同时登记**（`capabilityInventory` 的 `HOST_SERVICES`/`REQUESTABLE_CAPABILITIES`
   + manifest schema 的 `permissions.deepLink` + 重生成镜像 + `#24` 三档测试），否则
   `capability-surfaces.test.ts` 与 `check:contracts` 会红——这正是 PR #40 的教训被复用的地方。

**仍未做的**（诚实列出）：

- **MSI/WiX 侧的注册与卸载清理**只做了源码阅读（模板写 `Root="HKLM"`），**未实测**（§7.2）。
  ⚠ 本机连 MSI **都编不出来**：WiX 的 `light.exe` 死在 .NET 的 `TempFileCollection.CreateTempDirectoryWithAce`
  （`access denied` / `1314 缺少所需特权`），与下面那条同源。
- **安装器自己写文件与注册表 / NSIS 卸载钩子的运行时行为**：✅ **已在 CI 真机上验证**
  （`installer-acceptance` workflow，首个全绿 run **36462916457**：装完自有键/命令串/`URL Protocol`/
  `Uninstall` 条目全对，卸完**自有键确实被删**、预置的「别人的 `vrcx` 类键」逐字节未变）。
  ⚠ 之所以不在本机做：开发机上**新编译的未签名安装器**被**按可执行文件**拦截 —— 同一上下文里
  `cmd`（微软签名）能建目录、能往 C 盘写同一个 6.9 MB 的 exe、能写 `HKCU\Software\Classes` 键，
  而安装器三件事全做不到（退出码 0 却什么都没写）。⚠ **不是我们的打包**：
  同一套 makensis 编的 **20 行最小安装器**症状完全相同；同一个安装器**写 D 盘却完整成功**；这台机器上
  **另一个未签名的 NSIS 安装器**（.NET/CefSharp，148.7 MiB）装成功过。机器上挂着两个内核过滤驱动
  （火绒 `sysdiag`、`EasyAntiCheat_EOSSys`），符合"陌生程序改系统盘/文件关联"的拦截特征；且**火绒自己的
  `hips.db` 是 0 行**、UI 日志不记录这一类 ⇒「日志里没有」不等于「没拦」。⇒ 这条判据需要在**没有该拦截的
  机器**上做：**CI（`windows-latest`）或另一台 Windows**。详见 FINDINGS §7.1。
- **Windows 的功能链路本身已验证**（FINDINGS §7）：按渲染脚本等价安装后，由人手动打开链接，
  冷启动与热启动都到达宿主，且 VRCX 自己的键 5 次逐字节比对未变。
- `register → unregister` 的**往返**没有自动化测试：两个调用都在 `AppHandle` 之后，单测构造不出来
  （与 `ctx.autostart` 同样的限制）；被覆盖的是**判据与探测**（含真实注册表用例）与「外来键绝不被碰」。


---

## 7. 裁定

> 2026-09-28 owner 裁定三条（1/2/3），第四条要求先重新解释 —— 解释在下节末尾，选项在 §5.1。

### 7.1 已裁定

| # | 问题 | 裁定 | 落地含义 |
|---|---|---|---|
| 1 | scheme 名字 | **遵循建议 ⇒ `vrcxk`** | 写进 `plugins.deep-link.desktop.schemes`（§2）。⚠ 同时把运行时注册路径收窄为「只允许 config 里声明过的名字」（§4.2 的 allowlist），而不是再叠一层黑名单 |
| 2 | `unregister` 暴露面 | **选择性暴露** | ⚠ **本条的语义由本文定义一次，若与本意不符请当场纠正**：① **不给插件面**（`capability.ts` 的 curated/raw 两条镜像继续不放 `unregister`）；② 走**宿主 + UI** 路径；③ **只能注销 config 里声明过的名字** —— 同一个 allowlist 同时管注册与注销，因此它**永远不能**用来删别人的类键。⇒ 与 §3 的 **(c)+内部** 同向，只是把「选择性」明确成「按声明白名单限定范围」 |
| 3 | 安装器范围 | **双持（继续 `targets="all"`）** | NSIS 与 MSI 都发。⚠ 代价已记录：两者注册表 root 不同（NSIS perUser ⇒ **HKCU**；MSI 模板 ⇒ **HKLM**），语义不一致；且 **MSI 侧的卸载清理由 MSI 组件语义承担，本轮未实测**（§8） |
| 4 | URL 丢失语义 | **待选择** | 解释见 §5.1 与下节末尾；它决定「**冷启动双击链接是否会被静默丢弃**」 |

### 7.2 由前三条**派生**的待办（不改变裁定本身）

- **#3 的 MSI 侧**：`targets="all"` 意味着 MSI 也会注册 `Software\Classes\vrcxk`，但模板默认
  **`Root="HKLM"`**（旁边注释写着 perUser 要自己改成 HKCU）。两条路选一：
  (a) 接受「NSIS 装 perUser 写 HKCU、MSI 装 perMachine 写 HKLM」两套语义；
  (b) 给 MSI 加一个 WiX fragment 把 root 固定成 HKCU（WiX 的
  `Action="createAndRemoveOnUninstall"` 可声明式地在卸载时删）。
  ⚠ 无论哪条，**MSI 的卸载清理都必须真机验证** —— 否则「卸载残留」这件事只有 NSIS 有证据。
- **#2 的 UI 那一半**：「允许 UI 撤销**安装器**写入的 scheme」仍需一个答复（撤销后深链在下次安装前
  失效 ⇒ UI 必须常驻提示）。默认按 §3 末的建议：**允许，但必须提示**。


1. **scheme 名字**：**✅ 已裁定 `vrcxk`**（2026-09-28，遵循建议）。
2. **unregister 暴露面**：**✅ 已裁定「选择性暴露」**，本文把它落成三条硬约束（见 §7.1 的说明）。
3. **安装器范围**：**✅ 已裁定「双持」** —— 继续 `targets="all"`（NSIS + MSI 都发）；由此派生的 MSI 侧 root/清理问题见 §7.2。
4. **URL 丢失语义**：**待 owner 选择** —— owner 要求先重新解释（解释见下），三个选项见 §5.1。

---

## 8. 未核实 / 未验证（诚实边界）

| 项 | 状态 |
|---|---|
| 真机注册表行为（`HKCU\Software\Classes\<scheme>` 的写入/删除/冲突） | **本轮零验证** —— 写这份文档时 `pwsh` 不可用（`0xC0000142`），连 `cargo test` 都跑不了 |
| MSI 侧的深链注册与卸载清理 | 只读了模板（`Root="HKLM"` + perUser 注释），**未实测** |
| macOS 的 `CFBundleURLTypes` 实际投递 | ✅ **已实测**（2026-09-28，macOS 26.6.2 arm64，经 SSH）：`CFBundleURLTypes` → `kAEGetURL` Apple Event → **delegate `application:openURLs:`**（即 Tauri 的 `RunEvent::Opened` 路径）。探针与原始输出见 [`docs/probes/mac-deeplink/`](probes/mac-deeplink/FINDINGS.md) |
| macOS 上**真实 Tauri 应用**的端到端（含 bundler 生成 `Info.plist`） | ✅ **已实测**（§5.5）：临时 scheme 构建出的 `.app` 确实带 `CFBundleURLTypes`，LaunchServices 认领，且 `open "…://…"` 从 SSH 会话投到**宿主日志**。⚠ 限定：用的是**临时 scheme 名**，且「宿主收到」靠**临时插入的一行日志**观测（产品暂无④的消费方）；未测 single-instance 转发与 `LSUIElement` |
| 上游 `tauri-plugin-deep-link` 2.4.10 的 `unregister` 实现 | 本轮**未重读源码**，采信 issue 与 `shell_sys.rs` 注释的引用 |
| Tauri 模板的行为（`SHCTX` 取值、判据等值比较） | 读的是 `dev` 分支的模板**文本**，与将来我们锁定的 Tauri 版本可能有漂移；落地时应改引 crate 内实际模板 |
| 已装的 VRCX 与本应用的键冲突（若名字选错） | **未测**：注册表是后写者胜，无法靠阅读判断 |
| 「URL 早于宿主到达」的实测频率 | 只有代码路径可读（`no-host` 分支），**没有实测计数** |

---

## 9. issue #41 验收标准 → 落地映射

| issue 的验收标准 | 对应本建议的哪一步 | 怎么测 |
|---|---|---|
| ①②③④ 全有明确结论后才重新暴露 `register` | §7 四条裁定 + 本文档本身 | 本文档即「写下来」的载体；裁定结论回填到本节 |
| 一条测试钉住「认领已存在的类键会被拒绝」，且**在真实注册表语义下成立** | 第 0 步 §6.2 | 单元层已有一半（`validate_deep_link_scheme` 的 11 条用例）；缺的是**真机**：先人工建 `HKCU\Software\Classes\vrcxktest`，再断言注册被拒且原值未变 |
| 若实现 `unregister`：注册 → 注销后键回到注册前状态（含被覆盖的既有键） | 第 0 步 §6.1 | 「自有新键」可断言全等；「被覆盖的既有键」**结构上无法恢复** ⇒ 按本文 §4.2 写进文档明说，并把测试限定为前者 |
| 若写 `schemes`：macOS 真机验证 | 已**完成**（§5.4 机制 → §5.5 真实应用 → **`docs/probes/mac-deeplink/run-real-name.sh` 用真名 `vrcxk` 的冷启动 + 热启动验收**） | 机制与 bundler 两半都已实测；真名验收在生产代码上全绿：内置 `.app` 的 `CFBundleURLTypes` 带 `vrcxk`、LaunchServices 认领、**冷启动**（应用未运行 → URL 拉起它）与热启动都落到宿主日志。⚠ 判据**不能**用 `open` 的退出码（实测会给假绿），也**不能**把 bundle 建在 `/tmp`（会假红），也**不能**只送壳分支的树（会得到一个看起来一模一样的假失败 —— FINDINGS §6.3） |
| **Windows 真机**：装 → 双击/打开链接 → 到达宿主（冷启动 + 热启动） | 已**完成**（FINDINGS §7） | 按渲染出的 NSIS 脚本**等价安装**（文件布局 + 脚本原文的注册表写入），由**人手动**用 URL 启动。宿主日志实测：`ready` 之后 **6 ms** 出现 `deepLink.opened vrcxk://user/usr_1`（冷启动），随后 `wrld_2`（热启动）。⚠ 这条同时验证了 **`get_current()` 冷启动修复** —— 修复前 Windows 上这行**从不出现**（macOS 走 `RunEvent::Opened` 所以掩盖了它）。同时 5 次逐字节比对确认 **VRCX 自己的 `vrcx` 类键始终未变** |
| 卸载路径：卸载后自有前缀的键确实被删 | 已**完成**（CI 真机：`.github/workflows/installer-acceptance.yml` + `scripts/installer-acceptance.ps1`） | `windows-latest` 上构建 NSIS → 静默装（**注册表与文件全部由安装器自己写**）→ 断言自有类键/命令串指向安装出来的 exe/`URL Protocol`/`Uninstall` 条目 → 静默卸 → **断言自有类键确实被删**、`Uninstall` 条目消失；全程用 `reg export` 逐字节比对**预置的「别人的 `vrcx` 类键」**作为对照。首个全绿 run **36462916457**。⚠ 脚本刻意堵了一个假绿：安装阶段没写成键时，「卸载后键消失」按**无法验证**记 FAIL 而非空过成 PASS。⚠ 仍未做：**MSI/WiX 侧**（本机连 `light.exe` 都跑不起来，见 §6.1），以及「命令串被改过时键会残留」这条模板判据边界的用例 |

---

## 附：可直接贴到 issue #41 的评论草稿

> 已把四条缺口的取舍整理成一份裁定建议：`docs/deep-link-decisions.md`（本 PR 引入）。
> 三点结论先说：
>
> 1. **② 已经从「要不要做」降到「叫什么」**：Tauri 的打包链路会从 `plugins.deep-link.desktop.schemes`
>    自动生成 Windows NSIS 注册表写入、MSI 注册表写入、Linux `x-scheme-handler`、macOS `CFBundleURLTypes`。
>    名字一定，② 自动闭合（macOS 仍需真机验收）。**运行时 `register` 因此变成冗余**，没有理由放回插件面。
> 2. **③ 的严重程度要下调**：NSIS 模板卸载时**已经**会删 deep-link 键，且判据是
>    「`shell\open\command` 等于我们自己的命令串」——不会误删别的应用认领的同名键。
>    仍会残留的四种情形（改过安装目录 / 曾被运行时注册 / 命令串被改 / 换过名字）写在 §4.1，
>    建议补 `NSIS_HOOK_POSTUNINSTALL` 以自有前缀为界兜底。**「覆盖已有类键无法还原」依然无解**，
>    只能靠 allowlist + 注册前探测，与 unregister 无关。
> 3. **④ 还漏了一个陷阱**：`forward_deep_link` 在 peer 未就绪时只记 `no-host`，**URL 直接丢弃**，
>    而冷启动与宿主重启窗口恰好都在这个分支上。所以 ④ 不只是「谁消费」，还有「怎么不丢」。
>
> 需要裁定四条（§7）：scheme 名字 / unregister 暴露面 / 安装器是否继续同时发 NSIS+MSI / URL 丢失语义。
> 其中第 1、2 条不定，第 1 步无法开工；**第 0 步那四项（unregister 路由、真实注册表冲突测试、
> 未投递队列、已知边界文档）不依赖任何裁定，可以并行推进。**

> **补充（同日，macOS 侧已实测）**：issue 的验收标准要求「若写 `schemes`：macOS 上一条真机验证」，
> 我在等裁定的同时用一个**不依赖 Tauri、不依赖 scheme 名**的探针把 macOS 的机制先量了：
> `docs/probes/mac-deeplink/`（macOS 26.6.2 arm64，**经 SSH 驱动**，全部断言通过）。三条结论：
> ① `CFBundleURLTypes` → URL 以 **Apple Event `kAEGetURL`** 到达，并由 `NSApplication` 转交
> **delegate 的 `application:openURLs:`** —— 正是 Tauri 映射成 `RunEvent::Opened` 的那条路
> （argv 从来不是载体）；② ⚠ **`open` 的退出码不能当判据**（实测既能「返回 0 而没投递」，
> 也能「claim 在却返回非 0」）；③ ⚠ **bundle 建在 `/tmp` 会「登记成功但永不投递」**
> （`kLSApplicationNotFoundErr -10814`）—— 手搓探针/CI 会踩，安装到 `/Applications` 的真实应用不会。
> 仍未验证的是**真实 Tauri 应用**那一半：那台 Mac **没有 rustup 也没有 bun**（已实测），
> 所以这一条仍留在第 1 步。
