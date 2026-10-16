# B_Be_Bee-Jellyfin（Jellyfin 媒体服务器音乐源）

对接 **Jellyfin** 媒体服务器的第三方音源插件，支持音乐搜索、专辑浏览、推荐流、无缝串流与同步歌词。

---

## 参数与凭据说明

本源由 B_Be_Bee 播放器及统一配置 UI 消费，参数配置规范如下：

- **可配置参数 (`params`)**：声明 `["sourceurl", "user", "username", "password", "token"]`，用户可在客户端自定义修改。
- **服务器地址 (`host` / `sourceUrl`)**：默认占位地址为 `https://jellyfin.example.org`。用户在客户端配置实际服务器地址后，B_Be_Bee 会自动提取主机名并动态追加到 QuickJS 沙盒的 Egress 网络白名单中。
- **认证凭据 (`user` 与 `password`)**：通过 `loginUi` 表单输入，并通过硬件密钥库（OS Keychain / Encrypted Secrets）安全存储。
  - `loginUi` 声明结构：
    ```json
    "loginUi": [
      { "id": "user", "label": "Username", "type": "text" },
      { "id": "password", "label": "Password", "type": "password" }
    ]
    ```
- **访问凭据自动交换**：客户端提交用户名与密码后，自动请求 `/Users/AuthenticateByName` 端点换取 `AccessToken` 并持久化，后续所有请求自动携带 `api_key` 参数或认证头。亦支持直接在变量中配置 `token`（API Key）。

---

## 核心字段说明

| 字段 | 值 / 示例 | 说明 |
|---|---|---|
| `sourceUrl` | `https://jellyfin.example.org` | 服务器基址（host 映射项） |
| `loginUi` | `[{ id: "user", ... }, { id: "password", ... }]` | 用户名与密码凭据输入界面规范 |
| `loginUrl` | `/Users/AuthenticateByName` | 用户名密码登录换取 Token 端点 |
| `searchUrl` | `/Items?searchTerm={{key}}&IncludeItemTypes=Audio...` | 歌曲搜索端点（分页参数 `StartIndex`） |
| `exploreUrl` | JSON 数组 | 3 个发现栏目：Recently added / Alphabetical / Playlists |
| `ruleExplore` | `$.Items[*]` | 行类型 `=album`，`childUrl` 获取专辑内音频曲目 |
| `ruleRecommend` | `@js:buildRecommendList(result)` | 专辑推荐流（带 Fisher-Yates 随机打乱） |
| `ruleStream.url` | `/Audio/{{track.id}}/stream?static=true...` | 原生静态音频流，支持 HTTP 范围请求与精准拖拽（seekable） |
| `ruleLyric.lyric` | `={{@js:getJellyfinLyrics()}}` | 从 `/Audio/{id}/Lyrics` 解析 100ns 刻度至标准 LRC 同步歌词 |
| `needsLyricSource` | `true` | 若 Jellyfin 服务端无歌词或返回 404，自动回退到应用内置/第三方歌词源（如 LRCLIB） |
| `concurrentRate` | `5/1000` | 限速配置：每秒最多 5 次请求 |

---

## 目录结构

```
.
├── .github/workflows/
│   └── validate.yml   # GitHub Actions CI 自动化门禁
├── scripts/
│   ├── compile.mjs    # 单文件 index.json 编译器（自动将 source.js 内联至 jsLib）
│   └── validate.mjs   # 源码可读性、字节复现、Schema 门禁及负向测试套件
├── src/
│   ├── source.json    # 音乐源规则定义
│   └── source.js      # QuickJS 辅助运行时库（认证、数据转换与歌词解析）
├── index.json         # 编译产物（单文件，2 空格缩进，稳定排序）
├── package.json
├── AGENTS.md
└── README.md
```

---

## 构建方法

使用 Node.js 运行构建脚本，将 `src/source.json` 与 `src/source.js` 编译为仓库根目录下的单文件 `index.json`：

```bash
node scripts/compile.mjs
# 或使用 npm 脚本
npm run compile
```

编译输出格式规范：2 空格缩进，稳定键顺序，末尾保留单个换行。

---

## 校验方法

运行验证门禁：

```bash
node scripts/validate.mjs
# 或使用 npm 脚本
npm run validate
```

验证项包括：
1. **源码可读性门禁**：拒绝混淆代码、单行大 blob、`eval` / 动态 `Function`，要求包含清晰可读注释与格式化结构；
2. **逐字节复现门禁**：重新在内存中编译源码，与磁盘上的 `index.json` 进行逐字节（byte-for-byte）比对，确保完全一致；
3. **JSON 格式与 Schema 校验**：验证根目录 `index.json` 符合 `SourceDocument` 契约，包括 `sourceUrl`、`loginUi`（`user` 与 `password` 字段）、`ruleStream` 等必填字段。

### 运行内置负向测试

```bash
node scripts/validate.mjs --test
# 或使用 npm 脚本
npm run test
```

负向测试会自动注入混淆特征样本、单行 blob 样本、缺失注释样本、逐字节篡改样本、缺失必填字段样本，验证校验门禁能够准确识别错误并退出非零状态码。

---

## 测试与调试

1. 启动 Jellyfin 服务器或连接现有 Jellyfin 实例；
2. 在 B_Be_Bee 客户端中将 `sourceUrl` 配置为服务器实际地址；
3. 在客户端中通过 `loginUi` 输入用户名与密码凭据；
4. 验证：
   - 搜索歌曲正常显示列表；
   - Explore 栏目能正常按分类浏览专辑并展开曲目；
   - 音频流播放顺畅，支持拖动快进（seekable）；
   - 歌曲自带歌词正常同步高亮显示，无歌词时平滑回退至外部歌词源。
