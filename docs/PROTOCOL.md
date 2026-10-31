# 协议与本地接口

本文描述 dsh Host 插件与 Firefox 153 ESR 之间的实际接口。Firefox 侧没有本仓库代码：它使用 Firefox 内置的 **WebDriver BiDi remote agent**。因此“两端”分别是：

- **dsh 端**：`index.js` + `lib/firefox.js` + `lib/bidi-client.js`（本仓库）。
- **Firefox 端**：Firefox 自带的 remote agent（由 `--remote-debugging-port` 开启）。

---

## 1. 传输与启动约定

### 1.1 启动

```text
firefox.exe
  --no-remote
  --new-instance
  --remote-debugging-port=<PORT>
  --remote-allow-hosts=127.0.0.1,localhost
  --profile <PROFILE_DIR>
  [--headless]
  about:blank
```

`<PORT>` 默认由插件在 `127.0.0.1` 上申请空闲端口；也可以配置固定端口。

### 1.2 连接

Firefox 在该端口上提供：

```text
ws://127.0.0.1:<PORT>/session
```

插件**不访问** `http://127.0.0.1:<PORT>/json/version`。实测 Firefox `153.5.1esr`（Windows x64）上该 HTTP 路由会接受 TCP 连接但一直不返回响应：

```text
TCP 127.0.0.1:9234 ... LISTENING
GET /json/version -> timeout
ws://127.0.0.1:9234/session -> session.new 成功
```

因此启动就绪判断只看 TCP 端口，然后直接做 WebSocket 握手；WebSocket 握手本身也有超时和重试。

### 1.3 帧格式

标准 WebSocket 文本帧，UTF-8 JSON。请求带自增 `id`：

```json
{"id":1,"method":"session.new","params":{"capabilities":{}}}
```

成功响应：

```json
{"type":"success","id":1,"result":{"sessionId":"...","capabilities":{...}}}
```

错误响应：

```json
{"type":"error","id":1,"error":"invalid argument","message":"...","stacktrace":"..."}
```

事件为 `{"type":"event",...}`，本插件忽略（不使用事件驱动状态）。响应必须按 `id` 匹配；连接断开时所有未决请求立即以 `DISCONNECTED` 失败，不会永久挂起。

---

## 2. 会话生命周期

### 2.1 建立

每个 WebSocket 只允许一个会话，第一步必须是：

```json
{"id":1,"method":"session.new","params":{"capabilities":{}}}
```

实测返回（截断）：

```json
{
  "sessionId": "1b4d3ce9-...",
  "capabilities": {
    "browserName": "firefox",
    "browserVersion": "153.5.1",
    "platformName": "windows",
    "moz:headless": true,
    "moz:processID": 22072,
    "moz:profile": "C:\\...\\profile"
  }
}
```

插件把 `moz:processID` 作为外部 Firefox 的 PID 展示；自己启动时使用 spawn 得到的 PID 做清理。

### 2.2 结束（非常重要）

Firefox 每个浏览器实例只允许一个活动 BiDi 会话。**直接关闭 WebSocket 不会结束会话**；下一次 `session.new` 会返回：

```json
{"type":"error","id":1,"error":"session not created","message":"Maximum number of active sessions"}
```

所以：

- `firefox_close({"target":"disconnect"})` → 先发 `session.end`，再关闭 WebSocket；
- 插件卸载 → 尽力发送 `session.end`；
- 自己启动的 Firefox 检测到残留会话 → 自动重启该实例；
- 外部 Firefox 若已有残留会话 → 报 `FIREFOX_NOT_REACHABLE`，提示重启 Firefox 或结束其它客户端。

`session.end` 只结束会话，不关闭 Firefox：

```json
{"id":7,"method":"session.end","params":{}}
```

之后同一 Firefox 可以重新 `session.new`。

### 2.3 关闭浏览器

```json
{"id":8,"method":"browser.close","params":{}}
```

Firefox 关闭；WebSocket 可能先/后断开。插件把 `DISCONNECTED` 视为关闭成功。

---

## 3. 实际使用的 BiDi 命令

