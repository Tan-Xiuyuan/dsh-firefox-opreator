# dsh-firefox-operator

让 **DeepSeek Harness（dsh 0.2.1-rc.5）** 直接操控 **Firefox 153 ESR** 的宿主插件。

本实现已经过真实环境验证：dsh 的 `firefox_*` 工具可以启动 Firefox、打开网页、读取标题/正文/DOM、点击、填表提交、执行页面 JavaScript、等待元素，并把 Firefox/BiDi 错误作为工具错误返回给 dsh；失败后浏览器与 dsh 都不会崩溃。

---

## 0. 先确认接口：dsh 确实提供插件接口

结论：**dsh 0.2.1-rc.5 有正式的 Host 插件接口，因此本实现是 dsh 插件，而不是“退而求其次”的 Firefox 扩展。**

依据（均来自本机安装的 0.2.1-rc.5，而不是假设）：

| 事实 | 可核对位置 |
| --- | --- |
| 插件以 bundle 形式安装；`package.json` 的 `dsh.bundle.patch` 指向 Cordis patch | `D:\npm-global\node_modules\@deepseek-ai\dsh\package.json`；本仓库 `package.json` |
| Host 插件导出 `apply(ctx, config)`，通过 `ctx.tools.register(toolDefinition)` 注册 agent 工具 | 安装包 `@deepseek-ai/dsh-tools` 的 `ToolRuntime.register` 类型/实现 |
| 真实第三方插件也按此方式注册工具（`inject = ['tools']`） | `C:\Users\Administrator\.dsh\profiles\web\node_modules\@linxin666\dsh-client-ui-browser-view\lib\index.js` 的 `apply(ctx)` 与 `ctx.tools.register` |
| 插件安装由 dsh 的 `plugin_manager` / `dsh plugin` 完成；本插件安装结果为 `application: applied` | 本会话实测，见 `docs/VERIFICATION.md` |

Firefox 端也有现成的正式接口：**Firefox 内置 WebDriver BiDi remote agent**。因此不需要编写 Firefox 扩展、不需要签名 XPI、不需要 native messaging host：

```text
dsh agent
  └─ firefox_* tools (dsh Host 插件，本仓库)
       └─ FirefoxOperator（单 WebSocket、串行命令队列、生命周期/错误处理）
            └─ WebSocket JSON (WebDriver BiDi)
                 └─ Firefox 153 ESR remote agent  ws://127.0.0.1:<port>/session
```

> 本机确认 Firefox 为 `Mozilla Firefox 153.5.1esr`。Firefox 的 `/json/version` HTTP 路由在该版本上会建立 TCP 连接却不返回响应，因此本实现**不依赖它**：启动后只等待 TCP 端口，然后直接连接 `/session` 完成 `session.new`。

---

## 1. 目录结构与关键文件

```text
dsh-firefox-operator/
├─ package.json              # dsh bundle 清单、导出、scripts、无运行时依赖
├─ cordis.patch.yml          # dsh 加载入口：插入 dsh-firefox-operator 插件行
├─ index.js                  # Host 插件入口：inject=['tools']、注册 9 个工具、卸载清理
├─ lib/
│  ├─ firefox.js             # FirefoxOperator：启动/连接、标签页、导航、读页、点击、
│  │                         # 填表、eval、等待、关闭、profiles、超时、恢复
│  ├─ bidi-client.js         # WebDriver BiDi WebSocket 客户端：
│  │                         # session.new / session.end、请求 ID、错误、超时、断线
│  ├─ tools.js               # 9 个工具的参数/输出 JSON Schema、描述、输出渲染
│  └─ errors.js              # 稳定错误码、WebDriver 错误到可操作提示的映射
├─ locale/en.json            # 插件管理器显示名/描述（英文）
├─ locale/zh.json            # 插件管理器显示名/描述（中文）
├─ icon.svg                  # 插件图标
├─ scripts/
│  ├─ live-check.mjs         # 真实 Firefox 端到端验证（启动/连接 + 全能力）
│  └─ minimal-example.mjs    # 命令行最小示例：打开 URL 并打印标题
├─ test/
│  ├─ mock-bidi-server.mjs   # 进程内最小 BiDi WebSocket 服务器（真实 WS 帧）
│  ├─ bidi-client.test.mjs   # 传输/会话/错误/超时测试
│  └─ controller.test.mjs    # 控制器与工具契约、错误恢复测试
├─ docs/
│  ├─ PROTOCOL.md            # 两端消息协议、命令映射、会话规则
│  └─ VERIFICATION.md        # 实测环境、命令、输出、验收结论
├─ README.md
└─ LICENSE                   # MIT
```

