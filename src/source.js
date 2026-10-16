/**
 * Jellyfin 媒体服务器辅助运行时函数库
 * 提供 REST API 认证、URL 规范化、歌曲元数据转换、推荐歌单构建与歌词同步解析功能
 */

/**
 * 获取清洗后的 Jellyfin 服务器基础地址
 * 移除末尾斜杠、URL Hash 片段以及常见 Web 客户端路径后缀（如 /web, /web/index.html）
 */
function getBaseUrl() {
  const raw =
    (typeof source !== 'undefined' && source && source.url) ||
    (typeof baseUrl !== 'undefined' && baseUrl) ||
    '';
  if (!raw) return '';
  let clean = String(raw).trim();
  // 移除 Hash 片段（如 #/home.html, #/Users/AuthenticateByName 等）
  clean = clean.replace(/#.*$/, '');
  // 移除 Query 参数（如 ?param=val）
  clean = clean.replace(/\?.*$/, '');
  // 移除 Jellyfin Web 控制台路径后缀（如 /web, /web/, /web/index.html）
  clean = clean.replace(/\/web(?:\/index\.html)?\/?$/i, '');
  // 移除多余的末尾斜杠
  clean = clean.replace(/\/+$/, '');
  // 确保 http:// 或 https:// 协议头完整
  if (clean && !/^https?:\/\//i.test(clean)) {
    clean = 'http://' + clean;
  }
  return clean;
}

/**
 * 读取当前存储的 Jellyfin 访问令牌或 API 密钥
 */
function getStoredToken() {
  return (
    src.vars.get('token') ||
    src.vars.get('api_key') ||
    src.vars.get('apiKey') ||
    src.cache.get('token') ||
    ''
  );
}

/**
 * 读取当前存储的 Jellyfin 用户标识
 */
function getUserId() {
  return (
    src.vars.get('userId') ||
    src.vars.get('userid') ||
    src.cache.get('userId') ||
    ''
  );
}

let _authPromise = null;

/**
 * 生成 Jellyfin REST API 鉴权查询字符串
 * 优先使用已缓存或显式配置的 token / api_key；
 * 若未生成 token 但配置了用户名和密码，则自动调用 /Users/AuthenticateByName 获取并持久化 token（支持并发去重）
 */
async function auth() {
  let token = getStoredToken();
  if (token) {
    return 'apiKey=' + encodeURIComponent(token) + '&api_key=' + encodeURIComponent(token);
  }

  // 尝试读取独立凭据 user 与 password，或兼容单个 var (user:password)
  let u = src.vars.get('user') || src.vars.get('username') || '';
  let p = src.vars.get('password') || '';
  if (!u && !p) {
    const v = String(src.vars.get('var') || '');
    if (v.includes(':')) {
      const idx = v.indexOf(':');
      u = v.slice(0, idx);
      p = v.slice(idx + 1);
    } else if (v) {
      // 若 var 仅包含纯字符串，可能是直接输入的 API Key
      token = v;
      src.vars.put('token', token);
      src.cache.put('token', token);
      return 'apiKey=' + encodeURIComponent(token) + '&api_key=' + encodeURIComponent(token);
    }
  }

  // 若存在用户名，通过 Jellyfin 认证接口获取 AccessToken（支持并发请求去重）
  if (u) {
    if (!_authPromise) {
      _authPromise = (async function () {
        try {
          const baseUrl = getBaseUrl();
          const loginPayload = JSON.stringify({ Username: u, Pw: p });
          const authRes = await src.post(
            baseUrl + '/Users/AuthenticateByName',
            loginPayload,
            {
              headers: {
                'Content-Type': 'application/json',
                'Authorization':
                  'MediaBrowser Client="BBeBee", Device="BBeBee", DeviceId="bbebee-music-source", Version="1.0.0"',
                'X-Emby-Authorization':
                  'MediaBrowser Client="BBeBee", Device="BBeBee", DeviceId="bbebee-music-source", Version="1.0.0"',
              },
            }
          );
          if (authRes && authRes.status === 200 && authRes.body) {
            const data = src.parse.json(authRes.body);
            if (data && data.AccessToken) {
              const newToken = data.AccessToken;
              src.vars.put('token', newToken);
              src.cache.put('token', newToken);
              if (data.User && data.User.Id) {
                src.vars.put('userId', data.User.Id);
                src.cache.put('userId', data.User.Id);
              }
              if (data.ServerId) {
                src.vars.put('serverId', data.ServerId);
              }
              return 'apiKey=' + encodeURIComponent(newToken) + '&api_key=' + encodeURIComponent(newToken);
            }
          }
        } catch (e) {
          // 认证失败或网络异常时忽略，返回空字符串让上层处理
        } finally {
          _authPromise = null;
        }
        return '';
      })();
    }
    const res = await _authPromise;
    if (res) return res;
  }

  token = getStoredToken();
  return token ? 'apiKey=' + encodeURIComponent(token) + '&api_key=' + encodeURIComponent(token) : '';
}

/**
 * 格式化单个音频项，提取统一字段与封面标识
 * @param {object} item - Jellyfin BaseItemDto 对象
 * @param {string} [dirCoverId] - 父级目录或专辑封面标识回退
 */
function formatAudioItem(item, dirCoverId) {
  if (!item || typeof item !== 'object') return {};

  const id = String(item.Id || item.id || '');
  const title = item.Name || item.title || 'Unknown Track';

  // 艺术家字段提取
  let artist = 'Unknown Artist';
  if (Array.isArray(item.Artists) && item.Artists.length > 0) {
    artist = item.Artists.join(', ');
  } else if (item.AlbumArtist) {
    artist = item.AlbumArtist;
  } else if (item.artist) {
    artist = item.artist;
  }

  const album = item.Album || item.album || '';
  const albumId = String(item.AlbumId || item.ParentId || '');

  // 时长换算：Jellyfin RunTimeTicks 为 100 纳秒单位（10,000 ticks = 1 毫秒）
  let durationMs = 0;
  if (typeof item.RunTimeTicks === 'number') {
    durationMs = Math.round(item.RunTimeTicks / 10000);
  } else if (typeof item.durationMs === 'number') {
    durationMs = item.durationMs;
  } else if (typeof item.duration === 'number') {
    durationMs = Math.round(item.duration * 1000);
  }

  // 封面标识：优先歌曲自身 Primary 封面，次选专辑封面，最后回退父级或歌曲自身
  let coverId = id;
  if (item.ImageTags && item.ImageTags.Primary) {
    coverId = id;
  } else if (item.AlbumPrimaryImageTag && albumId) {
    coverId = albumId;
  } else if (albumId) {
    coverId = albumId;
  } else if (dirCoverId) {
    coverId = dirCoverId;
  }

  // 音频容器/格式标识（如 mp3, flac, opus）
  const quality =
    item.Container ||
    (item.MediaSources && item.MediaSources[0] && item.MediaSources[0].Container) ||
    '';

  return {
    id: id,
    title: title,
    artist: artist,
    album: album,
    albumId: albumId,
    durationMs: durationMs,
    coverId: coverId,
    quality: quality,
  };
}

/**
 * 提取搜索结果中的歌曲列表
 * 当关键词匹配到歌手而非直接歌曲名时，自动补充按歌手检索的音频结果
 * @param {object} res - /Items 搜索结果响应
 * @param {string} [searchKeyword] - 搜索关键词
 */
async function getSearchSongs(res, searchKeyword) {
  const root = res || {};
  let list = Array.isArray(root.Items) ? root.Items.slice() : (Array.isArray(root) ? root.slice() : []);

  // 获取当前查询词（若参数未显式提供，尝试从沙盒全局 key 变量获取）
  const q = searchKeyword || (typeof key !== 'undefined' ? key : '');

  // 若按歌曲名称搜索结果较少且存在查询词，尝试按 Artists 补充检索以覆盖歌手名搜索场景
  if (list.length < 20 && q && typeof src !== 'undefined' && src.get) {
    try {
      const baseUrl = getBaseUrl();
      const authQ = await auth();
      const artistUrl =
        baseUrl +
        '/Items?Artists=' +
        encodeURIComponent(q) +
        '&IncludeItemTypes=Audio&Recursive=true&Limit=50&' +
        authQ;
      const artistRes = await src.get(artistUrl);
      if (artistRes && artistRes.status === 200 && artistRes.body) {
        const artistData = src.parse.json(artistRes.body);
        const artistItems = Array.isArray(artistData && artistData.Items) ? artistData.Items : [];
        const seen = new Set(list.map(function (s) { return String(s.Id || s.id); }));
        for (let i = 0; i < artistItems.length; i++) {
          const item = artistItems[i];
          const sid = String(item.Id || item.id);
          if (!seen.has(sid)) {
            seen.add(sid);
            list.push(item);
          }
        }
      }
    } catch (e) {
      // 补充搜索降级，仅返回原有结果
    }
  }

  return list
    .filter(function (item) {
      return item && (item.Type === 'Audio' || item.RunTimeTicks !== undefined);
    })
    .map(function (item) {
      return formatAudioItem(item);
    });
}

/**
 * 提取专辑、歌单或目录下的曲目列表
 * @param {object} res - /Items?ParentId=... 响应
 */
function getTrackListSongs(res) {
  const root = res || {};
  const list = Array.isArray(root.Items) ? root.Items : (Array.isArray(root) ? root : []);

  // 提取当前专辑可能存在的公共封面 ID
  let dirCoverId = '';
  if (list.length > 0 && list[0].AlbumId) {
    dirCoverId = String(list[0].AlbumId);
  }

  return list
    .filter(function (item) {
      return item && (item.Type === 'Audio' || item.RunTimeTicks !== undefined);
    })
    .map(function (item) {
      return formatAudioItem(item, dirCoverId);
    });
}

/**
 * 构建个性化推荐列表
 * 包含首位默认探索歌单及随机推荐的专辑卡片
 * @param {object} res - 推荐专辑列表响应
 * @param {string} [sourceUrl] - 服务器地址
 */
async function buildRecommendList(res, sourceUrl) {
  const root = res || {};
  const list = Array.isArray(root.Items) ? root.Items : (Array.isArray(root) ? root : []);
  const baseUrl = getBaseUrl() || (sourceUrl ? String(sourceUrl).replace(/\/+$/, '') : '');
  const authQ = await auth();

  const albums = list.map(function (item) {
    const id = String(item.Id || item.id || '');
    let artist = 'Jellyfin';
    if (item.AlbumArtist) {
      artist = item.AlbumArtist;
    } else if (Array.isArray(item.Artists) && item.Artists.length > 0) {
      artist = item.Artists.join(', ');
    }
    return {
      id: 'album-' + id,
      name: item.Name || 'Unknown Album',
      title: item.Name || 'Unknown Album',
      artist: artist,
      kind: 'album',
      coverId: id,
      childUrl:
        baseUrl +
        '/Items?ParentId=' +
        encodeURIComponent(id) +
        '&IncludeItemTypes=Audio&SortBy=IndexNumber,SortName&SortOrder=Ascending&' +
        authQ,
    };
  });

  // 对专辑进行 Fisher-Yates 随机打乱以保持推荐新鲜感
  for (let i = albums.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = albums[i];
    albums[i] = albums[j];
    albums[j] = temp;
  }

  return albums;
}

/**
 * 获取 Jellyfin 音频同步歌词
 * 调用 /Audio/{id}/Lyrics，解析 100ns ticks 时间戳并格式化为标准 LRC 格式；
 * 若服务端未配置歌词或返回 404，返回空字符串回退至应用默认歌词源（如 LRCLIB）
 */
async function getJellyfinLyrics() {
  const baseUrl = getBaseUrl();
  if (!baseUrl) return '';

  const trackObj = (typeof track !== 'undefined' && track) ? track : {};
  const trackId = trackObj.id || '';
  if (!trackId) return '';

  const authQ = await auth();
  const lyricUrl =
    baseUrl +
    '/Audio/' +
    encodeURIComponent(trackId) +
    '/Lyrics' +
    (authQ ? '?' + authQ : '');

  try {
    const res = await src.get(lyricUrl);
    if (!res || res.status !== 200 || !res.body) return '';

    const data = src.parse.json(res.body);
    if (!data) return '';

    // 解析 Jellyfin LyricDto 结构中的 Lines
    if (Array.isArray(data.Lines) && data.Lines.length > 0) {
      const pad = function (n, len) {
        return (new Array(len + 1).join('0') + n).slice(-len);
      };
      const lrcLines = data.Lines.map(function (line) {
        const ticks = typeof line.Start === 'number' ? line.Start : 0;
        const ms = Math.floor(ticks / 10000);
        const m = Math.floor(ms / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        const c = Math.floor((ms % 1000) / 10);
        return '[' + pad(m, 2) + ':' + pad(s, 2) + '.' + pad(c, 2) + ']' + (line.Text || '');
      });
      return lrcLines.join('\n');
    }

    // 纯文本歌词兼容
    if (typeof data === 'string') return data.trim();
    if (typeof data.Lyrics === 'string') return data.Lyrics.trim();

    return '';
  } catch (e) {
    return '';
  }
}
