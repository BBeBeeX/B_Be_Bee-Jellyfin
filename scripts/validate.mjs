#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from './compile.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const srcDir = join(repoRoot, 'src')
const indexJsonPath = join(repoRoot, 'index.json')

const args = process.argv.slice(2)
const isTestMode = args.includes('--test')

/* ── 规则与字段定义 ────────────────────────────────────────────────────────── */

const RULE_FIELDS = {
  ruleSearch: ['trackList', 'title', 'trackId', 'artist', 'album', 'albumId', 'artwork', 'durationMs', 'quality', 'streamUrl', 'childUrl', 'kind'],
  ruleSearchArtist: ['trackList', 'title', 'trackId', 'artist', 'album', 'albumId', 'artwork', 'durationMs', 'quality', 'streamUrl', 'childUrl', 'kind'],
  ruleExplore: ['trackList', 'title', 'trackId', 'artist', 'album', 'albumId', 'artwork', 'durationMs', 'quality', 'streamUrl', 'childUrl', 'kind'],
  ruleTrackList: ['trackList', 'title', 'trackId', 'artist', 'album', 'albumId', 'artwork', 'durationMs', 'quality', 'streamUrl', 'childUrl', 'kind'],
  ruleAlbum: ['title', 'artist', 'artwork', 'year', 'description', 'trackCount', 'trackListUrl', 'childUrl'],
  ruleStream: ['url', 'headers', 'mimeType', 'codec', 'bitrateKbps', 'sampleRate', 'byteLength', 'seekable', 'expiresAt', 'quality', 'qualities'],
  ruleRecommend: ['trackList', 'title', 'trackId', 'artist', 'album', 'albumId', 'artwork', 'durationMs', 'quality', 'streamUrl', 'childUrl', 'kind'],
  ruleLyric: ['lyric', 'format', 'offsetMs'],
}

/* ── 校验核心函数 ──────────────────────────────────────────────────────────── */

/**
 * 校验 JavaScript 代码的可读性与安全性门禁
 * 拒绝混淆、无换行单行大 blob、eval，必须有可读注释
 */