### 能力与工具

| 工具 | 能力 |
| --- | --- |
| `firefox_launch` | 启动 Firefox（自动选空闲回环端口、专用 profile）或连接已开启 remote agent 的 Firefox；可带 URL |
| `firefox_tabs` | `list` / `new` / `switch` / `close` 标签页 |
| `firefox_navigate` | 导航到 URL，等待 `complete`/`interactive`/`none` |
| `firefox_read` | 读取标题、URL、正文、DOM HTML；可按 CSS selector 读单个元素 |
| `firefox_click` | 按 selector 或可见文字点击；优先 `input.performActions` 真实鼠标事件，失败回退 DOM click |
| `firefox_fill` | 填写 input/textarea/select/checkbox/radio/contenteditable，可选 `requestSubmit()` 提交 |
| `firefox_eval` | 在页面上下文执行 JavaScript 表达式，支持 await Promise，返回 JSON 化结果 |
| `firefox_wait` | 等待元素 `visible/hidden/attached/detached` 或 `document.readyState` |
| `firefox_close` | 关闭当前/指定标签页、断开连接（保留 Firefox）、关闭 Firefox |

以上 9 个工具在真实 dsh 会话中均可调用。所有操作串行化在一条 BiDi 命令队列中，避免标签页/会话状态互相踩踏。

---

## 2. Windows 10 x64 安装与配置

### 2.1 前置条件

- Windows 10 x64（本验证机为 Windows 10，Firefox 为 x64 构建）。
- Firefox **153 ESR** 已安装。本机路径：`D:\Program Files\Mozilla Firefox\firefox.exe`，版本 `153.5.1esr`。
- dsh `0.2.1-rc.5` 已安装并至少能启动某个 profile（本验证使用 `web` profile）。
- Node.js `>=22`（本机 `v24.21.0`；插件使用 Node 内置全局 `WebSocket`，无 `ws` 依赖）。

### 2.2 安装 dsh 插件（二选一）

**方式 A：dsh Web GUI（推荐）**

1. 打开 dsh Web GUI。
2. 进入 Plugin Manager / 插件管理。
3. 选择“安装 bundle / Install bundle”，目标是本仓库绝对目录：
   ```text
   H:\files\dsh-firefox-operator
   ```
4. 安装结果应为 `application: applied`。
5. 刷新页面/新开一个会话，让工具清单重新组装。新会话里应出现 `firefox_*` 工具。

**方式 B：命令行安装**

```powershell
dsh plugin --profile web add link:H:/files/dsh-firefox-operator
```

安装后重启 dsh（或新开会话）以确保插件行和新工具被加载。

> 本机安装结果：`"stage":"enable","application":"applied"`，依赖以 symlink 指向本仓库：
> `C:\Users\Administrator\.dsh\profiles\web\node_modules\dsh-firefox-operator -> H:\files\dsh-firefox-operator`。

**如果遇到 `ERR_PNPM_UNEXPECTED_STORE`**

这是 dsh profile 的 pnpm store 配置与现有 `node_modules` 不一致，不是插件问题。先查看：

```powershell
Get-Content "$env:DSH_PROFILE_DIR\node_modules\.modules.yaml" | Select-String storeDir
```

把 pnpm 全局 `store-dir` 指向该 `storeDir`（本机为 `D:\pnpm-store\v11\v11`）：

```powershell
# 若 pnpm 提示全局 bin 不在 PATH，先把下面目录加入 PATH：
# C:\Users\<你>\AppData\Local\pnpm\bin
pnpm config set store-dir "D:\pnpm-store\v11\v11" --global
```

