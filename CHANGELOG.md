# Changelog

用于快速了解各版本的主要变化与升级重点。

## Unreleased

暂无。

## 1.0.2

### 本版重点

- 新增 `POST /playwright/pipeline`，支持一次请求串联导航、前置快照、脚本执行和后置快照
- `page-dom` 新增 `playwrightSnapshotMode: "compact"`，减少返回体积与 LLM token 消耗
- `page-dom` 内部改为并行采集页面信息，缩短分析等待时间
- 页面分析默认 `waitUntil` 调整为 `domcontentloaded`，更适合 SPA 场景
- 新增 `CHANGELOG.md`，用于快速查看各版本特性
- 新增版本升级命令：`release:patch`、`release:minor`、`release:major`
- 新增发布命令：`publish:npm`、`publish:clawhub`

### 适用场景

- OpenClaw 高频分析页面结构并执行自动化操作
- 需要先分析、再执行、再继续分析的多步交互链路
- 需要降低 DOM 快照体积和模型响应耗时的场景

### 升级提示

- 升级版本时可直接执行 `npm run release:patch` / `minor` / `major`
- 版本脚本会同步更新 `package.json` 与 `chrome-control-proxy/SKILL.md`
- `CHANGELOG.md` 仍建议按实际改动人工补充确认
- 发布到 npm 与 ClawHub 可分别执行 `npm run publish:npm` 与 `npm run publish:clawhub`

## 1.0.1

### 本版重点

- 完善 npm 发布与 GitHub 仓库元数据
- 补充 ClawHub Skill 元数据与安装说明
- 优化日志文件命名，按 `ccp-YYYY-MM-DD.log` 写入
- README 增补从 npm 安装与通过 ClawHub 安装 Skill 的说明

### 升级提示

- 安装服务推荐使用：`npm install -g chrome-control-proxy`
- 通过 ClawHub 搜索 `chrome-control-proxy` 可直接安装对应 Skill

## 1.0.0

### 本版重点

- 初始发布 `chrome-control-proxy`
- 提供 Chrome 生命周期控制接口：`/browser/start`、`/browser/stop`、`/browser/restart`
- 提供 Playwright 能力：`/playwright/status`、`/playwright/page-dom`、`/playwright/run`
- 提供 `ccp` CLI，用于启动、停止、重启和查看服务状态
- 支持按日期和大小切分的日志输出