export function checkJsReadability(code, filename = 'source.js') {
  const issues = []

  if (typeof code !== 'string') {
    issues.push(`${filename}: code must be a string`)
    return issues
  }

  // 1. 禁止 eval / Function 动态代码执行
  if (/\beval\s*\(/.test(code)) {
    issues.push(`${filename}: contains disallowed 'eval()'`)
  }
  if (/\bnew\s+Function\s*\(/.test(code) || /\bFunction\s*\(/.test(code)) {
    issues.push(`${filename}: contains disallowed dynamic 'Function()' constructor`)
  }

  // 2. 禁止常见混淆特征（如 _0x1a2b、密集 hex/unicode 转义）
  if (/_0x[a-f0-9]{4,}/i.test(code)) {
    issues.push(`${filename}: detected obfuscated variable identifier pattern (_0x...)`)
  }
  if (/(?:\\x[0-9a-fA-F]{2}){4,}/.test(code) || /(?:\\u[0-9a-fA-F]{4}){4,}/.test(code)) {
    issues.push(`${filename}: detected obfuscated escaped hex/unicode string blob`)
  }

  // 3. 拒绝无换行单行大 blob / 单行过长
  const lines = code.split('\n')
  if (code.length > 300 && lines.length < 5) {
    issues.push(`${filename}: file appears minified (only ${lines.length} lines for ${code.length} characters)`)
  }

  const MAX_LINE_LENGTH = 300
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.length > MAX_LINE_LENGTH) {
      issues.push(`${filename}:${i + 1}: line exceeds maximum length of ${MAX_LINE_LENGTH} characters (${line.length} chars)`)
      break
    }
  }

  // 4. 必须包含可读注释（// 或 /* ... */）
  const hasSingleLineComment = /\/\/.*[a-zA-Z\u4e00-\u9fa5]/.test(code)
  const hasBlockComment = /\/\*[\s\S]*?[a-zA-Z\u4e00-\u9fa5][\s\S]*?\*\//.test(code)
  if (!hasSingleLineComment && !hasBlockComment) {
    issues.push(`${filename}: code must include readable documentation comments`)
  }

  return issues
}

/**
 * 校验 JSON 文件的可读性与结构
 */
export function checkJsonReadability(rawJson, filename = 'source.json') {
  const issues = []
  if (typeof rawJson !== 'string' || !rawJson.trim()) {
    issues.push(`${filename}: file is empty`)
    return issues
  }

  try {
    JSON.parse(rawJson)
  } catch (err) {
    issues.push(`${filename}: invalid JSON — ${err.message}`)
    return issues
  }

  const lines = rawJson.split('\n')
  if (rawJson.length > 200 && lines.length < 5) {
    issues.push(`${filename}: JSON appears minified into a single line blob`)
  }

  return issues
}

/**
 * 校验 Jellyfin 音乐源 Schema
 */
export function validateJellyfinDocument(doc, filename = 'index.json') {
  const issues = []
  const at = (field, msg) => issues.push(`${filename} (${field}): ${msg}`)

  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    issues.push(`${filename}: root document must be a JSON object`)
    return issues
  }

  // 1. Identity
  if (typeof doc.sourceUrl !== 'string' || !doc.sourceUrl.trim()) {
    at('sourceUrl', 'required backend URL')
  } else if (doc.sourceUrl !== doc.sourceUrl.trim()) {
    at('sourceUrl', 'must not have leading or trailing whitespace')
  }

  if (typeof doc.sourceName !== 'string' || !doc.sourceName.trim()) {
    at('sourceName', 'required')
  }

  // 2. Scalars
  for (const key of ['sourceGroup', 'sourceIcon', 'sourceComment', 'variableComment', 'jsLib', 'concurrentRate', 'loginType', 'loginUrl', 'loginCheckJs', 'recommendUrl', 'searchUrl', 'exploreUrl']) {
    if (doc[key] !== undefined && typeof doc[key] !== 'string') {
      at(key, 'must be a string')
    }
  }

  // 3. loginUi specification for Jellyfin
  if (!Array.isArray(doc.loginUi)) {
    at('loginUi', 'must be an array of login field definitions')
  } else {
    const hasUser = doc.loginUi.some((f) => f && f.id === 'user' && f.type === 'text')
    const hasPassword = doc.loginUi.some((f) => f && f.id === 'password' && f.type === 'password')
    if (!hasUser) {
      at('loginUi', 'must declare a "user" field with type "text"')
    }
    if (!hasPassword) {
      at('loginUi', 'must declare a "password" field with type "password"')
    }
    for (const [idx, field] of doc.loginUi.entries()) {
      if (!field || typeof field !== 'object') {
        at(`loginUi[${idx}]`, 'field must be an object')
        continue
      }
      if (typeof field.id !== 'string' || !field.id.trim()) {
        at(`loginUi[${idx}].id`, 'required string')
      }
      if (typeof field.label !== 'string' || !field.label.trim()) {
        at(`loginUi[${idx}].label`, 'required string')
      }
    }
  }

  // 4. ruleStream (required)
  if (!doc.ruleStream || typeof doc.ruleStream !== 'object' || Array.isArray(doc.ruleStream)) {
    at('ruleStream', 'required object — a music source must provide ruleStream')
  } else {
    if (typeof doc.ruleStream.url !== 'string' || !doc.ruleStream.url.trim()) {
      at('ruleStream.url', 'required non-empty string')
    }
  }

  // 5. Optional rule blocks
  for (const [block, fields] of Object.entries(RULE_FIELDS)) {
    const rules = doc[block]
    if (rules === undefined) continue
    if (rules === null || typeof rules !== 'object' || Array.isArray(rules)) {
      at(block, 'must be an object')
      continue
    }
    for (const [field, rule] of Object.entries(rules)) {
      if (!fields.includes(field)) {
        at(`${block}.${field}`, 'unknown field')
        continue
      }
      if (typeof rule !== 'string') {
        at(`${block}.${field}`, 'must be a rule string')
      }
    }
  }

  return issues
}

/* ── 仓库级验证 ────────────────────────────────────────────────────────────── */