然后重试安装。不要手改 profile 的 `package.json`，让插件管理器执行安装。

### 2.3 Firefox 端配置

**方式 A：由 dsh 自动启动（推荐，零 Firefox 端手工配置）**

直接调用：

```json
{"name":"firefox_launch","arguments":{"headless":true}}
```

插件会：

1. 自动查找 Firefox（注册表常见路径之外，还探测 `C:\Program Files`、`D:\Program Files`、`%LOCALAPPDATA%` 等；也可配置路径）。
2. 生成/复用专用 profile（默认 `%LOCALAPPDATA%\dsh-firefox-operator\firefox-profile`），写入 WebDriver BiDi 需要的 prefs，避免污染日常 Firefox profile。
3. 自动选择空闲回环端口，以 `--remote-debugging-port=<port> --profile <dir> --no-remote --new-instance` 启动。
4. 直接连接 `ws://127.0.0.1:<port>/session`，完成 `session.new`。

**方式 B：连接你自己启动的 Firefox**

先在一个单独终端启动 Firefox（建议用专用 profile，避免占用日常实例）：

```powershell
& "D:\Program Files\Mozilla Firefox\firefox.exe" `
  --remote-debugging-port=9222 `
  --profile "$env:TEMP\ff-dsh-profile" `
  --no-remote --new-instance
```

再让 dsh 只连接、不启动：

```json
{"name":"firefox_launch","arguments":{"attach_only":true,"port":9222}}
```

注意：

- **一个 Firefox 实例同时只允许一个 WebDriver BiDi 会话**。如果已有其它 BiDi 客户端，Firefox 会返回 `Maximum number of active sessions`；先结束旧客户端或重启 Firefox。
- 本插件的 `firefox_close({"target":"disconnect"})` 会先发送 `session.end` 再断开，因此可以安全地稍后重连；直接杀 WebSocket 则会留下会话，导致下次连接失败。
- Firefox remote agent 无认证，默认仅监听回环地址；不要把 `--remote-debugging-port` 暴露到公网。

### 2.4 可选配置

插件默认值已经可用。要固定路径/端口/有头模式，在 profile 的用户 patch 层
`C:\Users\<你>\.dsh\profiles\web\cordis.patch.yml` 追加覆盖行（同一 id 会覆盖 bundle 内配置；本插件对缺省字段使用默认值）：

```yaml
- id: dsh-firefox-operator
  config:
    firefoxPath: 'D:\Program Files\Mozilla Firefox\firefox.exe'
    profileDir: 'C:\Users\<你>\AppData\Local\dsh-firefox-operator\firefox-profile'
    port: 0                  # 0 = 自动选空闲端口
    headless: true           # 想看窗口时设为 false
    launchTimeoutMs: 30000
    commandTimeoutMs: 20000
    navigationTimeoutMs: 60000
    defaultWaitMs: 10000
    maxReadChars: 30000
    killOnDispose: true      # 插件卸载时结束会话并杀掉自己启动的 Firefox
```

也可用环境变量（dsh Host 进程环境）覆盖路径/profile/端口/headless：

```text
DSH_FIREFOX_PATH
DSH_FIREFOX_PROFILE
DSH_FIREFOX_PORT
DSH_FIREFOX_HEADLESS
FIREFOX_PATH
```

---

## 3. 最小使用示例（实测）

### 3.1 在 dsh Web GUI 中让 agent 调用

直接对 dsh 说（可复制）：

> 使用 `firefox_launch` 启动 Firefox（headless），然后用 `firefox_navigate` 打开 `https://example.com/`，最后用 `firefox_read` 读取页面标题和正文。只汇报标题和 URL。

等价的三次工具调用与期望输出：

```json
{"name":"firefox_launch","arguments":{"headless":true}}
```

```json
{
  "connected": true,
  "port": 5724,
  "browser": "firefox",
  "external": false,
  "firefoxPid": 20824,
  "activeTabId": "92adb53e-...",
  "tabs": [{"tabId":"92adb53e-...","url":"about:blank","title":"","type":"tab"}],
  "launched": true,
  "alreadyConnected": false
}
```

```json
{"name":"firefox_navigate","arguments":{"url":"https://example.com/"}}
```