| dsh 工具 | BiDi 命令 | 说明 |
| --- | --- | --- |
| `firefox_launch` | `session.new`；可选 `browsingContext.navigate` | 启动/连接；带 URL 时复用当前 tab 或新建 |
| `firefox_tabs list` | `browsingContext.getTree` `{maxDepth:1}` | 顶层上下文；标题用 `script.evaluate("document.title")` 补取 |
| `firefox_tabs new` | `browsingContext.create` `{type:"tab",background:false}` | 返回新 `context` |
| `firefox_tabs switch` | `browsingContext.activate` `{context}` | 激活失败时仍按显式 context 运行 |
| `firefox_tabs close` | `browsingContext.close` `{context}` | 关闭指定 tab |
| `firefox_navigate` | `browsingContext.navigate` `{context,url,wait}` | `wait` = `none`/`interactive`/`complete` |
| `firefox_read` | `script.evaluate` | 页面内返回 JSON 字符串：title/url/text/html/truncated |
| `firefox_click` | `script.evaluate`（定位）+ `input.performActions` | 用元素中心坐标发真实 mouse move/down/up；不支持时回退 `element.click()` |
| `firefox_fill` | `script.evaluate` | 原生 setter + `input`/`change` 事件；可选 `form.requestSubmit()` |
| `firefox_eval` | `script.evaluate` | 包装为 async 表达式，返回 `{ok,type,value}` |
| `firefox_wait` | 轮询 `script.evaluate` | 元素状态/`document.readyState`；超时抛 `WAIT_TIMEOUT` |
| `firefox_close browser` | `browser.close` | 关闭整个 Firefox |
| `firefox_close disconnect` | `session.end` + WebSocket close | 保留 Firefox |

### 3.1 标签页枚举

```json
{"id":2,"method":"browsingContext.getTree","params":{"maxDepth":1}}
```

实测（Firefox 153 ESR 不返回 `title`，需补取）：

```json
{
  "contexts": [
    {
      "children": [],
      "context": "8cc7dcd9-...",
      "originalOpener": null,
      "url": "about:blank",
      "userContext": "default",
      "clientWindow": "ff41169a-...",
      "parent": null
    }
  ]
}
```

取标题：

```json
{
  "id": 3,
  "method": "script.evaluate",
  "params": {
    "expression": "document.title",
    "target": {"context": "8cc7dcd9-..."},
    "awaitPromise": false,
    "resultOwnership": "none"
  }
}
```

### 3.2 导航

```json
{
  "id": 4,
  "method": "browsingContext.navigate",
  "params": {
    "context": "8cc7dcd9-...",
    "url": "https://example.com/",
    "wait": "complete"
  }
}
```

返回 `{navigation,url}`；随后插件再取 `document.title` 得到 `Example Domain`。

### 3.3 页面读取/求值

```json
{
  "id": 5,
  "method": "script.evaluate",
  "params": {
    "expression": "JSON.stringify({title:document.title,text:document.body.innerText})",
    "target": {"context": "8cc7dcd9-..."},
    "awaitPromise": false,
    "resultOwnership": "none"
  }
}
```

实测响应：

```json
{
  "type": "success",
  "id": 5,
  "result": {
    "realm": "c3d5c3b3-...",
    "type": "success",
    "result": {
      "type": "string",
      "value": "{\"title\":\"ProbeTitle\",\"text\":\"hello\"}"
    }
  }
}
```

`firefox_eval("6 * 7")` 的包装表达式返回：

```json
{"ok":true,"type":"number","value":42}
```

页面异常被包装为 `{"ok":false,"error":"..."}`，作为成功工具结果返回（便于 agent 修正表达式）；BiDi 传输/协议错误则抛工具错误。

### 3.4 点击

定位（`script.evaluate`）返回：

```json
{"ok":true,"x":39,"y":97,"visible":true,"tag":"button","text":"Click me","disabled":false,"covered":false,"coveredBy":null,"type":"submit"}
```

真实鼠标事件：

```json
{
  "id": 6,
  "method": "input.performActions",
  "params": {
    "context": "8cc7dcd9-...",
    "actions": [{
      "type": "pointer",
      "id": "dsh-firefox-pointer",
      "parameters": {"pointerType": "mouse"},
      "actions": [
        {"type": "pointerMove", "x": 39, "y": 97, "origin": "viewport"},
        {"type": "pointerDown", "button": 0},
        {"type": "pointerUp", "button": 0}
      ]
    }]
  }
}
```

