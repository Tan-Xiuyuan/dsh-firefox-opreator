# 实测与验收报告

日期：2026-10-31（初版）/ 2026-11-06（截图、文本点击、等待摘要等增强验证）  
主机：Windows 10 x64  
dsh：`0.2.1-rc.5`  
Firefox：`Mozilla Firefox 153.5.1esr`（`D:\Program Files\Mozilla Firefox\firefox.exe`）  
Node.js：`v24.21.0`  
Profile：`web`（`C:\Users\Administrator\.dsh\profiles\web`）

---

## 1. 插件安装

通过 dsh 的 `plugin_manager` 安装本仓库：

```text
stage: enable
target: dsh-firefox-operator
application: applied
version: 0.1.0（增强后源码版本 0.2.0，linked 插件会读取最新源码）
package: + dsh-firefox-operator link:H:/files/dsh-firefox-operator
```

安装后的 profile 依赖：

```text
C:\Users\Administrator\.dsh\profiles\web\node_modules\dsh-firefox-operator
  -> H:\files\dsh-firefox-operator  (symlink)
```

安装过程中出现的 `better-sidebar` / `agent-team` 警告是 profile 既有的其它插件状态，与 Firefox Operator 无关。

安装后，当前 dsh 会话的工具清单立即出现 9 个 `firefox_*` 工具，并在同一会话内完成了下面的真实调用。2026-11-06 增强后共 10 个工具（新增 `firefox_screenshot`）；长驻会话需新开回合/重启 dsh 刷新工具 schema。

> 安装期间修复了本机 pnpm store 路径不一致（`ERR_PNPM_UNEXPECTED_STORE`），修复方式见 README 2.2；这不是插件代码问题。

---

## 2. 自动化测试

```powershell
cd H:\files\dsh-firefox-operator
npm test
```

结果：

```text
✔ BidiClient performs session.new and maps command results
✔ BidiClient surfaces BiDi errors and command timeouts without crashing
✔ BidiClient rejects a connection to a closed port with one actionable error
✔ remoteValueToJs handles BiDi primitives, arrays, and object pairs
✔ controller covers launch, navigation, read, click, fill, eval, wait, tabs, and errors
✔ tools expose the documented names and strict schemas
ℹ tests 6
ℹ pass 6
ℹ fail 0
```

覆盖点：

- 真实 WebSocket 握手、`session.new`、请求/响应 id 匹配；
- BiDi 错误 → 插件错误码；
- 命令超时后客户端仍可继续使用；
- 连接关闭端口有明确错误；
- 控制器完整流程：launch/attach、导航、读（含 links）、截图（PNG 文件/尺寸）、点击、填表提交、eval、等待、标签页新增/切换/关闭、错误后继续操作；
- 工具参数/输出 schema 和作者注解清洗；10 个工具的 schema 和实际输出已通过 dsh 自带 JSON Schema 验证器逐一校验。

---

## 3. 真实 Firefox 端到端（插件外部脚本）

### 3.1 连接已运行 Firefox

预启动：

```powershell
& "D:\Program Files\Mozilla Firefox\firefox.exe" `
  --headless --no-remote --new-instance `
  --remote-debugging-port=9234 `
  --profile "$env:TEMP\dsh-ff-liveprobe4\profile" `
  about:blank
```

执行：

```powershell
$env:FF_PORT="9234"; $env:FF_ATTACH_ONLY="1"
node scripts/live-check.mjs
```

结果：**LIVE CHECK PASSED**

关键观测：

```text
launch: connected=true, external=true, firefoxPid=22072
navigate: title="Live Check"
read: text 包含 "Firefox Operator live check"，html 包含 id="go"
click: method="pointer", title="Clicked"
fill: submitted=true, title="Submitted"
eval: 6*7 -> 42
wait: #ready visible -> matched=true
tabs: list / new("Second Tab") / switch / close 全部正确
click #does-not-exist -> ELEMENT_NOT_FOUND
错误后 firefox_read -> 仍成功
```

清理：`firefox_close(target:"disconnect")` 发送 `session.end`，Firefox 保留，后续可重连。

### 3.2 插件自己启动 Firefox

在同一台机器上，不预启动 Firefox，直接：

```powershell
node scripts/live-check.mjs
```

结果：**LIVE CHECK PASSED**

关键观测：