```json
{
  "tabId": "92adb53e-...",
  "url": "https://example.com/",
  "title": "Example Domain",
  "requestedUrl": "https://example.com/",
  "waitUntil": "complete"
}
```

```json
{"name":"firefox_read","arguments":{}}
```

```json
{
  "tabId": "92adb53e-...",
  "url": "https://example.com/",
  "title": "Example Domain",
  "readyState": "complete",
  "tag": "body",
  "text": "该域名仅用于文档示例…… Learn more",
  "textTruncated": false
}
```

端口、PID、tab id 每次不同；`title` 为 `Example Domain` 是网络正常时的预期结果。如果实例完全离线，`firefox_navigate` 仍可能返回 Firefox 的错误页标题，此时请检查网络。

### 3.2 命令行最小示例

在 dsh 沙箱之外（需要启动 Firefox 的终端）运行：

```powershell
cd H:\files\dsh-firefox-operator
node scripts/minimal-example.mjs https://example.com/
```

预期输出：

```text
Firefox connected on port <随机端口> (pid <PID>)
Navigated to https://example.com/
TITLE: Example Domain
TEXT: This domain is for use in documentation examples...
```

### 3.3 全能力现场验证

```powershell
# 启动一个由插件拥有的 headless Firefox，跑完整流程并关闭
node scripts/live-check.mjs

# 或连接一个已运行的 Firefox
& "D:\Program Files\Mozilla Firefox\firefox.exe" --remote-debugging-port=9234 --profile "$env:TEMP\ff-dsh-live" --headless --no-remote --new-instance
$env:FF_PORT="9234"; $env:FF_ATTACH_ONLY="1"; node scripts/live-check.mjs
```

该脚本覆盖：启动/连接、导航、读标题/正文/DOM、真实鼠标点击、填表并提交、页面 eval、等待元素、标签页新建/切换/关闭、错误返回、错误后继续操作、关闭。实测输出见 `docs/VERIFICATION.md`。

---

## 4. 验证标准与实测结论

验收标准与对应证据：

| 标准 | 证据 | 结论 |
| --- | --- | --- |
| dsh 发出的指令能稳定触发 Firefox 操作 | 在真实 dsh 会话中调用 `firefox_launch` → `firefox_navigate` → `firefox_read`，得到 `Example Domain`；`firefox_click` 改变标题；`firefox_fill(...,submit:true)` 触发提交；`firefox_eval` 返回 `42`；`firefox_wait` 命中；`firefox_tabs` 正确列出/新建/切换/关闭 | 通过 |
| Firefox 端错误能返回给 dsh | `firefox_click({"selector":"#does-not-exist"})` 返回 dsh 工具错误：`ELEMENT_NOT_FOUND: selector not found: #does-not-exist...`；随后 `firefox_read` 仍成功 | 通过 |
| 不会导致 Firefox 或 dsh 崩溃 | 上述错误后继续执行读取；`firefox_close({"target":"browser"})` 后端口关闭、Firefox 进程退出、dsh 工具继续可用；`node scripts/live-check.mjs` 全流程 PASSED | 通过 |
| 协议/生命周期错误可诊断 | 错误码 + hint：`FIREFOX_NOT_FOUND`、`CONNECT_TIMEOUT`、`PORT_IN_USE`、`NO_SUCH_TAB`、`WAIT_TIMEOUT`、`DISCONNECTED`、`Maximum number of active sessions` 等；`session.end` 释放会话 | 通过 |

完整实测记录（环境、命令、输出、未覆盖项）见 [`docs/VERIFICATION.md`](docs/VERIFICATION.md)。

稳定性设计：

- 单 WebSocket + 单串行命令队列，避免并发命令交错。
- 每个 BiDi 命令有超时；工具接收 `exec.signal`，取消后及时返回。
- 启动失败会收集 Firefox stderr 片段；自己启动的进程在失败/显式关闭时清理。
- `session.new` 后只保留一个会话；`firefox_close(disconnect)`/插件卸载发送 `session.end`，防止“Maximum number of active sessions”锁死。
- 连接端口打开但 WebSocket 握手未就绪时重试，而不是把端口打开误判为可连接。
- 不依赖该 Firefox 版本上有问题的 `/json/version` HTTP 路由。