Firefox 153 ESR 支持该命令；若返回 `unknown command`/`unsupported operation`/`invalid argument`，回退到页面内 `element.click()`，并在工具结果里标明 `method:"dom"`。

### 3.5 填表

页面内执行，核心逻辑：

```js
const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
descriptor.set.call(el, value);                 // 原生 setter，兼容 React 等受控组件
el.dispatchEvent(new Event("input", {bubbles:true, composed:true}));
el.dispatchEvent(new Event("change", {bubbles:true, composed:true}));
if (submit) (el.form || el.closest("form")).requestSubmit();
```

`textarea`/`select`/`checkbox`/`radio`/`contenteditable` 分别处理。返回 `{ok,tag,type,submitted,formAction}`。

### 3.6 等待

插件在 Node 侧轮询，而不是在页面里挂一个长 Promise，因此：

- 每轮一个短 `script.evaluate`，容易在导航销毁 realm 时重试；
- 上限由 `timeout_ms` 控制；
- 超时抛 `WAIT_TIMEOUT`，不会无限挂起。

选择器条件：`attached` / `detached` / `visible` / `hidden`；可叠加 `load_state`。

---

## 4. 错误映射

dsh 工具错误文本稳定包含机器码与下一步提示，例如：

```text
ELEMENT_NOT_FOUND: selector not found: #does-not-exist
Hint: Use firefox_read or firefox_eval to inspect the page before clicking.
```

BiDi 错误码会转成 `FIREFOX_<CODE>`：

| BiDi / 内部错误 | 插件错误码 | 典型提示 |
| --- | --- | --- |
| `no such frame` / `no such node` | `FIREFOX_NO_SUCH_FRAME` | tab 已关闭/文档已销毁 |
| `javascript error` | `FIREFOX_JAVASCRIPT_ERROR` | 页面脚本异常 |
| `session not created` (Maximum sessions) | `FIREFOX_SESSION_NOT_CREATED` | 结束其它客户端或重启 Firefox |
| 命令无响应 | `COMMAND_TIMEOUT` | 重试/增大超时 |
| WebSocket 断开 | `DISCONNECTED` | 重新 `firefox_launch` |
| 启动超时 | `FIREFOX_START_TIMEOUT` | 检查 profile/路径/stderr |
| 端口被非 Firefox 占用 | `PORT_IN_USE` | 换端口 |
| 选中的 tab 不存在 | `NO_SUCH_TAB` | `firefox_tabs action=list` |
| 元素等待超时 | `WAIT_TIMEOUT` | 增大 `timeout_ms` |

底层 `bidi-client.js` 还负责：请求超时、AbortSignal 取消、关闭时拒绝所有 pending、忽略迟到响应、旧 socket 事件不污染新连接。

---

## 5. 安全边界

- Firefox remote agent **没有认证**；插件只连接 `127.0.0.1`，并给 Firefox 传 `--remote-allow-hosts=127.0.0.1,localhost`。不要将端口转发到公网。
- 默认使用专用 profile，不接触用户日常 Firefox 的 cookie/登录态；若配置用户 profile，agent 拥有该 profile 的浏览控制权。
- `firefox_eval`/`firefox_read` 会执行/读取页面内容；页面内容是不可信数据。
- 工具运行在 dsh Host 进程，拥有启动 Firefox 的权限；安装/启用插件应视为高信任操作。

---

## 6. 与 Firefox 扩展方案的比较

| 方案 | 是否需要签名/加载项 | 额外本地消息通道 | 本任务 |
| --- | --- | --- | --- |
| dsh 插件 + Firefox 内置 BiDi（本文） | 否 | 否，直接用内置 WebSocket | **采用** |
| Firefox 扩展 + native messaging/本地 WebSocket | 需要 XPI 安装/签名（ESR 可关闭签名校验，但更繁琐） | 需要 | 不采用 |
| geckodriver + WebDriver HTTP | 需要额外 geckodriver 进程 | HTTP | 不采用；多一个外部依赖 |

如果未来 dsh 版本移除了 `ctx.tools` 插件接口，可复用 `FirefoxOperator` 的核心协议层，改由 Firefox 扩展通过本地 WebSocket 调用；当前 0.2.1-rc.5 不需要这样做。