```text
launch: connected=true, external=false, launched=true, port=4839, firefoxPid=21820
navigate/read/click/fill/eval/wait/tabs 全部通过
close(target:"browser") 后 Firefox 进程退出，端口关闭
```

这验证了自动选空闲端口、专用 profile、prefs、WebSocket 握手、`browser.close` 清理全链路。

### 3.3 增强项验证（2026-11-06）

`node scripts/live-check.mjs` 在干净 profile 上重新执行，**LIVE CHECK PASSED**：

- `launch` 返回 `protocolVersion:"1.0"`、新端口与新 PID；
- `read` 返回 `links:[{text:"Example link",href:"https://example.org/"}]`，`linksTruncated:false`；
- 文本点击命中 `<div class="login-entry" style="cursor:pointer">Div Login`，标题变为 `Div Clicked`，`clicked.match.kind="text"`；
- 两个同名 `Duplicate` 按钮返回 `AMBIGUOUS_TEXT`，候选列表为
  `[0] exact <button#dup1> "Duplicate"; [1] exact <button#dup2> "Duplicate"`；
  `index:1` 后命中第二个，标题变为 `Duplicate Two`；
- `firefox_screenshot` 返回
  `bytes=15397, mimeType=image/png, width=1366, height=683`，文件头为 PNG；
  用 `read_image` 成功读取并看到页面渲染（留存于
  [`screenshot-live-check.png`](screenshot-live-check.png)）；
- `wait(#never-appears, timeoutMs=400)` 返回 `WAIT_TIMEOUT`，消息含
  `Page now: title="Submitted"; ...; text="Firefox Operator live check ..."`；
- `npm test` 6/6 通过；10 个工具的参数/输出 schema 与 mock 实际输出通过
  `@deepseek-ai/dsh-tools` 的 `assertObjectJsonSchema` / `validateJsonSchemaValue`。

> 这些增强验证使用插件控制器和真实 Firefox；长驻 dsh 会话需要新回合/重启刷新
> 工具 schema 后才能在 GUI 里看到新增的 `firefox_screenshot`。

### 3.4 宿主刷新验证：必须重启 dsh web

用一个**新的 dsh 子会话**（同一 Host 进程，未重启）验证：

```text
firefox_launch {"headless":true} -> connected, protocolVersion:null, firefoxPid:8856
firefox_screenshot -> 不在工具列表里
可用 firefox_* 工具数 = 9
```

`protocolVersion:null` 与旧版代码一致，而当前工作树第 1539 行已经从
`session.new` capabilities 读取并返回 `"1.0"`；同时 source 中
`FIREFOX_TOOL_NAMES` 已包含 `firefox_screenshot`。结论：**运行中的 dsh Host
（pid 7284，22:23 启动）仍加载着编辑前的插件模块；新会话不会刷新工具注册表，
必须重启 `dsh web`。** 子会话没有重启宿主（会终止当前会话），并已用
`firefox_close(browser)` 关闭它启动的 Firefox。

重启后预期：10 个 `firefox_*` 工具，`protocolVersion:"1.0"`，
`firefox_screenshot` 返回 PNG 路径。当前工作树的自动化测试、真实 Firefox
控制器测试和 schema 校验均已通过，因此这是宿主加载时序问题，不是工具实现问题。

---

## 4. 通过 dsh 工具调用（本会话）

以下调用是 dsh 当前会话中真实发出的工具调用，不是脚本模拟。

### 4.1 启动

```json
{"name":"firefox_launch","arguments":{"headless":true}}
```

返回（节选）：

```json
{
  "connected": true,
  "port": 5724,
  "browser": "firefox",
  "external": false,
  "firefoxPid": 20824,
  "activeTabId": "92adb53e-9c0f-4a22-9a0b-4ce83adc3e5e",
  "launched": true,
  "alreadyConnected": false
}
```

Firefox 由 dsh Host 插件进程启动，`external:false`。

### 4.2 打开 URL 并读取标题（任务要求的最小示例）

```json
{"name":"firefox_navigate","arguments":{"url":"https://example.com/"}}
```

```json
{
  "url": "https://example.com/",
  "title": "Example Domain",
  "waitUntil": "complete"
}
```

```json
{"name":"firefox_read","arguments":{}}
```