---

## 5. 故障排查

| 现象 | 处理 |
| --- | --- |
| `FIREFOX_NOT_FOUND` | 设置 `config.firefoxPath` 或 `FIREFOX_PATH`；确认是 `firefox.exe` 完整路径 |
| `FIREFOX_START_TIMEOUT` / 端口未监听 | 检查 profile 是否被其它 Firefox 占用；用专用 profile；看错误里附带的 stderr |
| `CONNECT_TIMEOUT` / 端口在但不响应 | Firefox 启动早期会出现；插件会重试。若持续，确认端口确为 Firefox 而不是别的服务 |
| `PORT_IN_USE` | 换端口，或关闭占用端口的进程；`port:0` 自动选端口 |
| `Maximum number of active sessions` | 另一个 BiDi 客户端仍持有会话；结束它或重启 Firefox。插件自己启动的实例若检测到残留会话会自动重启 |
| `NO_SUCH_TAB` | 调用 `firefox_tabs(action:"list")` 获取当前 tab_id；导航/关闭后旧 id 失效 |
| `WAIT_TIMEOUT` | 增大 `timeout_ms`；先用 `firefox_read` 看页面是否真到了目标状态 |
| PowerShell 中 Firefox 启动后无响应 | 本机已验证：在 dsh 的 workspace-write 沙箱 shell 内启动的 Firefox 无法完成启动；改用 dsh Host 工具启动，或在沙箱外终端启动后用 `attach_only` 连接 |
| 插件安装报 `ERR_PNPM_UNEXPECTED_STORE` | 见 2.2 的 pnpm store 对齐步骤 |

---

## 6. 设计说明、限制与安全

- **为什么不是 Firefox 扩展**：dsh 有正式 Host 插件接口；Firefox 153 ESR 又内置 WebDriver BiDi。用扩展还需要处理 XPI 签名/临时安装/native messaging，复杂度更高且不增加所需能力。若未来 dsh 插件接口不可用，可用同一套 `FirefoxOperator` 的核心逻辑改造成 Firefox 扩展 + 本地 WebSocket，但本交付不需要。
- **一个浏览器一个 BiDi 会话**：所有 dsh 会话共享同一个 Firefox；工具是全局的。并发工具调用被串行化。
- **`firefox_eval` 是任意页面 JavaScript**：只对可信页面使用；不要把它指向不可信内容后把结果当指令。
- **专用 profile**：默认 profile 独立于日常 Firefox；如果要复用登录态，请显式配置 `profileDir` 指向自己的 profile，并理解 dsh agent 会拥有该 profile 的控制权。
- **remote agent 无认证**：仅监听回环；不要将调试端口转发到公网或不可信网络。
- **未实现**：截图、下载、文件选择器、扩展管理、iframe 内部独立上下文切换（顶层标签页操控完整）。这些不是本任务要求；需要时可基于同一 BiDi 客户端扩展。

---

## 7. 测试

```powershell
cd H:\files\dsh-firefox-operator
npm test          # 6 项：BiDi 传输、错误/超时、控制器全流程、工具契约
```

`npm test` 使用 `node --test --test-isolation=none`，因为 dsh 的受限 shell 里测试 runner 默认再 spawn 子进程会被沙箱拒绝；这不是插件运行时的要求。

真实 Firefox 验证：

```powershell
node scripts/live-check.mjs
```

---

## 8. 交付物清单

- `index.js` + `lib/`：完整可运行 dsh Host 插件源码。
- `cordis.patch.yml`：dsh bundle 安装入口。
- `test/`：真实 WebSocket 协议 mock + 单元/集成测试。
- `scripts/live-check.mjs`：真实 Firefox 153 ESR 现场验证。
- `scripts/minimal-example.mjs`：最小可复制示例。
- `docs/PROTOCOL.md`：dsh ↔ Firefox 消息协议与命令映射。
- `docs/VERIFICATION.md`：本机实测记录与验收矩阵。
- 已纳入 git（见仓库提交记录）。

许可证：MIT。
