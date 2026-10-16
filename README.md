# B_Be_Bee-Jellyfin（Jellyfin 媒体服务器音乐源）

对接 **Jellyfin** 媒体服务器的第三方音源插件，支持音乐搜索、专辑浏览、推荐流、无缝串流与同步歌词。

---

## 参数与凭据说明

本源由 B_Be_Bee 播放器及统一配置 UI 消费，参数配置规范如下：

- **可配置参数 (`params`)**：声明 `["sourceurl", "user", "password"]`。
  - 用户可在客户端配置弹窗中自定义修改服务器地址与认证凭据；
  - 避免额外声明冗余的 `username` 或内部自动生成的 `token`，确保客户端配置界面仅在“凭据”区域展示唯一的 `Username` 输入框，不会在“变量”区域重复出现。
- **服务器基址清洗 (`getBaseUrl()`)**：
  - 用户从浏览器直接复制的地址常带有 Web 控制台路径或单页应用 Hash（如 `http://192.168.1.100:8096/web/#/home.html` 或 `http://127.0.0.1:8096/web/`）；
  - `getBaseUrl()` 函数会自动剥离 `#.*`（Hash 片段）、`\?.*`（查询参数）、`/web(?:\/index\.html)?\/?`（Web 控制台路径）以及末尾斜杠，并补全协议头，确保所有底层请求均精准发往 Jellyfin REST API（如 `/Users/AuthenticateByName`、`/Items`、`/Audio/{id}/stream` 等），避免因请求被截断发往静态目录 `/web/` 而返回 404；
  - 音源中所有 API 模板端点均统一使用 `{{@js:getBaseUrl()}}` 动态解析基址。
- **认证凭据 (`user` 与 `password`)**：通过 `loginUi` 表单输入，并通过硬件密钥库（OS Keychain / Encrypted Secrets）安全存储。
  - `loginUi` 声明结构：
    ```json
    "loginUi": [
      { "id": "user", "label": "Username", "type": "text" },
      { "id": "password", "label": "Password", "type": "password" }
    ]
    ```
- **访问凭据自动交换与并发去重**：
  - 客户端提交用户名与密码后，自动向 `/Users/AuthenticateByName` 请求换取 `AccessToken` 并持久化，后续所有请求自动携带 `apiKey` 与 `api_key` 查询参数；
  - `auth()` 辅助函数内置 `_authPromise` 并发锁，防止客户端多组件（推荐、发现、搜索）冷启动同时加载时发送多重登录请求导致 Token 互相冲突吊销。

---

## 核心字段与规则说明

| 字段 | 值 / 示例 | 说明 |
|---|---|---|
| `sourceUrl` | `https://jellyfin.example.org` | 默认服务器基址（供客户端计算沙盒网络访问白名单） |
| `params` | `["sourceurl", "user", "password"]` | 客户端配置参数声明 |
| `loginUi` | `[{ id: "user", ... }, { id: "password", ... }]` | 用户名与密码凭据输入界面规范 |
| `loginUrl` | `{{@js:getBaseUrl()}}/Users/AuthenticateByName,...` | 用户名密码登录换取 Token 端点（POST JSON） |
| `loginCheckJs` | JavaScript 代码字符串 | **双重会话校验引擎**（详见下文） |
| `searchUrl` | `{{@js:getBaseUrl()}}/Items?searchTerm={{key}}...` | 歌曲搜索端点（分页参数 `StartIndex`） |
| `exploreUrl` | JSON 数组 | 3 个发现栏目：Recently added / Alphabetical / Playlists |
| `ruleExplore` | `$.Items[*]` | 行类型 `=album`，`childUrl` 获取专辑内音频曲目 |
| `ruleRecommend` | `@js:buildRecommendList(result)` | 专辑推荐流（带 Fisher-Yates 随机打乱） |
| `ruleStream.url` | `={{@js:getBaseUrl()}}/Audio/{{track.id}}/stream?static=true...` | 原生静态音频流，支持 HTTP 范围请求与精准拖拽（seekable） |
| `ruleLyric.lyric` | `={{@js:getJellyfinLyrics()}}` | 从 `/Audio/{id}/Lyrics` 解析 100ns 刻度至标准 LRC 同步歌词 |
| `needsLyricSource` | `true` | 若 Jellyfin 服务端无歌词或返回 404，自动回退到应用内置/第三方歌词源（如 LRCLIB） |
| `concurrentRate` | `5/1000` | 限速配置：每秒最多 5 次请求 |

### `loginCheckJs` 双重会话校验设计