```json
{
  "url": "https://example.com/",
  "title": "Example Domain",
  "readyState": "complete",
  "tag": "body",
  "text": "该域名仅用于文档示例…… Learn more",
  "textTruncated": false
}
```

**满足最小示例要求。**

### 4.3 点击

```json
{"name":"firefox_click","arguments":{"selector":"#go"}}
```

```json
{
  "title": "Clicked",
  "method": "pointer",
  "clicked": {
    "selector": "#go",
    "tag": "button",
    "point": {"x": 27, "y": 78},
    "covered": false,
    "coveredBy": null
  }
}
```

### 4.4 填表并提交

```json
{"name":"firefox_fill","arguments":{"selector":"#name","value":"Ada Lovelace","submit":true}}
```

```json
{
  "title": "Submitted",
  "filled": {
    "selector": "#name",
    "tag": "input",
    "type": "text",
    "valueLength": 12,
    "submitted": true
  }
}
```

### 4.5 页面 JavaScript

```json
{"name":"firefox_eval","arguments":{"expression":"6 * 7"}}
```

```json
{"ok": true, "resultType": "number", "result": 42, "error": null}
```

### 4.6 等待元素

```json
{"name":"firefox_wait","arguments":{"selector":"#later","state":"visible","timeout_ms":5000}}
```

```json
{"matched": true, "condition": "selector #later is visible", "elapsedMs": 6}
```

### 4.7 标签页

```json
{"name":"firefox_tabs","arguments":{"action":"list"}}
```

返回两个 tab：

```json
[
  {"tabId":"92adb53e-...","url":"https://example.com/","title":"Example Domain"},
  {"tabId":"87e4263c-...","url":"data:text/html,...","title":"Submitted"}
]
```

随后在 dsh 中再做一次独立标签页验证（新 Firefox，port 5934）：

```json
{"name":"firefox_tabs","arguments":{"action":"new","url":"data:text/html,<title>Tab Two</title><h1>second</h1>"}}
```

```json
{"action":"new","created":"98dff01f-f6b7-43ff-8990-d25db64c8f12",
 "tabs":[
   {"tabId":"ade33c18-...","url":"about:blank","title":""},
   {"tabId":"98dff01f-...","url":"data:text/html,...","title":"Tab Two"}
 ],
 "activeTabId":"98dff01f-..."}
```

```json
{"name":"firefox_tabs","arguments":{"action":"switch","tab_id":"ade33c18-..."}}
```

```json
{"action":"switch","activeTabId":"ade33c18-...","tabs":[...]}
```

```json
{"name":"firefox_tabs","arguments":{"action":"close","tab_id":"98dff01f-..."}}
```

```json
{"action":"close","closed":"98dff01f-...","activeTabId":"ade33c18-...","tabs":[{"tabId":"ade33c18-..."}]}
```

`new` / `switch` / `close` 均由 dsh 工具调用直接验证。

### 4.8 错误返回 dsh

```json
{"name":"firefox_click","arguments":{"selector":"#does-not-exist"}}
```

dsh 显示工具错误：

```text
ELEMENT_NOT_FOUND: selector not found: #does-not-exist
Hint: Use firefox_read or firefox_eval to inspect the page before clicking.
```

随后：

```json
{"name":"firefox_read","arguments":{"selector":"h1"}}
```

成功返回 `tool test`。**Firefox 未崩溃、dsh 会话未崩溃、控制器仍可用。**

### 4.9 连接已有 Firefox（attach_only）

先在普通终端（沙箱外）启动 Firefox：

```powershell
& "D:\Program Files\Mozilla Firefox\firefox.exe" --headless --no-remote --new-instance `
  --remote-debugging-port=9236 --profile "$env:TEMP\dsh-ff-attach-test\profile" about:blank
