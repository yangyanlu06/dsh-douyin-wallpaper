/**
 * Host half of the Douyin wallpaper bundle.
 *
 * Owns everything the browser cannot do:
 *
 *  1. resolve a Douyin share link to a downloadable video address;
 *  2. download that video once into a local cache, so playback never depends on
 *     the CDN link, the network, or a signed URL expiring;
 *  3. persist the wallpaper state (enabled, active clip, look settings) beside
 *     the cache, so the setting survives reloads and is shared by every page;
 *  4. serve the cached bytes back to the page over a same-origin prefix route,
 *     with HTTP Range support (the browser seeks and streams with it).
 *
 * Nothing here registers a Tool, a prompt section, or a session event: the
 * plugin adds no model-facing surface and costs no tokens. The browser half
 * (client.js) is the only consumer of these routes.
 *
 * ## How a link becomes a file
 *
 * Douyin's own endpoints are closed to server-side readers: the share page's
 * SSR payload carries no video any more (`videoInfoRes` is null) and the web
 * detail APIs answer 403 (ArgusSecurityPlugin). So the link is resolved through
 * a parse service, whose JSON reply is walked generically for a playable
 * address — that keeps the plugin working with any service of this shape, and
 * `DSH_DWP_PARSE_API` can point it at another one. The link is sent to that
 * service; the video bytes and the state stay on this machine.
 *
 * Data lives in `$DSH_DWP_DATA_DIR` or `~/.dsh-douyin-wallpaper`:
 *
 *   state.json          wallpaper state (see DEFAULT_STATE)
 *   media/<id>.mp4      downloaded video
 *   cover/<id>.jpg      cover thumbnail, best effort
 */
import { spawn } from 'node:child_process'
import { createReadStream, promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Same-origin prefix every route below hangs off. */
const ROUTE = '/dsh-douyin-wallpaper'

/** The python bridge that drives the user's douyin_lapian.py resolver. */
const BRIDGE_PATH = fileURLToPath(new URL('./tools/lapian_bridge.py', import.meta.url))

/** How long the bridge may spend waiting for a play address plus downloading. */
const BRIDGE_TIMEOUT_MS = 240000

/** Upper bound for one downloaded wallpaper: enough for a long clip, small enough to fail fast. */
const MAX_MEDIA_BYTES = 240 * 1024 * 1024

/** Upper bound for a cover thumbnail. */
const MAX_COVER_BYTES = 8 * 1024 * 1024

/** Upper bound for one image of an image post. */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024

/** Upper bound for the image count taken from one image post. */
const MAX_IMAGES = 35

/** Upper bound for a JSON request body (a share link plus a little text). */
const MAX_BODY_BYTES = 64 * 1024

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

/**
 * User agent Douyin still server-renders an image post for. A normal browser UA
 * gets only the application shell; a crawler gets the note's own markup.
 */
const SPIDER_UA = 'Baiduspider'

/** Default parse service; `{url}` receives the URL-encoded share link. */
const DEFAULT_PARSE_API = 'https://api.xingzhige.com/API/douyin/?url={url}'

/**
 * Wallpaper defaults: dark frosted glass. `glass` is how opaque the interface
 * surfaces are over the video (1 = the stock look), `dim` is the black veil over
 * the video itself, the rest are the media filters.
 */
const DEFAULT_SETTINGS = {
  // First run shows the clip as close to the platform as this layer can: no
  // blur, no dimming, the thinnest glass, and brightness at its ceiling. The
  // sliders only ever move away from that.
  glass: 0.3,
  blur: 0,
  dim: 0,
  brightness: 1.3,
  contrast: 1,
  saturation: 1,
  scale: 1,
  muted: true,
  volume: 0.35,
  loop: true,
}

/** Range limits for a numeric setting, so a malformed state file cannot break the look. */
const SETTING_RANGES = {
  // Below 0.45 the text over a bright clip stops being readable; at 1.0 the
  // interface would hide the video entirely, which looks like the plugin broke.
  glass: [0.3, 0.9],
  blur: [0, 30],
  dim: [0, 0.85],
  brightness: [0.6, 1.3],
  contrast: [0.6, 1.4],
  saturation: [0, 1.8],
  scale: [1, 1.4],
  volume: [0, 1],
}

const DEFAULT_STATE = {
  version: 1,
  enabled: true,
  activeId: null,
  settings: DEFAULT_SETTINGS,
  clips: [],
}

// ---------------------------------------------------------------- filesystem

/**
 * Data directory: an explicit override first, then the user's home.
 * @returns the absolute data directory.
 */
function dataDir() {
  const override = process.env.DSH_DWP_DATA_DIR
  return override !== undefined && override.trim() !== ''
    ? path.resolve(override.trim())
    : path.join(homedir(), '.dsh-douyin-wallpaper')
}

const dirs = {
  media: () => path.join(dataDir(), 'media'),
  cover: () => path.join(dataDir(), 'cover'),
  state: () => path.join(dataDir(), 'state.json'),
}

/**
 * Create both cache directories.
 * @returns a promise resolved once both exist.
 */
async function ensureDirs() {
  await fsp.mkdir(dirs.media(), { recursive: true })
  await fsp.mkdir(dirs.cover(), { recursive: true })
}

/**
 * Clamp one persisted setting into its range, falling back to the default.
 * @param key - the setting name.
 * @param value - the stored value, possibly malformed.
 * @returns a finite number inside the declared range.
 */
function clampSetting(key, value) {
  const [min, max] = SETTING_RANGES[key] ?? [0, 1]
  const fallback = DEFAULT_SETTINGS[key]
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}

/**
 * Project an arbitrary stored state onto the current shape: unknown fields are
 * dropped, missing ones fall back, and the active id must still exist.
 * @param raw - parsed state.json, or undefined on first run.
 * @returns a state object that is safe to publish.
 */
function normalizeState(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const settings = {}
  const stored = source.settings !== null && typeof source.settings === 'object' ? source.settings : {}
  for (const key of Object.keys(SETTING_RANGES)) settings[key] = clampSetting(key, stored[key])
  settings.muted = typeof stored.muted === 'boolean' ? stored.muted : DEFAULT_SETTINGS.muted
  settings.loop = typeof stored.loop === 'boolean' ? stored.loop : DEFAULT_SETTINGS.loop
  const clips = Array.isArray(source.clips)
    ? source.clips.filter(clip => clip !== null && typeof clip === 'object'
      && typeof clip.id === 'string' && /^[a-z0-9]+$/i.test(clip.id))
      .map(clip => ({
        id: clip.id,
        pageUrl: typeof clip.pageUrl === 'string' ? clip.pageUrl : '',
        kind: clip.kind === 'images' ? 'images' : 'video',
        images: Array.isArray(clip.images)
          ? clip.images.filter(name => typeof name === 'string' && /^[a-z0-9-]+\.(jpg|png|webp|gif)$/i.test(name)).slice(0, MAX_IMAGES)
          : [],
        title: typeof clip.title === 'string' ? clip.title : '',
        author: typeof clip.author === 'string' ? clip.author : '',
        durationMs: typeof clip.durationMs === 'number' && Number.isFinite(clip.durationMs) ? clip.durationMs : 0,
        bytes: typeof clip.bytes === 'number' && Number.isFinite(clip.bytes) ? clip.bytes : 0,
        hasCover: clip.hasCover === true,
        createdAt: typeof clip.createdAt === 'number' && Number.isFinite(clip.createdAt) ? clip.createdAt : 0,
        sourceUrl: typeof clip.sourceUrl === 'string' ? clip.sourceUrl : '',
      }))
    : []
  const activeId = typeof source.activeId === 'string' && clips.some(clip => clip.id === source.activeId)
    ? source.activeId
    : null
  return {
    version: 1,
    enabled: source.enabled !== false,
    activeId,
    settings,
    clips,
  }
}

/**
 * Read the persisted state, treating a missing or unreadable file as defaults.
 * @returns the normalized state.
 */
async function readState() {
  try {
    const text = await fsp.readFile(dirs.state(), 'utf8')
    return normalizeState(JSON.parse(text))
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // A corrupt file is regenerated rather than fatal: the cache is expendable.
      console.warn('[douyin-wallpaper] state.json unreadable, starting from defaults:', error?.message)
    }
    return normalizeState(undefined)
  }
}

