# chrome-control-proxy

在宿主机上提供 **HTTP 代理服务**，用于：

- 启动 / 停止 / 重启带 **远程调试端口（默认 9222）** 的 Chrome
- 通过 **Playwright（CDP 连接）** 提供 `page-dom`、脚本执行等能力，供本机或 Docker 内 OpenClaw 等客户端调用

**要求：Node.js ≥ 18**（Playwright 与 Express 5 需要）。

---

## 安装

全局安装（推荐，可在任意目录执行 `ccp`）：

```bash
npm install -g chrome-control-proxy
```

验证：

```bash
ccp help
ccp status   # 需先启动服务，否则显示 unreachable
```

---

## 发布

升级版本号：

```bash
npm run release:patch
# 或
npm run release:minor
# 或
npm run release:major
```

说明：

- 会同步更新 `package.json` 与 `chrome-control-proxy/SKILL.md` 的版本号
- 不会自动修改 `CHANGELOG.md`，升级后按实际改动手动补充

发布到 npm：

```bash
npm run publish:npm
```

发布到 ClawHub：

```bash
npm run publish:clawhub
```

说明：

- `publish:npm` 等价于执行 `npm publish`
- `publish:clawhub` 会打开 [ClawHub 导入页](https://clawhub.ai/import)，并在终端输出仓库地址与 Skill 目录：`chrome-control-proxy/`
- 发布 ClawHub Skill 时，仓库地址使用：`https://github.com/zhengxiangqi/chrome-control-proxy`

---

## CLI：`ccp`

管理 **HTTP 服务进程**（`node index.js`），不是替代 `curl` 调接口。

| 命令 | 说明 |
|------|------|
| `ccp start` | 后台启动服务，PID 写入 `CCP_PID_FILE`（默认系统临时目录下 `chrome-control-proxy.pid`），日志默认 `chrome-control-proxy.log` |
| `ccp stop` | 按 PID 结束进程；若无 PID 或失败，会 `pkill -f` 匹配本包 `index.js` 路径 |
| `ccp restart` | `stop` 后 `start` |
| `ccp status` | 请求 `GET /health`、`/browser/status`、`/playwright/status`（服务不可达时退出码 1） |

环境变量：

| 变量 | 含义 |
|------|------|
| `PORT` | HTTP 端口，默认 `3333` |
| `HOST` | 绑定地址，默认 `127.0.0.1` |
| `CHROME_PORT` | Chrome 远程调试端口，默认 `9222` |
| `CHROME_PROFILE_DIR` | Chrome 用户数据目录 |
| `CHROME_BINARY` | Chrome 可执行文件路径 |
| `CDP_URL` | Playwright 连接地址，默认 `http://127.0.0.1:${CHROME_PORT}` |
| `PLAYWRIGHT_PAGE_DEFAULT_TIMEOUT_MS` | `locator`/`click` 等未写 `timeout` 时的默认上限，默认 **60000**（避免 CDP 页面上仍为 10s 导致 `waitFor` 易超时） |
| `PLAYWRIGHT_NAVIGATION_DEFAULT_TIMEOUT_MS` | `goto` 等导航默认上限，未设时取 **max(动作超时, 90000)** |
| `JSON_BODY_LIMIT` | 请求体大小上限，默认 `16mb` |
| `LOG_LEVEL` | 日志级别：`error` / `warn` / `info` / `debug`，默认 `info` |
| `LOG_DIR` | 若设置，除控制台外**按日期写入目录**：`ccp-YYYY-MM-DD.log` |
| `LOG_MAX_FILE_MB` | 单日单文件最大体积（MB），超出则同日内分片为 `…-YYYY-MM-DD.1.log`、`.2.log`…；不设置则不按大小切分 |
| `LOG_CONSOLE` | 是否仍输出到 stdout/stderr，默认 `true`；仅写文件时可设 `false` |
| `CCP_PID_FILE` | 覆盖 PID 文件路径 |
| `CCP_LOG_FILE` | `ccp start` 子进程 stdout/stderr 重定向文件（与 `LOG_DIR` 应用内日志不同） |

前台直接运行（不用 `ccp`）：

```bash
npm start
# 或
node index.js
```

日志默认输出到 **stdout**，前缀为 `[chrome-control-proxy]`。设置 **`LOG_DIR`** 后，会额外写入按日期的文件（可选 **`LOG_MAX_FILE_MB`** 按大小分片）。`ccp start` 后台进程仍可将输出重定向到 **`CCP_LOG_FILE`**，与应用内 `LOG_DIR` 可分开配置。生产环境也可用系统 **logrotate** 管理 `LOG_DIR` 下文件。

---

## HTTP 接口一览

### 健康与 Chrome

| 路径 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 服务与 Chrome 端口探测 |
| `/browser/status` | GET | Chrome 是否在监听 |
| `/browser/start` | POST | 启动 Chrome（带 `--remote-debugging-port`） |
| `/browser/stop` | POST | 结束 Chrome |
| `/browser/restart` | POST | 重启 Chrome |

### Playwright（与 `/browser/start` 启动的 Chrome 同一 CDP）

| 路径 | 方法 | 说明 |
|------|------|------|
| `/playwright/status` | GET | CDP 是否可连 |
| `/playwright/page-dom` | POST | 页面快照：HTML / innerText / a11y / **Playwright 专用可交互列表** |
| `/playwright/pipeline` | POST | 单次请求串联导航、前后快照与脚本执行 |
| `/playwright/run` | POST | 在 VM 中执行用户脚本（注入 `page`、`context`、`browser`） |

`POST /playwright/page-dom`、`POST /playwright/pipeline` 与 `POST /playwright/run` 在服务端 **串行排队**，避免多请求抢同一浏览器。

---

## 调用示例（宿主机）

```bash
curl -s http://127.0.0.1:3333/health
curl -s -X POST http://127.0.0.1:3333/browser/start
curl -s http://127.0.0.1:3333/playwright/status
```

## 调用示例（Docker 内访问宿主机）

将 `127.0.0.1` 换成 `host.docker.internal`（Mac/Win Docker Desktop 常见；Linux 可能需 `extra_hosts`）。

```bash
curl -s http://host.docker.internal:3333/health
```

---

## `POST /playwright/page-dom` 要点

- 默认 `waitUntil` 为 **`domcontentloaded`**，更适合页面分析；若必须等待完整资源再改成 `load` / `networkidle`。
- **`includeHtml: false`**：不返回整页 HTML，利于降 token。
- **`includePlaywrightSnapshot: true`**：返回 `playwright.targets[]`（含 **`suggestedLocator`**），便于生成脚本。
- **`playwrightSnapshotMode: "compact"`**：只返回更精简的可交互信息，适合先给 OpenClaw 做定位分析。
- **`selector`**：只截取子树，优先限制到主内容区或弹窗根节点。
- **`includeInnerText` / `includeAccessibility`**：按需打开。

---

## `POST /playwright/pipeline` 要点

- 用于一次请求内完成：**导航 -> 分析前快照 -> 执行脚本 -> 分析后快照**。
- 适合“操作后还要再拿页面结构”的场景，减少额外 HTTP 往返。
- 外层支持 `url` / `waitUntil` / `timeout` / `target`；快照部分用 `beforePageDom`、`afterPageDom` 传入，结构与 `page-dom` 参数基本一致。
- 若只需要执行脚本，不必改成 `pipeline`，继续用 `/playwright/run` 即可。

---

## `POST /playwright/run` 要点

- 脚本为 **async 函数体**，可 `await`、`return`；返回值会尽量 JSON 序列化后返回。
- **不要在请求体里同时滥用外层 `url` 与脚本内 `goto`**：若外层传 `url`，会先导航再执行脚本；**退出登录再登录** 等流程宜 **外层不传 `url`**，只在脚本里 `clearCookies` + `goto`。
- 默认 **`scriptTimeout`** 见环境变量 `PLAYWRIGHT_RUN_DEFAULT_MS`。

---

## 安全与边界

- 默认只监听 `127.0.0.1`；若改为 `0.0.0.0` 暴露局域网，需自行鉴权。
- `/playwright/run` 执行用户脚本，仅适用于可信环境。
- 测试账号与密码勿写入仓库。

---

## OpenClaw 集成说明

更完整的调用顺序、踩坑说明见仓库内 **`chrome-control-proxy/SKILL.md`**（随代码维护；**不会**打进 `npm pack` 的默认包文件，clone 仓库即可见）。

### 通过 ClawHub 安装 Skill

在 [ClawHub](https://clawhub.ai) 搜索 **`chrome-control-proxy`** 并一键安装，OpenClaw 即可加载该 Skill，获得完整的调用指南与最佳实践提示。
