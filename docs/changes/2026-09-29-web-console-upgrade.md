# 变更规格：前端改版（业务拆分）+ 管理后台（日志）

> 2026-09-29

## 目标

把单页 demo 改为简洁的「前台两个业务 + 管理后台」结构：实时聊天与数字人视频生成拆成两个独立页面，后台可查看运行日志与调用记录。

## 范围与非目标

- 范围：web 全量改版（路由、设计令牌、布局、页面）；server 运行日志持久化（`app_logs`）、后台只读接口、系统元信息接口（本次开工前已在工作区实现，前端直接对接）。
- 非目标：鉴权与账号、直播、形象上传、声音克隆、HTTP 访问日志、日志导出、新增 npm 依赖。

## 验收标准

1. 顶栏导航：实时聊天（`/chat`，`/` 默认进入）/ 数字人视频（`/video`）/ 后台（`/admin`）；URL 可直接访问，浏览器前进后退正确，未知路径回落到 `/chat`。
2. 实时聊天：保留现有行为（开始/结束、VAD 免按键、暂停倾听、打字、播放期间闭麦、最新回复自动播放、实时音量条）；新增数字人舞台（形象图 + 当前状态）。历史会话明细移到后台「会话记录」。
3. 数字人视频：保留现有行为（文本/按住说话、口播视频/仅语音、字数校验、轮询、播放）；新增字数计数、阶段进度与 9:16 预览。
4. 后台：概览（任务/会话/轮次统计、24h 错误与告警、系统配置、最近错误）、运行日志（级别/模块/关键字过滤、游标分页、自动刷新、展开附加信息）、任务记录（类型/状态过滤）、会话记录（轮次明细）。
5. 运行日志：启动、任务、聊天、迁移、5xx 异常落 `app_logs`；控制台输出保留；落库失败不影响业务；表内最多保留 20000 行。
6. 后台接口参数非法返回 400 `{ error }`；现有接口行为不变，现有测试全部通过。
7. 375 / 768 / 1024 / 1440 宽度下无横向滚动；键盘焦点可见；尊重 `prefers-reduced-motion`；图标用 SVG 不用 emoji。

## 设计

- server（已实现）：`logs.repository.ts`、`logging/app-logger.ts`、`admin/`（`/api/admin/overview|logs|logs/scopes|tasks`）、`system/`（`/api/meta`、`/api/avatar/image`）。⚠️ 后台接口无鉴权，仅适合本机/内网。
- web：
  - `lib/routes.ts`：纯函数 `resolveRoute(pathname)`（路径归一、未知回落）；`lib/router.tsx`：History API + `useSyncExternalStore`，`Link` 对修饰键点击走浏览器默认行为。
  - `lib/api.ts`：`getJSON`（非 2xx 抛出服务端 `{ error }`）、`useFetch`、`useMeta`（模块级缓存）；聊天发送、语音识别仍用原始 `fetch` 以保留"失败轮次也返回 turn"和"没听清"的特殊分支。
  - `lib/query.ts`：查询串拼装；`lib/format.ts`：时长、字节、时间格式化；`lib/logs.ts`：`mergeLatest` 自动刷新合并（满页无重叠时重置，避免漏行）；`lib/video.ts`：`pipelineSteps` 进度步骤（失败步骤按服务端 `stage` 定位）。均为纯函数。
  - `pages/ChatPage.tsx`、`pages/VideoPage.tsx`、`pages/admin/*`；`components/`（图标、顶栏、通用 UI）；样式 `styles.css` 一份，设计令牌放 `:root`。
  - 视觉：中性灰底 + 白卡片 + 单一紫色主色，系统字体，无外部字体请求。

## 测试计划

- 公开 seam：`resolveRoute`、`format`、`withQuery`、`mergeLatest`、`pipelineSteps` 纯函数（`apps/web/tests`，`tsx --test`）；server 既有单测。
- 命令：`npm test -w @human-lab/web`、`npm run test:unit -w @human-lab/server`、`npm run build`、`apps/web` 下 `tsc --noEmit` 与 `vite build`。
- UI 无组件测试框架（不为此新增依赖）：启动前后端，用浏览器逐页访问并截图核验各页面渲染、后台日志可见启动日志、过滤生效、四种宽度无横向滚动。麦克风相关交互需人工在真机浏览器验证。