/**
 * Write the state atomically enough for one user: a sibling temp file renamed
 * over the target, so a crash never leaves a half-written JSON document.
 * @param state - the state to persist.
 * @returns a promise resolved once the rename landed.
 */
async function writeState(state) {
  await ensureDirs()
  const target = dirs.state()
  const temporary = `${target}.tmp`
  await fsp.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await fsp.rename(temporary, target)
}

// ------------------------------------------------------------------- network

/**
 * Fetch with a timeout and the headers Douyin-adjacent hosts expect.
 * @param url - absolute URL.
 * @param options - user agent, referer, redirect policy, and timeout.
 * @returns the response.
 */
async function request(url, options = {}) {
  const {
    userAgent = MOBILE_UA,
    referer = 'https://www.douyin.com/',
    redirect = 'follow',
    timeoutMs = 30000,
  } = options
  return await fetch(url, {
    redirect,
    headers: {
      'user-agent': userAgent,
      referer,
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
}

/** @returns whether one string is a URL that can serve video bytes. */
function looksPlayable(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return false
  if (/\.(mp4|m4v|mov|webm)(\?|#|$)/i.test(value)) return true
  return /douyinvod\.com|aweme\/v1\/play|videowebapp|\.tos\.cn\/tos-cn/i.test(value)
}

/**
 * Walk an arbitrary parse-service reply and collect playable addresses, best
 * candidate first. The service's field names are not part of any contract, so
 * the walk looks at shape rather than at fixed keys.
 * @param payload - parsed JSON.
 * @returns deduplicated absolute addresses.
 */
function collectMediaUrls(payload) {
  const hits = []
  const seen = new Set()
  let visited = 0
  const walk = (node, keyPath) => {
    if (node === null || typeof node !== 'object' || visited > 4000) return
    if (seen.has(node)) return
    seen.add(node)
    visited += 1
    for (const [key, value] of Object.entries(node)) {
      const here = `${keyPath}.${key}`
      if (typeof value === 'string') {
        if (looksPlayable(value) && !hits.some(hit => hit.url === value)) {
          const keyWeight = /url|video|play|down/i.test(key) ? 1 : 0
          const hostWeight = /douyinvod\.com|\.tos\.cn/i.test(value) ? 1 : 0
          const suffixWeight = /\.mp4(\?|#|$)/i.test(value) ? 1 : 0
          hits.push({ url: value, score: keyWeight + hostWeight + suffixWeight, path: here })
        }
      } else if (value !== null && typeof value === 'object') {
        walk(value, here)
      }
    }
  }
  walk(payload, '')
  return hits.sort((left, right) => right.score - left.score).map(hit => hit.url)
}

/**
 * Read the first plausible value for one of the given keys, depth first.
 * @param payload - parsed JSON.
 * @param keys - acceptable key names, matched case-insensitively.
 * @returns the string value, or undefined.
 */
function firstString(payload, keys) {
  const wanted = keys.map(key => key.toLowerCase())
  const seen = new Set()
  let visited = 0
  const walk = (node) => {
    if (node === null || typeof node !== 'object' || visited > 4000) return undefined
    if (seen.has(node)) return undefined
    seen.add(node)
    visited += 1
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string' && value.trim() !== '' && wanted.includes(key.toLowerCase())) {
        return value.trim()
      }
    }
    for (const value of Object.values(node)) {
      if (value !== null && typeof value === 'object') {
        const found = walk(value)
        if (found !== undefined) return found
      }
    }
    return undefined
  }
  return walk(payload)
}

/**
 * Walk an arbitrary parse-service reply and collect image addresses, keeping
 * one entry per stored image (the service lists several sizes of the same one).
 * @param payload - parsed JSON.
 * @returns deduplicated absolute image addresses.
 */
function collectImageUrls(payload) {
  const images = []
  const seenAssets = new Set()
  let visited = 0
  const walk = (node) => {
    if (node === null || typeof node !== 'object' || visited > 4000) return
    visited += 1
    for (const value of Object.values(node)) {
      if (typeof value === 'string') {
        if (!/^https?:\/\//.test(value) || !/douyinpic\.com/.test(value)) continue
        if (!/aweme-images|~noop\.jpe?g|~tplv-dy-aweme/.test(value)) continue
        // `tos-cn-i-<bucket>/<assetId>` identifies the stored asset; the query
        // carries only signing and resize parameters.
        const asset = (value.match(/tos-cn-i-[a-z0-9]+\/([A-Za-z0-9]+)/) ?? [])[1] ?? value
        if (seenAssets.has(asset)) continue
        seenAssets.add(asset)
        images.push(value)
      } else if (value !== null && typeof value === 'object') {
        walk(value)
      }
    }
  }
  walk(payload)
  return images
}

/**
 * Read the first plausible number for one of the given keys, depth first.
 * @param payload - parsed JSON.
 * @param keys - acceptable key names.
 * @returns the number, or undefined.
 */
function firstNumber(payload, keys) {
  const wanted = keys.map(key => key.toLowerCase())
  const seen = new Set()
  let visited = 0
  const walk = (node) => {
    if (node === null || typeof node !== 'object' || visited > 4000) return undefined
    if (seen.has(node)) return undefined
    seen.add(node)
    visited += 1
    for (const [key, value] of Object.entries(node)) {
      const amount = typeof value === 'string' ? Number(value) : value
      if (wanted.includes(key.toLowerCase()) && typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) {
        return amount
      }
    }
    for (const value of Object.values(node)) {
      if (value !== null && typeof value === 'object') {
        const found = walk(value)
        if (found !== undefined) return found
      }
    }
    return undefined
  }
  return walk(payload)
}

/**
 * A parse service reports its own failure in its own words; surface that text
 * instead of a generic "no video".
 * @param payload - parsed JSON.
 * @returns the service's failure message, or undefined when it claims success.
 */
function failureTextOf(payload) {
  if (payload === null || typeof payload !== 'object') return '解析服务返回的不是 JSON 对象'
  const message = payload.msg ?? payload.message ?? payload.error ?? payload.errmsg
  if (payload.code !== undefined && payload.code !== null) {
    const code = Number(payload.code)
    if (Number.isFinite(code) && code !== 0 && code !== 200) {
      return typeof message === 'string' && message !== '' ? message : `code ${payload.code}`
    }
  }
  if (payload.ok === false || payload.success === false || payload.status === 'error' || payload.status === 'failed') {
    return typeof message === 'string' && message !== '' ? message : '解析失败'
  }
  return undefined
}

/**
 * Call one configured parse service and return its JSON payload.
 * @param template - endpoint template; `{url}` receives the encoded link.
 * @param link - the Douyin share link.
 * @returns the parsed payload.
 */
async function callParseService(template, link) {
  const base = template.trim()
  const endpoint = base.includes('{url}')
    ? base.replace('{url}', encodeURIComponent(link))
    : `${base}${encodeURIComponent(link)}`
  const response = await request(endpoint, { timeoutMs: 45000, referer: 'https://www.douyin.com/' })
  if (!response.ok) throw new Error(`解析服务返回 HTTP ${response.status}`)
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new Error('解析服务没有返回 JSON，可能被限流了，稍后再试')
  }
  const failure = failureTextOf(payload)
  if (failure !== undefined) throw new Error(`解析服务说：${failure}`)
  return payload
}

/**
 * Extract the item detail from a parse service payload.
 * @param payload - the service reply.
 * @param link - the original share link.
 * @returns title, author, cover, duration, and the playable addresses.
 */
function describePayload(payload, link, pageUrl = '') {
  const urls = collectMediaUrls(payload)
  if (urls.length === 0) throw new Error('解析服务没给出可下载的视频地址')
  const duration = firstNumber(payload, ['duration', 'durationMs', 'duration_ms', 'video_duration'])
  const author = firstString(payload, ['nickname', 'name', 'author', 'nick_name'])
  const title = firstString(payload, ['title', 'desc', 'description', 'text', 'caption']) ?? ''
  const cover = firstString(payload, ['cover', 'coverUrl', 'cover_url', 'origin_cover', 'thumbnail'])
  return {
    kind: 'remote',
    urls,
    title,
    author: author ?? '',
    coverUrl: cover !== undefined && /^https?:\/\//.test(cover) ? cover : undefined,
    // The service reports either seconds or milliseconds; a clip under an hour
    // is reported in seconds.
    durationMs: duration === undefined ? 0 : duration < 3600 ? Math.round(duration * 1000) : Math.round(duration),
    sourceUrl: link,
    pageUrl,
  }
}

/**
 * Follow a Douyin short link to its canonical page without downloading a body.
 * @param link - the v.douyin.com link, or an already canonical URL.
 * @returns the final URL.
 */
/**
 * Drop the query and fragment so two links to the same item compare equal.
 * @param url - any absolute URL.
 * @returns origin plus path, without a trailing slash.
 */
function canonicalUrl(url) {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '')
  } catch {
    return url
  }
}

async function followShortLink(link) {
  let current = link
  for (let hop = 0; hop < 6; hop += 1) {
    if (/\/(?:video|note|slides)\/\d{6,}/.test(current)) return canonicalUrl(current)
    const response = await request(current, { redirect: 'manual', userAgent: MOBILE_UA, timeoutMs: 15000 })
    const location = response.headers.get('location')
    if (response.status < 300 || response.status >= 400 || location === null) return canonicalUrl(current)
    current = new URL(location, current).toString()
  }
  return canonicalUrl(current)
}

/** @returns whether a canonical Douyin URL names an image post rather than a video. */
function isImagePostUrl(url) {
  // `/slides/` is Douyin's mixed carousel: it shows several clips with their own
  // progress bars, is served as a video page, and its server-rendered markup is
  // a 404 for crawlers. It therefore belongs to the video route, not this one.
  return /\/note\//.test(url)
}

/**
 * Read one image post's page. Douyin still renders an image post for crawler
 * user agents, and that markup carries the note's own picture — the same asset
 * its API reports — even though the page carries no video and no item JSON.
 * @param pageUrl - the canonical note URL.
 * @returns its images plus title and author metadata.
 */
async function readImagePost(pageUrl) {
  const response = await request(pageUrl, { userAgent: SPIDER_UA, timeoutMs: 20000 })
  if (!response.ok) throw new Error(`页面返回 HTTP ${response.status}`)
  const html = await response.text()
  const images = []
  const add = (url) => {
    if (typeof url !== 'string') return
    const normalized = url.replace(/&amp;/g, '&')
    if (!/^https?:\/\//.test(normalized) || !/douyinpic\.com/.test(normalized)) return
    if (!images.includes(normalized)) images.push(normalized)
  }
  for (const match of html.matchAll(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/gi)) add(match[1])
  for (const match of html.matchAll(/https?:\/\/[^"'\s>\\]+douyinpic\.com[^"'\s>\\]*/g)) {
    // The note's own picture: other douyinpic URLs here are avatars and
    // recommendation thumbnails.
    if (/aweme-images/.test(match[0])) add(match[0])
  }
  const grab = (pattern) => {
    const match = html.match(pattern)
    return match === null ? undefined : match[1].replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
  }
  const title = grab(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
    ?? grab(/<title>([^<]*)<\/title>/i)?.replace(/\s*[-–|]\s*抖音\s*$/, '')
  const author = grab(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i)
  return { images, title: title ?? '', author: author ?? '' }
}

/**
 * Resolve one image post: the configured album service first (it can list a
 * whole album), then the page's own server-rendered markup.
 * @param link - the original share link.
 * @param pageUrl - the canonical note URL.
 * @returns an image item.
 */
async function resolveImagePost(link, pageUrl) {
  const albumApi = process.env.DSH_DWP_PARSE_API_ALBUM?.trim()
  let serviceError
  if (albumApi !== undefined && albumApi !== '') {
    try {
      const payload = await callParseService(albumApi, link)
      const images = collectImageUrls(payload)
      if (images.length > 0) {
        const described = describePayload({ ...payload, _imagesOnly: true }, link, pageUrl)
        return {
          kind: 'images',
          imageUrls: images,
          title: described.title,
          author: described.author,
          coverUrl: images[0],
          durationMs: 0,
          sourceUrl: link,
          pageUrl,
        }
      }
    } catch (error) {
      serviceError = error instanceof Error ? error.message : String(error)
    }
  }
  const page = await readImagePost(pageUrl)
  if (page.images.length === 0) {
    throw new Error(serviceError === undefined
      ? '这是图文作品，但页面里没有读出图片地址（可用 DSH_DWP_PARSE_API_ALBUM 配一个支持图文的解析接口）'
      : `这是图文作品：图文接口失败（${serviceError}），页面里也没有可用的图片地址`)
  }
  return {
    kind: 'images',
    imageUrls: page.images,
    title: page.title,
    author: page.author,
    coverUrl: page.images[0],
    durationMs: 0,
    sourceUrl: link,
    pageUrl,
  }
}

/**
 * Locate the user's lapian resolver: environment first, then the plugin's own
 * config file, then a virtual environment sitting beside the script.
 * @returns the script and interpreter paths, or undefined when not configured.
 */
async function lapianConfig() {
  let stored = {}
  try {
    stored = JSON.parse(await fsp.readFile(path.join(dataDir(), 'lapian.json'), 'utf8'))
  } catch {
    stored = {}
  }
  const script = (process.env.DSH_DWP_LAPIAN ?? '').trim()
    || (typeof stored.script === 'string' ? stored.script.trim() : '')
  if (script === '') return undefined
  const explicit = (process.env.DSH_DWP_PYTHON ?? '').trim()
    || (typeof stored.python === 'string' ? stored.python.trim() : '')
  if (explicit !== '') return { script, python: explicit }
  // The documented layout puts the virtual environment beside the script.
  const local = path.join(path.dirname(script), '.venv', 'Scripts', 'python.exe')
  const exists = await fsp.stat(local).then(() => true).catch(() => false)
  return { script, python: exists ? local : 'python' }
}

/**
 * Run the bridge once and read the single JSON line it prints.
 * @param config - the script and interpreter paths.
 * @param link - the canonical page URL.
 * @param outDir - where the bridge may download.
 * @returns the bridge payload.
 */
function runBridge(config, link, outDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.python, [BRIDGE_PATH, link, '--lapian', config.script, '--out', outDir], {
      cwd: path.dirname(BRIDGE_PATH),
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('拉片脚本超时（240 秒）'))
    }, BRIDGE_TIMEOUT_MS)
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 65536) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 32768) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`拉片脚本起不来：${error.message}`))
    })
    child.on('close', () => {
      clearTimeout(timer)
      const line = stdout.split(/\r?\n/).filter(entry => entry.includes('__DWP_JSON__')).pop()
      if (line === undefined) {
        reject(new Error(stderr.trim().slice(0, 240) || stdout.trim().slice(0, 240) || '拉片脚本没有输出结果'))
        return
      }
      try {
        resolve(JSON.parse(line.slice(line.indexOf('__DWP_JSON__') + '__DWP_JSON__'.length)))
      } catch (error) {
        reject(new Error(`拉片脚本的输出无法解析：${error.message}`))
      }
    })
  })
}

