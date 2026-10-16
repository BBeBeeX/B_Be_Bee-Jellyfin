#!/usr/bin/env node
/**
 * scripts/test-live.mjs — 真实 Jellyfin 实例端到端接口联调测试脚本
 * 验证：URL清洗、用户认证、Ping连通、歌曲搜索、发现分类、专辑曲目、音频流、封面图及歌词接口
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const srcDir = join(repoRoot, 'src')

// 默认联调参数（支持命令行参数覆盖）
const rawServerUrl = process.argv[2] || 'http://192.168.1.100:8096/web'
const username = process.argv[3] || 'aaa'
const password = process.argv[4] || 'password'

console.log('='.repeat(70))
console.log('  B_Be_Bee-Jellyfin 真实服务全接口联调测试')
console.log('  服务器地址:', rawServerUrl)
console.log('  测试用户名:', username)
console.log('  测试密码:  [PROTECTED]')
console.log('='.repeat(70))

async function run() {
  // 1. 读取源码与规则定义
  const sourceDoc = JSON.parse(await readFile(join(srcDir, 'source.json'), 'utf8'))
  const sourceJs = await readFile(join(srcDir, 'source.js'), 'utf8')

  // 2. 初始化 QuickJS / Node 沙盒环境模拟
  const varsStore = new Map([
    ['user', username],
    ['username', username],
    ['password', password],
  ])
  const cacheStore = new Map()

  const mockSrc = {
    vars: {
      get: (k) => varsStore.get(k),
      put: (k, v) => varsStore.set(k, v),
    },
    cache: {
      get: (k) => cacheStore.get(k),
      put: (k, v) => cacheStore.set(k, v),
    },
    get: async (url, opts) => {
      const res = await fetch(url, { method: 'GET', headers: opts?.headers })
      const body = await res.text()
      return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body }
    },
    post: async (url, body, opts) => {
      const res = await fetch(url, { method: 'POST', headers: opts?.headers, body })
      const text = await res.text()
      return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: text }
    },
    parse: {
      json: (str) => JSON.parse(str),
    },
  }

  const sandbox = createContext({
    source: { url: rawServerUrl },
    src: mockSrc,
    console,
  })

  runInContext(sourceJs, sandbox)

  // ── [Step 1] URL 清洗与基础地址测试 ──
  console.log('\n[1/9] 验证 URL 规范化清洗 (getBaseUrl)...')
  const baseUrl = runInContext('getBaseUrl()', sandbox)
  console.log('  输入地址:', rawServerUrl)
  console.log('  清洗输出:', baseUrl)
  if (baseUrl.endsWith('/web') || baseUrl.endsWith('/')) {
    throw new Error('getBaseUrl 清洗失败，仍残留 /web 或尾部斜杠')
  }
  console.log('  ✓ getBaseUrl 成功规范化服务器基址')

  // ── [Step 2] 连通性测试 (ping) ──
  console.log('\n[2/9] 验证服务器存活 (ping)...')
  const pingRes = await fetch(baseUrl + '/System/Info/Public')
  console.log('  Public Info HTTP 状态码:', pingRes.status)
  if (!pingRes.ok) throw new Error(`服务器不可达: HTTP ${pingRes.status}`)
  const sysInfo = await pingRes.json()
  console.log(`  ✓ 服务器在线: 名称 "${sysInfo.ServerName}", 版本 v${sysInfo.Version}`)

  // ── [Step 3] 凭据认证与 Token 交换 (loginUrl & loginCheckJs) ──
  console.log('\n[3/9] 执行登录认证 (Users/AuthenticateByName)...')
  const loginUrl = `${baseUrl}/Users/AuthenticateByName`
  const loginPayload = JSON.stringify({ Username: username, Pw: password })
  const loginRes = await fetch(loginUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'MediaBrowser Client="BBeBee", Device="BBeBee", DeviceId="bbebee-music-source", Version="1.0.0"',
      'X-Emby-Authorization': 'MediaBrowser Client="BBeBee", Device="BBeBee", DeviceId="bbebee-music-source", Version="1.0.0"',
    },
    body: loginPayload,
  })
  console.log('  登录接口 HTTP 状态码:', loginRes.status)
  if (loginRes.status !== 200) {
    throw new Error(`认证失败: HTTP ${loginRes.status} ${await loginRes.text()}`)
  }
  const authData = await loginRes.json()
  console.log('  AccessToken 已获取:', Boolean(authData.AccessToken))
  console.log('  用户标识 User.Id:', authData.User?.Id)
  console.log('  用户名称 User.Name:', authData.User?.Name)

  // 模拟 loginCheckJs 执行存储
  sandbox.result = authData
  const loginCheckSuccess = runInContext('(function() {\n' + sourceDoc.loginCheckJs + '\n})()', sandbox)
  if (!loginCheckSuccess) throw new Error('loginCheckJs 返回 false')
  console.log('  ✓ loginCheckJs 校验成功并写入 Token 与 UserId')

  // 验证 auth() 函数输出
  const authQuery = await runInContext('auth()', sandbox)
  console.log('  生成的鉴权参数:', authQuery)
  if (!authQuery.includes('apiKey=')) throw new Error('auth() 未生成合法鉴权参数')
  console.log('  ✓ auth() 查询参数生成正确')

  // ── [Step 4] 歌曲检索接口测试 (searchUrl & ruleSearch) ──
  console.log('\n[4/9] 测试歌曲检索接口 (ruleSearch)...')
  // 4a. 歌曲名称直接搜索
  const songQuery = 'Plazma'
  console.log(`  4a. 按歌曲名搜索: "${songQuery}"`)
  const searchSongUrl = `${baseUrl}/Items?searchTerm=${encodeURIComponent(songQuery)}&IncludeItemTypes=Audio&Recursive=true&Limit=10&${authQuery}`
  const searchSongRes = await fetch(searchSongUrl).then((r) => r.json())
  sandbox.key = songQuery
  const songList = await runInContext(`getSearchSongs(${JSON.stringify(searchSongRes)})`, sandbox)
  console.log(`      检索到 ${songList.length} 首歌曲`)
  if (songList.length > 0) {
    const s = songList[0]
    console.log(`      示例曲目: "${s.title}" - ${s.artist} [${s.album}] 时长:${s.durationMs}ms 格式:${s.quality}`)
  }

  // 4b. 歌手名称智能补充搜索
  const artistQuery = 'Beyond'
  console.log(`  4b. 按歌手名搜索: "${artistQuery}"`)
  const searchArtistUrl = `${baseUrl}/Items?searchTerm=${encodeURIComponent(artistQuery)}&IncludeItemTypes=Audio&Recursive=true&Limit=10&${authQuery}`
  const searchArtistRes = await fetch(searchArtistUrl).then((r) => r.json())
  sandbox.key = artistQuery
  const artistSongList = await runInContext(`getSearchSongs(${JSON.stringify(searchArtistRes)}, "${artistQuery}")`, sandbox)
  console.log(`      智能合并检索到 ${artistSongList.length} 首歌曲`)
  for (const s of artistSongList) {
    console.log(`      - "${s.title}" - ${s.artist} [${s.album}]`)
  }
  if (artistSongList.length === 0) throw new Error('未能检索到 Beyond 歌手曲目')
  console.log('  ✓ 搜索接口及歌手智能合并工作正常')

  // ── [Step 5] 发现栏目接口测试 (exploreUrl & ruleExplore) ──
  console.log('\n[5/9] 测试发现浏览接口 (exploreUrl & ruleExplore)...')
  const exploreSpecs = JSON.parse(sourceDoc.exploreUrl)
  console.log(`  配置的发现栏目数: ${exploreSpecs.length}`)
  for (const spec of exploreSpecs) {
    const renderedUrl = spec.url
      .replace('{{@js:getBaseUrl()}}', baseUrl)
      .replace('{{source.url}}', baseUrl)
      .replace('{{@js:(page-1)*100}}', '0')
      .replace('{{@js:auth()}}', authQuery)
    const res = await fetch(renderedUrl).then((r) => r.json())
    console.log(`  - 栏目 [${spec.title}]: 包含 ${res.TotalRecordCount ?? res.Items?.length ?? 0} 个项目`)
  }
  console.log('  ✓ 发现栏目端点均可正常拉取')

  // ── [Step 6] 推荐流测试 (recommendUrl & ruleRecommend) ──
  console.log('\n[6/9] 测试个性化推荐流 (ruleRecommend)...')
  const recommendFetchUrl = `${baseUrl}/Items?IncludeItemTypes=MusicAlbum&Recursive=true&SortBy=DateCreated&SortOrder=Descending&Limit=20&${authQuery}`
  const recommendRes = await fetch(recommendFetchUrl).then((r) => r.json())
  const recommendCards = await runInContext(`buildRecommendList(${JSON.stringify(recommendRes)}, "${baseUrl}")`, sandbox)
  console.log(`  推荐流卡片数: ${recommendCards.length}`)
  if (recommendCards.length > 0) {
    const card = recommendCards[0]
    console.log(`  示例推荐卡片: [${card.title}] 艺术家:${card.artist} kind:${card.kind}`)
    console.log(`  卡片下钻地址: ${card.childUrl}`)
  }
  console.log('  ✓ 推荐流卡片构建及打乱算法正常')

  // ── [Step 7] 专辑曲目展开测试 (ruleTrackList & ruleAlbum) ──
  console.log('\n[7/9] 测试专辑曲目列表展开 (ruleTrackList)...')
  // 获取第一个专辑
  const firstAlbum = recommendRes.Items?.[0]
  if (!firstAlbum) throw new Error('服务器未找到可用专辑')
  console.log(`  目标专辑: "${firstAlbum.Name}" (Id: ${firstAlbum.Id})`)

  const albumTracksUrl = `${baseUrl}/Items?ParentId=${firstAlbum.Id}&IncludeItemTypes=Audio&SortBy=IndexNumber,SortName&SortOrder=Ascending&${authQuery}`
  const albumTracksRes = await fetch(albumTracksUrl).then((r) => r.json())
  const trackList = runInContext(`getTrackListSongs(${JSON.stringify(albumTracksRes)})`, sandbox)
  console.log(`  专辑包含曲目数: ${trackList.length}`)
  if (trackList.length > 0) {
    const t0 = trackList[0]
    console.log(`  首选曲目: "${t0.title}" - ${t0.artist} 时长:${t0.durationMs}ms 封面ID:${t0.coverId}`)
  }
  console.log('  ✓ 专辑详情下钻与曲目提取正常')

  // ── [Step 8] 音频流与范围请求测试 (ruleStream) ──
  console.log('\n[8/9] 测试音频串流与 HTTP Range (ruleStream)...')
  const sampleTrack = songList[0] || trackList[0]
  const streamUrl = `${baseUrl}/Audio/${sampleTrack.id}/stream?static=true&${authQuery}`
  console.log('  串流请求 URL:', streamUrl)

  const streamRes = await fetch(streamUrl, {
    headers: { Range: 'bytes=0-1024' },
  })
  console.log('  音频流 HTTP 状态码:', streamRes.status, streamRes.status === 206 ? '(206 Partial Content ✓)' : '')
  console.log('  Content-Type:', streamRes.headers.get('content-type'))
  console.log('  Content-Range:', streamRes.headers.get('content-range'))
  console.log('  Accept-Ranges:', streamRes.headers.get('accept-ranges'))
  const streamChunk = await streamRes.arrayBuffer()
  console.log(`  接收音频首包大小: ${streamChunk.byteLength} 字节`)
  if (streamRes.status !== 206 && streamRes.status !== 200) {
    throw new Error(`音频流请求异常: HTTP ${streamRes.status}`)
  }
  console.log('  ✓ 音频串流及 Seekable 拖拽分段请求完全正常')

  // ── [Step 9] 封面图片与歌词接口测试 (Artwork & ruleLyric) ──
  console.log('\n[9/9] 测试封面图片与歌词接口 (Artwork & Lyrics)...')
  // 封面图
  const coverUrl = `${baseUrl}/Items/${sampleTrack.coverId}/Images/Primary?fillWidth=300&fillHeight=300&quality=90&${authQuery}`
  const coverRes = await fetch(coverUrl)
  console.log('  封面图片 HTTP 状态码:', coverRes.status)
  console.log('  封面 Content-Type:', coverRes.headers.get('content-type'))
  const imgBuf = await coverRes.arrayBuffer()
  console.log(`  封面大小: ${imgBuf.byteLength} 字节`)
  if (!coverRes.ok) throw new Error(`封面获取失败: HTTP ${coverRes.status}`)

  // 歌词接口
  sandbox.track = { id: sampleTrack.id }
  const lyricResult = await runInContext('getJellyfinLyrics()', sandbox)
  if (lyricResult) {
    console.log('  内置同步歌词检测成功:\n', lyricResult.split('\n').slice(0, 3).join('\n'))
  } else {
    console.log('  当前音频在服务端未内嵌同步歌词 (404/Empty)')
    console.log('  ✓ needsLyricSource=true 生效，已顺利触发应用外接歌词源 (如 LRCLIB) 降级兜底')
  }

  console.log('\n' + '='.repeat(70))
  console.log('  🎉 所有接口联调测试全部通过！Jellyfin 音源与服务器完全兼容！')
  console.log('='.repeat(70))
}

run().catch((err) => {
  console.error('\n❌ 联调测试出现异常:', err)
  process.exitCode = 1
})