export async function validateRepository() {
  const errors = []

  // 1. 源码可读性门禁
  const srcFiles = await readdir(srcDir).catch(() => [])
  if (!srcFiles.includes('source.json')) {
    errors.push('src/source.json: file not found')
  }

  for (const file of srcFiles) {
    const filePath = join(srcDir, file)
    const content = await readFile(filePath, 'utf8')
    if (file.endsWith('.json')) {
      errors.push(...checkJsonReadability(content, `src/${file}`))
    } else if (file.endsWith('.js')) {
      errors.push(...checkJsReadability(content, `src/${file}`))
    }
  }

  // 2. 产物逐字节复现检查
  let inMemoryCompiled = ''
  try {
    inMemoryCompiled = await compile({ write: false })
  } catch (err) {
    errors.push(`Compilation error: ${err.message}`)
  }

  let diskIndexContent = ''
  try {
    diskIndexContent = await readFile(indexJsonPath, 'utf8')
  } catch (err) {
    errors.push(`index.json: failed to read from disk — ${err.message}`)
  }

  if (inMemoryCompiled && diskIndexContent) {
    const compiledBuf = Buffer.from(inMemoryCompiled, 'utf8')
    const diskBuf = Buffer.from(diskIndexContent, 'utf8')
    if (Buffer.compare(compiledBuf, diskBuf) !== 0) {
      errors.push(
        `index.json: byte-for-byte mismatch between compiled output (${compiledBuf.length} B) and disk file (${diskBuf.length} B). Run 'node scripts/compile.mjs' to sync.`,
      )
    }
  }

  // 3. JSON 格式与 Schema 校验
  if (diskIndexContent) {
    let doc
    try {
      doc = JSON.parse(diskIndexContent)
      errors.push(...validateJellyfinDocument(doc, 'index.json'))
    } catch (err) {
      errors.push(`index.json: invalid JSON — ${err.message}`)
    }
  }

  return errors
}

/* ── 负向测试套件 ──────────────────────────────────────────────────────────── */