```

再通过 dsh 工具连接：

```json
{"name":"firefox_launch","arguments":{"attach_only":true,"port":9236}}
```

```json
{
  "connected": true,
  "port": 9236,
  "external": true,
  "launched": false,
  "firefoxPid": 20956,
  "tabs": [{"tabId":"d50559d5-...","url":"about:blank","title":""}]
}
```

`firefox_close({"target":"disconnect"})` 返回 `{"target":"disconnect","closed":"websocket"}`，Firefox 保持运行，之后可重新连接；这一步验证了 dsh 工具的连接路径。

### 4.10 关闭

```json
{"name":"firefox_close","arguments":{"target":"browser"}}
```

```json
{"target":"browser","closed":"browser","tabs":[],"activeTabId":null}
```

端口 5724 不再监听，PID 20824 退出。

### 4.11 命令行最小示例

```powershell
node scripts/minimal-example.mjs https://example.com/
```

实测输出：

```text
Firefox connected on port 7896 (pid 12476)
Navigated to https://example.com/
TITLE: Example Domain
TEXT: 该域名仅用于文档示例，无需获得许可。…… This domain is for use in documentation examples without needing permission. ...
```

脚本结束时 `close(target:"browser")` 关闭该 Firefox，端口停止监听。

---

## 5. 验收矩阵

| 要求 | 实现 | 实测 |
| --- | --- | --- |
| 启动或连接 Firefox | `firefox_launch`，自动启动 / `attach_only` 连接 | 两种方式均 PASSED |
| 打开、关闭、切换标签页 | `firefox_tabs` + `browsingContext.create/activate/close` | PASSED |
| 导航到 URL | `firefox_navigate` + `browsingContext.navigate` | `Example Domain` |
| 读取标题、正文、DOM | `firefox_read`，含 `include_html`、links | PASSED |
| 视觉检查/截图 | `firefox_screenshot`，落盘 PNG/JPEG，返回路径/尺寸 | 1366×683 PNG，`read_image` 成功 |
| 点击元素 | `firefox_click`，真实 pointer，DOM 回退 | title 变为 `Clicked` |
| 现代 div 按钮/多义文本 | 文本候选 `cursor:pointer`/click 类；精确优先；多义返回候选 | div 命中；两个 Duplicate 返回 `AMBIGUOUS_TEXT`，index 解决 |
| 填写并提交表单 | `firefox_fill`，原生 setter + `requestSubmit` | `submitted:true`，title 变 `Submitted` |
| 页面上下文执行 JS | `firefox_eval` | `42` |
| 等待页面/元素 | `firefox_wait` | `matched:true` |
| Firefox 错误返回 dsh | 错误码 + hint，工具错误文本 | `ELEMENT_NOT_FOUND` + 后续读取成功 |
| Firefox/dsh 不崩溃 | 串行队列、超时、session.end、清理 | 错误后继续、关闭后端口/进程消失 |

---

## 6. 已知限制与未覆盖项

- 只验证了 Firefox `153.5.1esr` / Windows 10 x64；未在其它 Firefox 版本或 Linux/macOS 实测。
- Firefox 同一实例只允许一个活动 BiDi 会话；多 dsh 会话共享一个浏览器，工具调用串行化。
- 没有实现下载、文件选择器、扩展管理、iframe 内部独立上下文、console/network 事件缓冲、sharedId 元素引用。
- 截图是视口截图；全页截图/长截图未实现。截图文件默认在系统临时目录，未自动清理。
- 超过 2^53 的整数经过 JavaScript/JSON 会失真；ID/金额请按字符串读取。
- `https://example.com/` 的正文会随 Mozilla 页面更新/本地化变化；验收以 `title=Example Domain` 和 HTTP 成功为准。
- 安装环境需要对齐 pnpm store（见 README）；这是 dsh profile 的包管理环境问题，不是插件运行时问题。
- 在 dsh 的 workspace-write 沙箱 shell 内**直接**启动 Firefox 会因低完整性进程无法完成启动；真实 dsh Host 工具调用不受影响（本报告第 4 节）。如果用户想在终端手工启动 Firefox 用于 attach，请使用普通终端（dsh 沙箱之外）。

---

## 7. 复现命令

```powershell
# 1. 单元/协议测试
cd H:\files\dsh-firefox-operator
npm test

# 2. 真实 Firefox：插件自己启动并跑完整流程
node scripts/live-check.mjs

# 3. 真实 Firefox：attach 到已有实例
& "D:\Program Files\Mozilla Firefox\firefox.exe" --headless --no-remote --new-instance `
  --remote-debugging-port=9234 --profile "$env:TEMP\ff-dsh-live" about:blank
$env:FF_PORT="9234"; $env:FF_ATTACH_ONLY="1"; node scripts/live-check.mjs

# 4. 在 dsh Web GUI 中（新会话）：
#    使用 firefox_launch 启动 headless Firefox，
#    用 firefox_navigate 打开 https://example.com/，
#    用 firefox_read 读取标题。
```