在 BBeBee 音源体系中，`loginCheckJs` 会在以下两种时机被调用：
1. **显式登录时 (`loginUrl`)**：验证 `/Users/AuthenticateByName` 响应是否包含 `AccessToken`。若成功，将 `AccessToken`、`userId` 与 `serverId` 持久化到 `src.vars` 和 `src.cache`；若失败则返回 `false` 触发凭据错误提示。
2. **日常业务拉取时 (`fetchChecked`)**：播放器核心在执行推荐（`recommendUrl`）、发现（`exploreUrl`）、搜索（`searchUrl`）与专辑（`ruleAlbum`）等请求收到 HTTP 200 响应后，会复用 `loginCheckJs` 检验服务端是否意外重定向到了登录页。
   - 本音源的 `loginCheckJs` 能精准识别包含 `Items` 数组或普通数据对象的业务响应并返回 `true`，**避免将日常数据响应误判为凭据丢失**（防止触发 `the session for ... is no longer valid` 误报异常）；
   - 同时精准捕获 `<!DOCTYPE html>` 或 `{ "Message": "Unauthorized" }` 等失效特征，安全触发自动重登录。

---

## 目录结构

```
.
├── .github/workflows/
│   └── validate.yml   # GitHub Actions CI 自动化门禁
├── scripts/
│   ├── compile.mjs    # 单文件 index.json 编译器（自动将 source.js 内联至 jsLib）
│   ├── validate.mjs   # 源码可读性、字节复现、Schema 门禁及负向单测套件
│   └── test-live.mjs  # 真实 Jellyfin 服务端到端 9 阶段联调测试脚本
├── src/
│   ├── source.json    # 音乐源规则定义
│   └── source.js      # QuickJS 辅助运行时库（认证、数据转换与歌词解析）
├── index.json         # 编译产物（单文件，2 空格缩进，稳定排序）
├── package.json
├── AGENTS.md
└── README.md
```

---

## 构建与编译

使用 Node.js 运行构建脚本，将 `src/source.json` 与 `src/source.js` 编译为仓库根目录下的单文件 `index.json`：

```bash
npm run compile
# 或
node scripts/compile.mjs
```

编译输出格式规范：2 空格缩进，稳定键顺序，末尾保留单个换行。

---

## 本地校验与单测

### 1. 运行基础校验门禁

```bash
npm run validate
# 或
node scripts/validate.mjs
```

验证项包括：
- **源码可读性门禁**：拒绝混淆代码、单行大 blob、`eval` / 动态 `Function`，要求包含清晰可读注释与格式化结构；
- **逐字节复现门禁**：重新在内存中编译源码，与磁盘上的 `index.json` 进行逐字节（byte-for-byte）比对，确保完全一致；
- **JSON 格式与 Schema 校验**：验证根目录 `index.json` 符合 `SourceDocument` 契约，包括 `sourceUrl`、`loginUi`（`user` 与 `password` 字段）、`ruleStream` 等必填字段。

### 2. 运行负向与功能单测套件

```bash
npm test
# 或
node scripts/validate.mjs --test
```

单测套件包含 15 项测试：
- 安全防护（拦截 eval、Function、混淆特征、单行 blob）；
- 规范合规（注释要求、必填字段完整性、字节篡改拦截）；
- 数据转换精度（100ns 刻度转换为毫秒、LRC 标准歌词时间轴格式化）；
- `getBaseUrl()` 针对各种带有 `/web`、`/web/#/home.html`、查询参数及末尾斜杠的 URL 规范化清洗；
- `params` 干净度检查（仅包含 `sourceurl`、`user`、`password`，无冗余变量）；
- `loginCheckJs` 针对登录认证与普通业务 API 响应的双重校验准确性。

---

## 真实服务器端到端联调测试

本仓库提供了 `scripts/test-live.mjs`，可针对真实的 Jellyfin 服务实例验证全部 9 大核心阶段：

```bash
# 基本用法（默认测试地址 http://192.168.1.100:8096/web）
npm run test:live

# 自定义服务器地址与账号密码（支持输入带 SPA Hash 的完整浏览器地址）
npm run test:live -- "http://192.168.1.100:8096/web/#/home.html" "username" "password"
```

测试覆盖的 9 个阶段：
1. **URL 清洗与规范化**：验证各类复杂地址能否正确还原为服务器 API 基址；
2. **Ping 连通性测试**：探测 `/System/Info/Public` 获取服务器名称与版本；
3. **用户认证与 Token 交换**：模拟 `loginUrl` 提交凭据并验证 `loginCheckJs`；
4. **歌曲检索与歌手智能合并**：测试直接歌曲检索与按歌手检索的智能补充合并；
5. **发现栏目端点测试**：验证 3 个发现分类（最近添加、字母顺序、播放列表）；
6. **个性化推荐流与会话校验**：验证推荐流生成打乱算法，确保 `loginCheckJs` 不发生会话误判；
7. **专辑曲目列表展开**：下钻具体专辑验证曲目元数据与封面 ID 继承；
8. **音频串流与 HTTP 206 Range**：测试分段 Range 请求以确保 Seekable 拖拽播放正常；
9. **封面图与歌词回退**：验证 Primary 封面图片获取与无内嵌歌词时的 `needsLyricSource` 降级兜底。
