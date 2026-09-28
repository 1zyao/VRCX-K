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

### 需要裁定的（②）

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

---

## 6. 建议的落地顺序

**第 0 步（不需要任何裁定，现在就能做）**

1. 补 `shell.deepLink.unregister` 路由（**仅 shell 侧**，宿主类型面可加，插件面不加）。
2. 加「认领已存在的类键会被拒绝」的**真实注册表**语义测试（§9 第 2 条验收）。
3. `forward_deep_link` 的未投递队列（5.1(A) 的机制部分，与「谁消费」无关）。
4. 把「覆盖已有类键无法还原」写进已知边界文档。

**第 1 步（等 §7 的第 1、2 条裁定）**

5. 写 `plugins.deep-link.desktop.schemes`，四个平台一起生效；macOS 真机验收。
6. `NSIS_HOOK_POSTUNINSTALL` 兜底清理（含 MSI 侧的决定）。
7. `ctx.deepLink` Service + 宿主侧消费方 + `#24`/契约登记。

**第 2 步**

8. 脸的「本应用认领了哪些 scheme」+ 撤销入口（(c) 的 UI 部分）。

---

## 7. 待 owner 裁定的四条

1. **scheme 名字**：`vrcxk` 可以吗？（还有 `vrcx-k` / 别的偏好？）
2. **unregister 暴露面**：确认 (c)+内部（插件面永不暴露）？以及**允许 UI 撤销安装器写入的 scheme** 吗（§3 末）？
3. **安装器范围**：`targets="all"` 继续（NSIS 走 HKCU、MSI 走 HKLM，两种语义并存），
   还是收敛到只发 NSIS（统一 HKCU，且清理已有证据）？
4. **URL 丢失语义**：接受 §5.1(A) 的 shell 侧有界队列吗？还是「脑缺席时就丢，并且明说」？

---

## 8. 未核实 / 未验证（诚实边界）

| 项 | 状态 |
|---|---|
| 真机注册表行为（`HKCU\Software\Classes\<scheme>` 的写入/删除/冲突） | **本轮零验证** —— 写这份文档时 `pwsh` 不可用（`0xC0000142`），连 `cargo test` 都跑不了 |
| MSI 侧的深链注册与卸载清理 | 只读了模板（`Root="HKLM"` + perUser 注释），**未实测** |
| macOS 的 `CFBundleURLTypes` 实际投递 | **零验证**（issue 的验收标准已要求真机） |
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
| 若写 `schemes`：macOS 真机验证 | 第 1 步 §6.5 | 装到真 Mac 上双击 `vrcxk://…`，断言 `deepLink.opened` 到达宿主 |
| 卸载路径：卸载后自有前缀的键确实被删 | 第 1 步 §6.6 | NSIS：装 → 卸 → 读注册表断言键消失；**并补一条「命令串被改过时键会残留」的用例**（这是模板判据的真实边界） |

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