/**
 * Resolve one video through the user's lapian pipeline: playwright drives the
 * system Edge, the page's own API JSON supplies `video.play_addr`, and the CDN
 * bytes are downloaded once. No retry and no fallback happen here.
 * @param link - the share link, kept for the recorded source.
 * @param pageUrl - the canonical page URL.
 * @returns a local-file item ready for import.
 */
async function resolveWithLapian(link, pageUrl) {
  const config = await lapianConfig()
  if (config === undefined) throw new Error('没有配置拉片脚本')
  const staging = path.join(dataDir(), 'staging', `lapian-${Date.now().toString(36)}`)
  await fsp.mkdir(staging, { recursive: true })
  try {
    const result = await runBridge(config, pageUrl === '' ? link : pageUrl, staging)
    if (result.ok !== true) throw new Error(result.reason ?? '拉片脚本没有给出媒体地址')
    const stats = await fsp.stat(String(result.mp4))
    const meta = result.meta ?? {}
    const title = String(meta.title ?? '').replace(/\s*[-–|]\s*抖音\s*$/, '').trim()
    return {
      kind: 'file',
      filePath: String(result.mp4),
      bytes: stats.size,
      title,
      author: '',
      durationMs: typeof meta.duration === 'number' && Number.isFinite(meta.duration)
        ? Math.round(meta.duration * 1000)
        : 0,
      coverUrl: undefined,
      sourceUrl: link,
      provider: 'lapian',
      staging,
      pageUrl,
    }
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/**
 * Fill in whatever a provider did not report from the share text itself, which
 * names the author and usually the caption.
 * @param resolved - the provider's item.
 * @param text - the pasted share text.
 * @returns the item with a title and author.
 */
function withShareMeta(resolved, text) {
  const meta = shareTextMeta(text)
  return {
    ...resolved,
    title: resolved.title === '' ? meta.title : resolved.title,
    author: resolved.author === '' ? meta.author : resolved.author,
  }
}

/**
 * Turn whatever the user pasted into an item: a Douyin share text, a Douyin
 * video or image post, a direct video URL, or an absolute path of a local file.
 * @param input - the pasted text.
 * @returns a resolved item, an image item, or a local file descriptor.
 */
async function resolveInput(input) {
  const text = input.trim()
  if (text === '') throw new Error('先粘贴一条抖音分享链接')
  // A local file: the same panel doubles as a way to try any clip offline.
  if (/\.(mp4|webm|mov|m4v)$/i.test(text) && path.isAbsolute(text)) {
    const stats = await fsp.stat(text).catch(() => undefined)
    if (stats === undefined || !stats.isFile()) throw new Error(`找不到这个文件：${text}`)
    if (stats.size > MAX_MEDIA_BYTES) throw new Error('视频超过 240 MB，换一个小一点的')
    return {
      kind: 'file',
      filePath: text,
      bytes: stats.size,
      title: path.basename(text),
      author: '',
      durationMs: 0,
      coverUrl: undefined,
      sourceUrl: '',
    }
  }
  const links = text.match(/https?:\/\/[^\s"'<>，。、；：！？（）【】「」]+/g) ?? []
  if (links.length === 0) throw new Error('没找到链接：把抖音「分享 → 复制链接」出来的整段文字粘贴进来就行')
  const link = links[0].replace(/[.,;!?]+$/, '')
  let host
  try {
    host = new URL(link).hostname
  } catch {
    throw new Error('链接格式不对')
  }
  // A bare CDN address is usable as-is; everything else must be Douyin.
  if (/\.(mp4|m4v|mov|webm)$/i.test(new URL(link).pathname)) {
    return {
      kind: 'remote',
      urls: [link],
      title: '远程视频',
      author: '',
      durationMs: 0,
      coverUrl: undefined,
      sourceUrl: link,
    }
  }
  if (!/(^|\.)douyin\.com$|(^|\.)iesdouyin\.com$/i.test(host)) {
    throw new Error('这不像抖音链接：目前只认 douyin.com 的分享链接')
  }
  const pageUrl = await followShortLink(link)
  // The same item reached through another short link must not download twice:
  // the canonical page URL identifies it.
  const known = (await readState()).clips.find(clip => clip.pageUrl !== '' && clip.pageUrl === pageUrl)
  if (known !== undefined) {
    return {
      kind: 'existing',
      clipId: known.id,
      pageUrl,
      title: known.title,
      author: known.author,
      durationMs: known.durationMs,
      coverUrl: undefined,
      sourceUrl: link,
    }
  }
  if (isImagePostUrl(pageUrl)) {
    return withShareMeta(await resolveImagePost(link, pageUrl), text)
  }
  // A configured lapian script is the preferred route, and its failures are
  // reported as they are: when the user pointed the plugin at their own
  // pipeline, silently handing the link to a third-party parser would break
  // both that choice and its "失败即停、不重试" rule.
  if (await lapianConfig() !== undefined) {
    try {
      return withShareMeta(await resolveWithLapian(link, pageUrl), text)
    } catch (error) {
      throw new Error(`拉片脚本解析失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return withShareMeta(
    describePayload(await callParseService(process.env.DSH_DWP_PARSE_API ?? DEFAULT_PARSE_API, link), link, pageUrl),
    text,
  )
}

/**
 * Stream a remote body into one file, enforcing the byte ceiling while writing.
 * @param url - the address to download.
 * @param target - the destination file.
 * @param limit - the maximum accepted byte count.
 * @param kind - what the bytes must be: a video or an image.
 * @returns the written byte count.
 */
async function downloadTo(url, target, limit, kind = 'media') {
  const response = await request(url, { timeoutMs: 60000, referer: 'https://www.douyin.com/' })
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
  const type = (response.headers.get('content-type') ?? '').toLowerCase()
  const acceptable = kind === 'image'
    ? /^(image|application\/octet-stream|binary\/octet-stream)/
    : /^(video|application\/octet-stream|binary\/octet-stream)/
  if (type !== '' && !acceptable.test(type)) {
    throw new Error(`下载回来的不是${kind === 'image' ? '图片' : '视频'}（${type}），链接可能已经过期`)
  }
  if (response.body === null) throw new Error('下载响应没有内容')
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > limit) throw new Error('文件太大')
  const handle = await fsp.open(target, 'w')
  let written = 0
  try {
    for await (const chunk of response.body) {
      written += chunk.byteLength
      if (written > limit) throw new Error('文件太大')
      await handle.write(chunk)
    }
  } finally {
    await handle.close()
  }
  if (written < 1024) throw new Error('下载到的文件是空的，链接可能已经过期')
  return written
}

/**
 * Download a cover thumbnail, ignoring every failure: it is decoration only.
 * @param url - the cover address.
 * @param target - the destination file.
 * @returns whether a usable file landed.
 */
async function downloadCover(url, target) {
  try {
    const response = await request(url, { timeoutMs: 15000, referer: 'https://www.douyin.com/' })
    if (!response.ok) return false
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength < 512 || buffer.byteLength > MAX_COVER_BYTES) return false
    await fsp.writeFile(target, buffer)
    return true
  } catch {
    return false
  }
}

/**
 * Read one picture's real format from its first bytes: Douyin serves the same
 * asset as jpeg, png, or webp depending on the transform in the URL.
 * @param filePath - the downloaded file.
 * @returns the extension to store it under.
 */
async function imageExtensionOf(filePath) {
  const handle = await fsp.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(12)
    const { bytesRead } = await handle.read(buffer, 0, 12, 0)
    if (bytesRead >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg'
    if (bytesRead >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
    if (bytesRead >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
    if (bytesRead >= 6 && buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'gif'
    return 'jpg'
  } finally {
    await handle.close()
  }
}

/**
 * Delete one clip's cached bytes, ignoring a file that is already gone or
 * locked: the state is the authority, the cache is expendable.
 * @param id - the clip id.
 */
async function removeClipFiles(id) {
  await fsp.rm(path.join(dirs.media(), `${id}.mp4`), { force: true }).catch(() => {})
  await fsp.rm(path.join(dirs.cover(), `${id}.jpg`), { force: true }).catch(() => {})
  // An image post stores one file per picture, numbered from 1.
  for (let index = 1; index <= MAX_IMAGES; index += 1) {
    for (const extension of ['jpg', 'png', 'webp', 'gif']) {
      await fsp.rm(path.join(dirs.media(), `${id}-${index}.${extension}`), { force: true }).catch(() => {})
    }
  }
}

/**
 * Pull a title and author out of a Douyin share text, which is the most
 * reliable source when a rendered page carries no metadata.
 * @param text - the pasted share text.
 * @returns the author and title, either possibly empty.
 */
function shareTextMeta(text) {
  const withoutLinks = text.replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim()
  const authorMatch = withoutLinks.match(/【([^】]{1,60})】/)
  const author = authorMatch === null ? '' : authorMatch[1].replace(/的(?:图文|视频)?作品$/, '').trim()
  const afterAuthor = authorMatch === null
    ? withoutLinks
    : withoutLinks.slice(withoutLinks.indexOf(authorMatch[0]) + authorMatch[0].length)
  const title = afterAuthor
    .replace(/^\s*(?:复制打开抖音[，,]?\s*)?(?:看看)?/, '')
    .replace(/(?:复制此链接|打开Dou音?搜索|直接观看视频).*$/, '')
    // The share text ends with its own machine-readable code, such as
    // " :4pm 04/29 EUL:/ t@e.Bg"; it is not part of the caption.
    .replace(/\s+[:：]?\d{1,2}\s*[ap]m\b.*$/i, '')
    .replace(/\s+[A-Za-z0-9]{2,}:\/\s*.*$/, '')
    .replace(/^[\s:：,，。]+/, '')
    .trim()
  return { author, title }
}

/**
 * Run one import: resolve the input, copy or download the bytes, then append the
 * clip to the state and make it the active wallpaper.
 * @param input - the pasted text.
 * @returns the updated state.
 */
async function importClip(input) {
  await ensureDirs()
  const resolved = await resolveInput(input)
  // Already cached: select it instead of fetching the same clip again.
  if (resolved.kind === 'existing') {
    const state = await readState()
    if (!state.clips.some(clip => clip.id === resolved.clipId)) {
      throw new Error('这条记录刚刚被删除了，再试一次')
    }
    const selected = { ...state, enabled: true, activeId: resolved.clipId }
    await writeState(selected)
    return selected
  }
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const mediaPath = path.join(dirs.media(), `${id}.mp4`)
  const coverPath = path.join(dirs.cover(), `${id}.jpg`)
  let bytes = 0
  const images = []
  if (resolved.kind === 'file') {
    await fsp.copyFile(resolved.filePath, mediaPath)
    bytes = resolved.bytes
    // The lapian bridge downloads into a staging directory; once the bytes are
    // in the cache, the staging copy is no longer needed.
    if (typeof resolved.staging === 'string') {
      await fsp.rm(resolved.staging, { recursive: true, force: true }).catch(() => {})
    }
  } else if (resolved.kind === 'images') {
    for (const [index, url] of (resolved.imageUrls ?? []).slice(0, MAX_IMAGES).entries()) {
      const temporary = path.join(dirs.media(), `${id}-${index + 1}.part`)
      try {
        bytes += await downloadTo(url, temporary, MAX_IMAGE_BYTES, 'image')
        // The URL's transform decides the real format; store it under that one.
        const extension = await imageExtensionOf(temporary)
        const name = `${id}-${index + 1}.${extension}`
        await fsp.rename(temporary, path.join(dirs.media(), name))
        images.push(name)
      } catch (error) {
        await fsp.rm(temporary, { force: true }).catch(() => {})
        if (images.length === 0) throw error
        // One unreadable picture of an album should not lose the whole album.
        break
      }
    }
    if (images.length === 0) throw new Error('图文作品的图片都没下载下来，链接可能已经过期')
  } else {
    let lastError
    for (const candidate of resolved.urls ?? []) {
      try {
        bytes = await downloadTo(candidate, mediaPath, MAX_MEDIA_BYTES, 'video')
        lastError = undefined
        break
      } catch (error) {
        lastError = error
        await fsp.rm(mediaPath, { force: true })
      }
    }
    if (lastError !== undefined) throw lastError
  }
  const hasCover = resolved.coverUrl === undefined
    ? images.length > 0
    : await downloadCover(resolved.coverUrl, coverPath)
  const state = await readState()
  const clip = {
    id,
    pageUrl: resolved.pageUrl ?? '',
    kind: images.length > 0 ? 'images' : 'video',
    images,
    title: resolved.title ?? '',
    author: resolved.author ?? '',
    durationMs: resolved.durationMs ?? 0,
    bytes,
    hasCover: hasCover || images.length > 0,
    createdAt: Date.now(),
    sourceUrl: resolved.sourceUrl ?? '',
  }
  const ordered = [clip, ...state.clips]
  const next = {
    ...state,
    enabled: true,
    activeId: id,
    clips: ordered.slice(0, 40),
  }
  await writeState(next)
  // The cap must not leave unreachable media behind: evict the dropped files.
  for (const evicted of ordered.slice(40)) await removeClipFiles(evicted.id)
  return next
}

// ------------------------------------------------------------------ responses

/**
 * Answer with JSON.
 * @param res - the response.
 * @param status - HTTP status.
 * @param body - JSON value.
 */
function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/**
 * Answer with one error object the panel can render verbatim.
 * @param res - the response.
 * @param status - HTTP status.
 * @param message - human-readable reason.
 */
function sendError(res, status, message) {
  sendJson(res, status, { ok: false, code: 'error', message })
}

/**
 * Read a bounded JSON request body.
 * @param req - the request.
 * @returns the parsed body, or undefined when it is too large or not JSON.
 */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Serve a cached media file with Range support, so `<video>` can stream, seek,
 * and loop without downloading the whole clip first.
 * @param req - the request.
 * @param res - the response.
 * @param filePath - the file to serve.
 * @param contentType - its media type.
 */
async function serveFile(req, res, filePath, contentType) {
  let stats
  try {
    stats = await fsp.stat(filePath)
  } catch {
    sendError(res, 404, 'not-found')
    return
  }
  if (!stats.isFile()) {
    sendError(res, 404, 'not-found')
    return
  }
  const total = stats.size
  const range = req.headers.range
  const headers = {
    'content-type': contentType,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=86400',
  }
  if (typeof range === 'string') {
    const match = range.match(/^bytes=(\d*)-(\d*)$/)
    if (match !== null) {
      let start = match[1] === '' ? undefined : Number(match[1])
      let end = match[2] === '' ? undefined : Number(match[2])
      if (start === undefined && end !== undefined) {
        // A suffix range: the last N bytes.
        start = Math.max(0, total - end)
        end = total - 1
      }
      start = start ?? 0
      end = end === undefined ? total - 1 : Math.min(end, total - 1)
      if (start >= total || start > end) {
        res.statusCode = 416
        res.setHeader('content-range', `bytes */${total}`)
        res.end()
        return
      }
      res.writeHead(206, {
        ...headers,
        'content-range': `bytes ${start}-${end}/${total}`,
        'content-length': end - start + 1,
      })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      pipeBody(res, createReadStream(filePath, { start, end }))
      return
    }
  }
  res.writeHead(200, { ...headers, 'content-length': total })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  pipeBody(res, createReadStream(filePath))
}

/**
 * Pipe a file stream into the response, closing the response if the read fails
 * after the headers are gone.
 * @param res - the response.
 * @param stream - the file stream.
 */
function pipeBody(res, stream) {
  stream.on('error', () => {
    if (res.headersSent) res.destroy?.()
    else res.end()
  })
  stream.pipe(res)
}

// --------------------------------------------------------------------- routes

/**
 * Reject a request that does not come from this page (DNS rebinding and other
 * cross-origin callers), the way the shipped routes do.
 * @param ctx - the plugin context.
 * @param req - the request.
 * @returns an HTTP status to answer with, or undefined to continue.
 */
function rejectionOf(ctx, req) {
  const connection = ctx.get('connection')
  if (connection === undefined || typeof connection.requestRejection !== 'function') return undefined
  try {
    const rejection = connection.requestRejection(req)
    return typeof rejection === 'number' ? rejection : undefined
  } catch {
    return undefined
  }
}

/**
 * Dispatch one request under the plugin's prefix.
 * @param ctx - the plugin context.
 * @param req - the request.
 * @param res - the response.
 */
async function handle(ctx, req, res) {
  const rejection = rejectionOf(ctx, req)
  if (rejection !== undefined) {
    res.statusCode = rejection
    res.end()
    return
  }
  const url = new URL(String(req.url ?? '/'), 'http://localhost')
  const rest = url.pathname.slice(ROUTE.length).replace(/^\/+/, '').replace(/\/+$/, '')
  const method = req.method ?? 'GET'
  try {
    if (rest === 'state' && method === 'GET') {
      sendJson(res, 200, { ok: true, state: await readState() })
      return
    }
    if (rest === 'import' && method === 'POST') {
      const body = await readJson(req)
      if (body === undefined || typeof body.text !== 'string') {
        sendError(res, 400, '请求内容不对')
        return
      }
      const state = await importClip(body.text)
      sendJson(res, 200, { ok: true, state })
      return
    }
    if (rest === 'settings' && method === 'POST') {
      const body = await readJson(req)
      if (body === undefined) {
        sendError(res, 400, '请求内容不对')
        return
      }
      const state = await readState()
      const next = normalizeState({ ...state, settings: { ...state.settings, ...(body.settings ?? {}) } })
      next.enabled = state.enabled
      next.activeId = state.activeId
      next.clips = state.clips
      await writeState(next)
      sendJson(res, 200, { ok: true, state: next })
      return
    }
    if (rest === 'activate' && method === 'POST') {
      const body = await readJson(req)
      const id = typeof body?.id === 'string' ? body.id : undefined
      if (id === undefined) {
        sendError(res, 400, '请求内容不对')
        return
      }
      const state = await readState()
      if (!state.clips.some(clip => clip.id === id)) {
        sendError(res, 404, '这个壁纸已经不在了')
        return
      }
      const next = { ...state, activeId: id, enabled: true }
      await writeState(next)
      sendJson(res, 200, { ok: true, state: next })
      return
    }
    if (rest === 'toggle' && method === 'POST') {
      const body = await readJson(req)
      const state = await readState()
      const next = { ...state, enabled: typeof body?.enabled === 'boolean' ? body.enabled : !state.enabled }
      await writeState(next)
      sendJson(res, 200, { ok: true, state: next })
      return
    }
    if (rest === 'remove' && method === 'POST') {
      const body = await readJson(req)
      const id = typeof body?.id === 'string' ? body.id : undefined
      if (id === undefined) {
        sendError(res, 400, '请求内容不对')
        return
      }
      const state = await readState()
      const next = normalizeState({
        ...state,
        clips: state.clips.filter(clip => clip.id !== id),
        activeId: state.activeId === id ? null : state.activeId,
      })
      await writeState(next)
      await removeClipFiles(id)
      sendJson(res, 200, { ok: true, state: next })
      return
    }
    if (rest.startsWith('media/') && (method === 'GET' || method === 'HEAD')) {
      const name = rest.slice('media/'.length)
      if (!/^[a-z0-9-]+\.(mp4|jpg|png|webp|gif)$/i.test(name)) {
        sendError(res, 400, 'bad id')
        return
      }
      const extension = (name.match(/\.([a-z0-9]+)$/i) ?? [, ''])[1].toLowerCase()
      const types = { mp4: 'video/mp4', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }
      await serveFile(req, res, path.join(dirs.media(), name), types[extension] ?? 'application/octet-stream')
      return
    }
    if (rest.startsWith('cover/') && (method === 'GET' || method === 'HEAD')) {
      const id = rest.slice('cover/'.length).replace(/\.jpg$/i, '')
      if (!/^[a-z0-9]+$/i.test(id)) {
        sendError(res, 400, 'bad id')
        return
      }
      await serveFile(req, res, path.join(dirs.cover(), `${id}.jpg`), 'image/jpeg')
      return
    }
    sendError(res, 404, `未知接口：${method} ${rest === '' ? '/' : rest}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn('[douyin-wallpaper] request failed:', message)
    if (!res.headersSent) sendError(res, 500, message)
    else res.end()
  }
}

/** The Host half needs only the browser HTTP carrier. */
export const inject = ['webServer']

/**
 * Register the plugin's routes for this page's lifetime.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  // Create the cache directory at activation, so a permission problem surfaces
  // here instead of on the first import, and the panel can read an empty state.
  void ensureDirs().catch((error) => {
    console.warn('[douyin-wallpaper] cannot create the cache directory:', error?.message)
  })
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: (req, res) => handle(ctx, req, res) }),
    'douyin-wallpaper: routes',
  )
}