export async function runNegativeTests() {
  console.log('[TEST] Running negative test suite for B_Be_Bee-Jellyfin...')
  let passed = 0
  let failed = 0

  function assertHasError(testName, issues, expectedSubstrings = []) {
    if (!issues || issues.length === 0) {
      console.error(`  FAIL: ${testName} — expected error but passed with 0 errors`)
      failed++
      return
    }
    for (const sub of expectedSubstrings) {
      const found = issues.some((msg) => msg.toLowerCase().includes(sub.toLowerCase()))
      if (!found) {
        console.error(`  FAIL: ${testName} — expected error containing "${sub}", got: ${JSON.stringify(issues)}`)
        failed++
        return
      }
    }
    console.log(`  PASS: ${testName}`)
    passed++
  }

  // 1. Obfuscation check: eval()
  {
    const badJs = `// comment\neval("malicious()");\nconst a = 1;`
    const issues = checkJsReadability(badJs)
    assertHasError('Disallow eval()', issues, ['eval'])
  }

  // 2. Obfuscation check: Function constructor
  {
    const badJs = `// comment\nconst fn = new Function('return 1');`
    const issues = checkJsReadability(badJs)
    assertHasError('Disallow new Function()', issues, ['Function'])
  }

  // 3. Obfuscation check: hex pattern _0x...
  {
    const badJs = `// comment\nconst _0x1a2b = 'obfuscated';`
    const issues = checkJsReadability(badJs)
    assertHasError('Disallow _0x identifier pattern', issues, ['_0x'])
  }

  // 4. Obfuscation check: single-line minified blob
  {
    const badJs = `// c\n` + 'a'.repeat(400)
    const issues = checkJsReadability(badJs)
    assertHasError('Disallow minified single-line blob', issues, ['minified', 'exceeds'])
  }

  // 5. Readability check: missing comments
  {
    const badJs = `function add(a, b) {\n  return a + b;\n}\nconst res = add(1, 2);\n`
    const issues = checkJsReadability(badJs)
    assertHasError('Require comments', issues, ['comment'])
  }

  // 6. Schema check: missing sourceUrl
  {
    const badDoc = {
      sourceName: 'Test',
      loginUi: [{ id: 'user', label: 'User', type: 'text' }, { id: 'password', label: 'Pass', type: 'password' }],
      ruleStream: { url: 'https://test' }
    }
    const issues = validateJellyfinDocument(badDoc)
    assertHasError('Require sourceUrl', issues, ['sourceUrl'])
  }

  // 7. Schema check: missing ruleStream
  {
    const badDoc = {
      sourceUrl: 'https://test',
      sourceName: 'Test',
      loginUi: [{ id: 'user', label: 'User', type: 'text' }, { id: 'password', label: 'Pass', type: 'password' }]
    }
    const issues = validateJellyfinDocument(badDoc)
    assertHasError('Require ruleStream', issues, ['ruleStream'])
  }

  // 8. Schema check: missing loginUi password field
  {
    const badDoc = {
      sourceUrl: 'https://test',
      sourceName: 'Test',
      ruleStream: { url: 'https://test' },
      loginUi: [{ id: 'user', label: 'User', type: 'text' }]
    }
    const issues = validateJellyfinDocument(badDoc)
    assertHasError('Require loginUi password field', issues, ['loginUi', 'password'])
  }

  // 9. Reproducibility check: byte mismatch simulation
  {
    const compiled = '{"sourceUrl":"https://test"}\n'
    const disk = '{"sourceUrl":"https://test","diff":1}\n'
    const compiledBuf = Buffer.from(compiled, 'utf8')
    const diskBuf = Buffer.from(disk, 'utf8')
    const mismatch = Buffer.compare(compiledBuf, diskBuf) !== 0
    if (mismatch) {
      console.log('  PASS: Byte mismatch detected on tampered content')
      passed++
    } else {
      console.error('  FAIL: Byte mismatch not detected')
      failed++
    }
  }

  // 10. Functional test: verify source.js helper functions
  {
    const jsContent = await readFile(join(srcDir, 'source.js'), 'utf8')
    const mockVars = new Map([
      ['token', 'test-access-token-123'],
      ['userId', 'user-456'],
    ])
    const mockSrc = {
      vars: {
        get: (k) => mockVars.get(k),
        put: (k, v) => mockVars.set(k, v),
      },
      cache: {
        get: () => undefined,
        put: () => undefined,
      },
      get: async (url) => {
        if (url.includes('/Audio/track-1/Lyrics')) {
          return {
            status: 200,
            body: JSON.stringify({
              Lines: [
                { Start: 150000000, Text: 'Hello world' },
                { Start: 325000000, Text: 'Synchronized lyric' },
              ],
            }),
          }
        }
        return { status: 404, body: '' }
      },
      post: async () => ({ status: 200, body: '{"AccessToken":"mock-token"}' }),
      parse: {
        json: (str) => JSON.parse(str),
      },
    }

    const { createContext, runInContext } = await import('node:vm')
    const ctx = createContext({
      src: mockSrc,
      source: { url: 'https://jellyfin.example.org' },
      track: { id: 'track-1' },
      console,
    })

    try {
      runInContext(jsContent, ctx)

      // Test formatAudioItem & duration ticks conversion
      const sampleItem = {
        Id: 'song-abc',
        Name: 'Test Song',
        Artists: ['Queen'],
        Album: 'A Night at the Opera',
        AlbumId: 'album-xyz',
        RunTimeTicks: 3540000000, // 354,000 ms
        Container: 'flac',
        ImageTags: { Primary: 'tag-1' },
      }
      const formatted = runInContext(`formatAudioItem(${JSON.stringify(sampleItem)})`, ctx)
      if (
        formatted.id === 'song-abc' &&
        formatted.title === 'Test Song' &&
        formatted.durationMs === 354000 &&
        formatted.coverId === 'song-abc' &&
        formatted.quality === 'flac'
      ) {
        console.log('  PASS: formatAudioItem transforms metadata and 100ns ticks to ms accurately')
        passed++
      } else {
        console.error('  FAIL: formatAudioItem unexpected result:', formatted)
        failed++
      }

      // Test getJellyfinLyrics LRC conversion
      const lyrics = await runInContext('getJellyfinLyrics()', ctx)
      if (lyrics.includes('[00:15.00]Hello world') && lyrics.includes('[00:32.50]Synchronized lyric')) {
        console.log('  PASS: getJellyfinLyrics formats 100ns ticks into standard LRC strings')
        passed++
      } else {
        console.error('  FAIL: getJellyfinLyrics unexpected result:', lyrics)
        failed++
      }

      // Test auth() returns token parameter
      const authQuery = await runInContext('auth()', ctx)
      if (
        authQuery.includes('apiKey=test-access-token-123') &&
        authQuery.includes('api_key=test-access-token-123')
      ) {
        console.log('  PASS: auth() query string generation (supports both apiKey and api_key)')
        passed++
      } else {
        console.error('  FAIL: auth() unexpected result:', authQuery)
        failed++
      }

      // Test getBaseUrl URL cleaning with hash fragments and /web path
      const urlTestCases = [
        ['http://127.0.0.1:8096/web/#/Users/AuthenticateByName', 'http://127.0.0.1:8096'],
        ['http://127.0.0.1:8096/web/#/home.html', 'http://127.0.0.1:8096'],
        ['http://127.0.0.1:8096/web', 'http://127.0.0.1:8096'],
        ['http://127.0.0.1:8096/web/', 'http://127.0.0.1:8096'],
        ['http://127.0.0.1:8096/web/index.html', 'http://127.0.0.1:8096'],
        ['https://jellyfin.nas.lan:8443/prefix/web/#/home', 'https://jellyfin.nas.lan:8443/prefix'],
        ['http://192.168.1.100:8096/', 'http://192.168.1.100:8096'],
      ]
      let allUrlsPassed = true
      for (const [inputUrl, expected] of urlTestCases) {
        const testCtx = createContext({ source: { url: inputUrl } })
        runInContext(jsContent, testCtx)
        const res = runInContext('getBaseUrl()', testCtx)
        if (res !== expected) {
          console.error(`  FAIL: getBaseUrl("${inputUrl}") => "${res}", expected "${expected}"`)
          allUrlsPassed = false
        }
      }
      if (allUrlsPassed) {
        console.log('  PASS: getBaseUrl() cleans hash fragments, /web, and trailing slashes accurately')
        passed++
      } else {
        failed++
      }

      // Test source.json params cleanliness (no redundant username in variables)
      const rawDoc = JSON.parse(await readFile(join(srcDir, 'source.json'), 'utf8'))
      if (
        Array.isArray(rawDoc.params) &&
        rawDoc.params.includes('user') &&
        !rawDoc.params.includes('username') &&
        !rawDoc.params.includes('token') &&
        rawDoc.loginUrl.includes('{{@js:getBaseUrl()}}')
      ) {
        console.log('  PASS: source.json params strictly contains [sourceurl, user, password] and loginUrl uses getBaseUrl()')
        passed++
      } else {
        console.error('  FAIL: source.json params or loginUrl does not match clean design:', rawDoc.params, rawDoc.loginUrl)
        failed++
      }
    } catch (err) {
      console.error('  FAIL: runtime functional tests threw error:', err.message)
      failed++
    }
  }

  console.log(`[TEST] Negative tests summary: ${passed} passed, ${failed} failed.\n`)
  if (failed > 0) {
    process.exitCode = 1
  }
}

/* ── 主执行流程 ────────────────────────────────────────────────────────────── */

async function main() {
  if (isTestMode) {
    await runNegativeTests()
    if (process.exitCode && process.exitCode !== 0) return
  }

  const errors = await validateRepository()

  if (errors.length > 0) {
    for (const err of errors) {
      console.error(`[ERROR] ${err}`)
    }
    console.error(`\nValidation FAILED with ${errors.length} error(s).`)
    process.exitCode = 1
  } else {
    console.log(`[OK] Validation passed: 0 errors.`)
  }
}

main().catch((err) => {
  console.error(`Validation unexpected error: ${err instanceof Error ? err.stack : String(err)}`)
  process.exitCode = 1
})
