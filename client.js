/**
 * Browser half of the Douyin wallpaper bundle.
 *
 * Turns the minimal Harness interface into a playback surface: the clip sits in
 * a full-window layer behind the app, and the interface's own background tokens
 * are re-pointed at translucent versions of themselves, so every column, card
 * and sidebar keeps its place and only its opacity changes.
 *
 * Three pieces:
 *
 *  1. a stage element (`#dwp-stage`) prepended to the document body, holding the
 *     `<video>` and a dimming veil — the only way to sit *behind* the shell,
 *     since every Slot renders above the frame's columns;
 *  2. a look function that writes translucent token values onto `body` inline,
 *     which outranks the theme's own declarations and is removed again when the
 *     wallpaper is off, so the stock interface returns exactly;
 *  3. one trigger beside Settings in the sidebar foot and one floating panel.
 *
 * The video bytes and the persisted state come from the Host half over a
 * same-origin prefix route; this module never calls a model or a Tool.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-douyin-wallpaper',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'douyin-wallpaper'
    const ROUTE = '/dsh-douyin-wallpaper'

    // ---------------------------------------------------------------- locale

    const zh = {
      'trigger.label': '抖音壁纸',
      'trigger.empty': '抖音壁纸 · 粘贴分享链接',
      'trigger.on': '壁纸播放中',
      'trigger.off': '壁纸已关闭',
      'msg.sep': '：',
      'panel.title': '抖音壁纸',
      'panel.close': '关闭面板',
      'panel.placeholder': '粘贴抖音分享链接，或本地视频的完整路径',
      'panel.apply': '应用',
      'panel.applying': '解析中…',
      'panel.empty': '还没有壁纸。粘一条抖音分享链接，回车即可。',
      'panel.remove': '删除这个壁纸',
      'panel.section.look': '界面',
      'panel.section.picture': '画面',
      'panel.section.play': '播放',
      'panel.glass': '玻璃浓度',
      'panel.blur': '模糊',
      'panel.dim': '暗化',
      'panel.brightness': '亮度',
      'panel.scale': '缩放',
      'panel.muted': '静音',
      'panel.loop': '循环',
      'panel.volume': '音量',
      'panel.enabled': '启用壁纸',
      'panel.hint': '视频铺满窗口，界面半透明叠在上面。拖滑块即时生效，设置存在本机。链接会发给第三方解析接口换取直链，视频只下到本机。',
      'status.imported': '已换上新壁纸',
      'status.busy': '正在下载视频…',
      'status.failed': '没能用上这条链接',
      'status.autoplay': '浏览器拦了自动播放，切一次「启用壁纸」重试',
      'status.readState': '读取壁纸状态失败',
    }

    const en = {
      'trigger.label': 'Douyin wallpaper',
      'trigger.empty': 'Douyin wallpaper · paste a link',
      'trigger.on': 'Wallpaper playing',
      'trigger.off': 'Wallpaper off',
      'msg.sep': ': ',
      'panel.title': 'Douyin wallpaper',
      'panel.close': 'Close panel',
      'panel.placeholder': 'Paste a Douyin share link, or a local video path',
      'panel.apply': 'Apply',
      'panel.applying': 'Resolving…',
      'panel.empty': 'No wallpaper yet. Paste a Douyin share link and press Enter.',
      'panel.remove': 'Remove this wallpaper',
      'panel.section.look': 'Interface',
      'panel.section.picture': 'Picture',
      'panel.section.play': 'Playback',
      'panel.glass': 'Glass',
      'panel.blur': 'Blur',
      'panel.dim': 'Dim',
      'panel.brightness': 'Brightness',
      'panel.scale': 'Scale',
      'panel.muted': 'Muted',
      'panel.loop': 'Loop',
      'panel.volume': 'Volume',
      'panel.enabled': 'Wallpaper on',
      'panel.hint': 'The clip fills the window and the interface floats on top. Sliders apply instantly and the settings stay on this machine. The link goes to a third-party parse service for a direct address; only the video is downloaded here.',
      'status.imported': 'New wallpaper applied',
      'status.busy': 'Downloading the clip…',
      'status.failed': 'That link did not work',
      'status.autoplay': 'The browser blocked autoplay; toggle "Wallpaper on" once',
      'status.readState': 'Could not read the wallpaper state',
    }

    // ----------------------------------------------------------------- store

    /**
     * One module-level store for the whole surface: slot components come and go
     * (sidebar collapse, panel close), the stage and the video must not.
     */
    const ui = {
      /** Host state: { enabled, activeId, settings, clips }, or null while loading. */
      state: null,
      /** Whether the floating panel is open. */
      open: false,
      /** True while one import is in flight. */
      busy: false,
      /** Draft text in the link field. */
      draft: '',
      /** Last notice: { tone: 'ok' | 'warn' | 'error', key?: string, text?: string }. */
      message: null,
      /** Whether the stage is currently showing anything. */
      playing: false,
    }

    const listeners = new Set()

    /**
     * Merge a patch into the store and notify every subscriber.
     * @param patch - changed fields.
     */
    function setUi(patch) {
      let changed = false
      for (const key of Object.keys(patch)) {
        if (ui[key] !== patch[key]) {
          ui[key] = patch[key]
          changed = true
        }
      }
      if (!changed) return
      for (const listener of listeners) listener()
    }

    /** @param listener - called on every store change. @returns its unsubscribe. */
    function subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }

    /**
     * Subscribe one component to a slice of the store.
     * @param select - pure selector returning a primitive or a stable reference.
     * @returns the selected value.
     */
    function useUi(select) {
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(subscribe, () => select(ui), () => select(ui))
      }
      const [value, setValue] = React.useState(() => select(ui))
      React.useEffect(() => subscribe(() => { setValue(select(ui)) }), [])
      return value
    }

    // ------------------------------------------------------------------- api

    /**
     * Call one Host route.
     * @param path - path under the plugin prefix.
     * @param body - JSON body for a POST, omitted for a GET.
     * @returns the parsed reply; throws with the Host's own message on failure.
     */
    async function call(path, body) {
      // A stalled route must not leave the panel stuck in its busy state, so the
      // whole exchange is bounded well above the Host's own worst case.
      const signal = AbortSignal.timeout(180000)
      const init = body === undefined
        ? { headers: { accept: 'application/json' }, signal }
        : {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
          signal,
        }
      const response = await fetch(`${ROUTE}${path}`, init)
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
        throw new Error(payload?.message ?? `HTTP ${response.status}`)
      }
      return payload
    }

    // --------------------------------------------------------------- defaults

    /** Look defaults, mirrored from the Host so the panel renders before a reply. */
    const DEFAULT_SETTINGS = {
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

    /**
     * A usable empty state, so a failed first read still leaves every control
     * reachable instead of a panel that pretends to be downloading forever.
     * @returns a state shaped like the Host's, with no clip.
     */
    function emptyState() {
      return { version: 1, enabled: false, activeId: null, settings: { ...DEFAULT_SETTINGS }, clips: [] }
    }

    /**
     * The clip a state currently points at.
     * @param state - the wallpaper state.
     * @returns the clip, or undefined.
     */
    function activeClipOf(state) {
      if (state === null || state === undefined) return undefined
      return state.clips.find(clip => clip.id === state.activeId)
    }

    /**
     * Whether one state should paint the wallpaper right now: it must be enabled
     * *and* have a clip, so a fresh install never tints the interface for nothing.
     * @param state - the wallpaper state.
     * @returns true when a clip should be on screen.
     */
    function isLive(state) {
      return state !== null && state !== undefined && state.enabled === true && activeClipOf(state) !== undefined
    }

    /**
     * Turn one notice into display text.
     * @param message - { tone, key?, text?, detail? }.
     * @param t - locale seat.
     * @returns the sentence to show.
     */
    function noticeText(message, t) {
      const head = message.key === undefined ? (message.text ?? '') : t(message.key)
      return message.detail === undefined ? head : `${head}${t('msg.sep')}${message.detail}`
    }

    /**
     * Trim one clip title to a single readable line for a notice.
     * @param title - the raw title.
     * @returns at most 42 characters.
     */
    function shortTitle(title) {
      const text = String(title ?? '').replace(/\s+/g, ' ').trim()
      return text.length > 42 ? `${text.slice(0, 42)}…` : text
    }

    // ----------------------------------------------------------------- stage

    const STYLE = `
      #dwp-stage {
        position: fixed;
        inset: 0;
        z-index: -1;
        overflow: hidden;
        pointer-events: none;
        opacity: 0;
        background: var(--dwp-canvas, #0b0b0d);
        transition: opacity 520ms ease;
      }
      #dwp-stage[data-on='1'] { opacity: 1; }
      #dwp-stage > video {
        position: absolute;
        top: 50%;
        left: 50%;
        width: 100%;
        height: 100%;
        object-fit: cover;
        transform: translate(-50%, -50%) scale(var(--dwp-scale, 1));
        transform-origin: center;
      }
      #dwp-stage[data-mode='images'] > video { display: none; }
      #dwp-slides {
        position: absolute;
        inset: 0;
        display: none;
      }
      #dwp-stage[data-mode='images'] #dwp-slides { display: block; }
      #dwp-slides img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        opacity: 0;
        transform: scale(var(--dwp-scale, 1));
        transform-origin: center;
        transition: opacity 1100ms ease;
        animation: dwp-drift 32s ease-in-out infinite alternate;
      }
      #dwp-slides img[data-show='1'] { opacity: 1; }
      @keyframes dwp-drift {
        from { scale: 1; }
        to { scale: 1.07; }
      }
      @media (prefers-reduced-motion: reduce) {
        #dwp-slides img { animation: none; transition: none; }
      }
      #dwp-veil {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, var(--dwp-dim, 0.28));
      }

      .dwp-icon {
        display: inline-flex;
        width: 28px;
        height: 28px;
        flex: none;
        align-items: center;
        justify-content: center;
        border: none;
        border-radius: var(--dsw-radius-sm);
        padding: 0;
        background: transparent;
        color: var(--dsw-alias-label-secondary);
        cursor: pointer;
      }
      @media (hover: hover) {
        .dwp-icon:hover { background-color: var(--dsw-alias-interactive-bg-hover); }
      }
      .dwp-icon:focus-visible {
        outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-alias-state-business-primary, currentColor);
        outline-offset: -2px;
      }
      .dwp-icon[data-playing='1'] { color: var(--dsw-alias-brand-primary); }
      .dwp-icon[data-open='1'] { background-color: var(--dsw-alias-interactive-bg-hover); }

      .dwp-panel {
        position: fixed;
        left: 68px;
        bottom: 56px;
        z-index: 60;
        display: flex;
        flex-direction: column;
        width: 326px;
        max-height: min(74vh, 620px);
        border-radius: var(--dsw-radius-lg);
        border: 1px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-overlay);
        color: var(--dsw-alias-label-primary);
        box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
        backdrop-filter: blur(18px) saturate(1.3);
        -webkit-backdrop-filter: blur(18px) saturate(1.3);
        overflow: hidden;
        font-size: 13px;
      }
      .dwp-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 10px 8px 14px;
        border-bottom: 1px solid var(--dsw-alias-border-l1);
      }
      .dwp-title { flex: 1; font-weight: 500; }
      .dwp-body {
        overflow-y: auto;
        padding: 12px 14px 14px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .dwp-form { display: flex; gap: 6px; }
      .dwp-input {
        flex: 1;
        min-width: 0;
        height: 30px;
        padding: 0 9px;
        border-radius: var(--dsw-radius-sm);
        border: 1px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-layer-2);
        color: inherit;
        font: inherit;
        font-size: 12.5px;
      }
      .dwp-input::placeholder { color: var(--dsw-alias-label-tertiary); }
      .dwp-input:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }
      .dwp-apply {
        flex: none;
        height: 30px;
        padding: 0 12px;
        border-radius: var(--dsw-radius-sm);
        border: 1px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-layer-1);
        color: inherit;
        font: inherit;
        font-size: 12.5px;
        cursor: pointer;
      }
      .dwp-apply:disabled { opacity: 0.55; cursor: default; }
      @media (hover: hover) {
        .dwp-apply:not(:disabled):hover { background: var(--dsw-alias-interactive-bg-hover); }
      }
      .dwp-msg {
        display: flex;
        gap: 6px;
        align-items: flex-start;
        max-height: 76px;
        overflow-y: auto;
        padding: 7px 9px;
        border-radius: var(--dsw-radius-sm);
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-secondary);
        font-size: 12px;
        line-height: 17px;
        word-break: break-word;
      }
      .dwp-msg[data-tone='error'] { color: var(--dsw-alias-state-error-primary); }
      .dwp-msg[data-tone='ok'] { color: var(--dsw-alias-state-success-primary); }
      .dwp-clips { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 2px; }
      .dwp-clip {
        position: relative;
        flex: none;
        width: 68px;
        height: 92px;
        border-radius: var(--dsw-radius-sm);
        border: 1px solid var(--dsw-alias-border-l1);
        background-color: var(--dsw-alias-bg-layer-2);
        background-size: cover;
        background-position: center;
        color: var(--dsw-alias-label-secondary);
        overflow: hidden;
      }
      .dwp-clip[data-active='1'] {
        border-color: var(--dsw-alias-brand-primary);
        box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary);
      }
      .dwp-clipOpen {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: none;
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
      }
      .dwp-clipOpen:focus-visible {
        outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-alias-brand-primary);
        outline-offset: -2px;
      }
      .dwp-clipGlyph {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 16px;
        opacity: 0.45;
      }
      .dwp-clipDel {
        position: absolute;
        top: 3px;
        right: 3px;
        width: 18px;
        height: 18px;
        padding: 0;
        border: none;
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.55);
        color: #fff;
        font-size: 10px;
        line-height: 18px;
        cursor: pointer;
        opacity: 0;
        transition: opacity 120ms ease;
      }
      .dwp-clip:hover .dwp-clipDel,
      .dwp-clip:focus-within .dwp-clipDel { opacity: 1; }
      .dwp-empty {
        padding: 12px 2px;
        color: var(--dsw-alias-label-tertiary);
        font-size: 12px;
        line-height: 18px;
      }
      .dwp-section { display: flex; flex-direction: column; gap: 4px; }
      .dwp-sectionTitle {
        font-size: 11px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--dsw-alias-label-tertiary);
      }
      .dwp-row { display: flex; align-items: center; gap: 10px; min-height: 26px; }
      .dwp-rowLabel { flex: none; width: 72px; color: var(--dsw-alias-label-secondary); }
      .dwp-rowValue {
        flex: none;
        width: 40px;
        text-align: right;
        color: var(--dsw-alias-label-tertiary);
        font-variant-numeric: tabular-nums;
        font-size: 12px;
      }
      .dwp-slider {
        flex: 1;
        min-width: 0;
        height: 18px;
        accent-color: var(--dsw-alias-brand-primary);
        cursor: pointer;
      }
      .dwp-switch {
        position: relative;
        flex: none;
        width: 36px;
        height: 20px;
        padding: 0;
        border-radius: 10px;
        border: 1px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-layer-2);
        cursor: pointer;
        transition: background 140ms ease, border-color 140ms ease;
      }
      .dwp-switch[data-on='1'] {
        background: var(--dsw-alias-brand-primary);
        border-color: var(--dsw-alias-brand-primary);
      }
      .dwp-switch:focus-visible {
        outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-alias-state-business-primary, currentColor);
        outline-offset: 2px;
      }
      .dwp-knob {
        position: absolute;
        top: 2px;
        left: 2px;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: var(--dsw-alias-bg-base);
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
        transition: transform 140ms ease;
      }
      .dwp-switch[data-on='1'] .dwp-knob { transform: translateX(16px); }
      .dwp-hint { color: var(--dsw-alias-label-tertiary); font-size: 11.5px; line-height: 16px; }
    `

    /**
     * Token overrides: `[property, weight of the glass slider, alpha floor]`.
     *
     * The frame background keeps a low weight so the clip shows its own color;
     * the surfaces that actually carry text (sidebar, cards, inputs) take the
     * slider almost directly. Legibility comes from the blur of the wallpaper
     * plus those surfaces — not from washing the picture out.
     */
    const TOKEN_PLAN = [
      ['--dsw-alias-bg-base', 0.62, 0],
      ['--dsw-specific-sidebar-fill', 0.95, 0],
      ['--dsw-alias-bg-layer-1', 1.1, 0],
      ['--dsw-alias-bg-layer-2', 1.25, 0],
      ['--dsw-alias-bg-layer-3', 1.4, 0],
      ['--dsw-specific-input-major', 1.3, 0],
      ['--dsw-alias-bg-overlay', 1.15, 0.88],
    ]

    let stage
    let video
    let veil
    let slides
    let slideFrames = []
    let slideTimer
    let slideIndex = 0
    let paletteObserver
    let removeStyle

    /** How long one image of an image post stays on screen. */
    const SLIDE_MS = 7000

    /** Build the background layer: one fixed stage with the video, the image pair, and the veil. */
    function mountStage() {
      if (stage !== undefined || document.body === null) return
      stage = document.createElement('div')
      stage.id = 'dwp-stage'
      stage.setAttribute('aria-hidden', 'true')
      stage.dataset.on = '0'
      stage.dataset.mode = 'video'
      veil = document.createElement('div')
      veil.id = 'dwp-veil'
      video = document.createElement('video')
      video.playsInline = true
      video.preload = 'auto'
      video.loop = true
      video.muted = true
      video.setAttribute('disablepictureinpicture', '')
      video.setAttribute('tabindex', '-1')
      // Two frames are enough for a crossfade, and only two pictures decode at
      // a time however many the album holds.
      slides = document.createElement('div')
      slides.id = 'dwp-slides'
      slideFrames = [0, 1].map(() => {
        const frame = document.createElement('img')
        frame.alt = ''
        frame.decoding = 'async'
        frame.dataset.show = '0'
        slides.append(frame)
        return frame
      })
      stage.append(video, slides, veil)
      document.body.prepend(stage)
    }

    /** Remove the background layer, its styles, and the token overrides. */
    function unmountStage() {
      paletteObserver?.disconnect()
      paletteObserver = undefined
      if (slideTimer !== undefined) {
        clearInterval(slideTimer)
        slideTimer = undefined
      }
      stage?.remove()
      stage = undefined
      video = undefined
      veil = undefined
      slides = undefined
      slideFrames = []
      removeStyle?.()
      removeStyle = undefined
      applyLook(undefined)
    }

    /** @returns whether the document currently uses the dark palette. */
    function isDark() {
      return document.body !== null && document.body.hasAttribute('data-ds-dark-theme')
    }

    /** @returns the theme color the glass is mixed from in the active palette. */
    function scrimToken() {
      return isDark()
        ? 'var(--dsw-static-neutral-bluish-950)'
        : 'var(--dsw-static-neutral-bluish-00)'
    }

    /**
     * Re-point the interface's background tokens at translucent versions of the
     * active theme color, so the video shows through every surface. `glass` = 1
     * restores the stock opacity.
     * @param settings - the look settings, or undefined to restore the theme.
     */
    function applyLook(settings) {
      const body = document.body
      if (body === null) return
      const root = document.documentElement
      if (settings === undefined) {
        for (const [token] of TOKEN_PLAN) body.style.removeProperty(token)
        body.style.removeProperty('background-color')
        root.style.removeProperty('background-color')
        if (stage !== undefined) stage.style.removeProperty('--dwp-canvas')
        return
      }
      const scrim = scrimToken()
      const base = Math.min(1, Math.max(0.05, settings.glass))
      for (const [token, weight, floor] of TOKEN_PLAN) {
        const alpha = Math.min(1, Math.max(floor, base * weight))
        body.style.setProperty(token, `color-mix(in srgb, ${scrim} ${Math.round(alpha * 100)}%, transparent)`)
      }
      // The body itself paints the base token; its own layer stays clear so the
      // stage behind it is what the transparent frame reveals.
      body.style.setProperty('background-color', 'transparent')
      root.style.setProperty('background-color', scrim)
      if (stage !== undefined) stage.style.setProperty('--dwp-canvas', scrim)
    }

    /**
     * Push picture settings onto the stage, the video, and the image frames.
     * @param state - the current wallpaper state.
     */
    function applyPicture(state) {
      if (stage === undefined || video === undefined || veil === undefined) return
      const settings = state?.settings
      if (settings === undefined) return
      video.style.filter = `blur(${settings.blur}px) brightness(${settings.brightness}) contrast(${settings.contrast}) saturate(${settings.saturation})`
      video.style.setProperty('--dwp-scale', String(settings.scale))
      veil.style.setProperty('--dwp-dim', String(settings.dim))
      video.muted = settings.muted
      video.volume = settings.muted ? 0 : settings.volume
      video.loop = settings.loop
      const filter = `blur(${settings.blur}px) brightness(${settings.brightness}) contrast(${settings.contrast}) saturate(${settings.saturation})`
      for (const frame of slideFrames) {
        frame.style.filter = filter
        frame.style.setProperty('--dwp-scale', String(settings.scale))
      }
    }

    /** Stop the image slideshow and forget its rotation. */
    function stopSlides() {
      if (slideTimer !== undefined) {
        clearInterval(slideTimer)
        slideTimer = undefined
      }
      slideIndex = 0
      for (const frame of slideFrames) frame.dataset.show = '0'
    }

    /**
     * Put one picture on the front frame and fade it in.
     * @param url - the picture address.
     */
    function showSlide(url) {
      const back = slideFrames[0]
      const front = slideFrames[1]
      const next = back.dataset.show === '1' ? front : back
      const previous = next === front ? back : front
      next.src = url
      next.dataset.show = '1'
      previous.dataset.show = '0'
    }

    /**
     * Run an image post as a slow slideshow; a single picture simply drifts.
     * @param clip - the active clip.
     */
    function startSlideshow(clip) {
      if (stage === undefined || slides === undefined) return
      const urls = (clip.images ?? []).map(name => `${ROUTE}/media/${name}`)
      if (urls.length === 0) {
        stage.dataset.on = '0'
        setUi({ playing: false })
        return
      }
      stage.dataset.mode = 'images'
      stage.dataset.on = '1'
      stopSlides()
      showSlide(urls[0])
      setUi({ playing: true })
      if (urls.length > 1) {
        slideTimer = setInterval(() => {
          slideIndex = (slideIndex + 1) % urls.length
          showSlide(urls[slideIndex])
        }, SLIDE_MS)
      }
    }

    /**
     * Point the stage at the active clip, or hide it.
     * @param state - the current wallpaper state.
     */
    function applyMedia(state) {
      if (stage === undefined || video === undefined) return
      const clip = state?.clips?.find(entry => entry.id === state.activeId)
      const wanted = state?.enabled === true && clip !== undefined
      if (!wanted) {
        video.pause()
        stopSlides()
        stage.dataset.on = '0'
        setUi({ playing: false })
        return
      }
      if (clip.kind === 'images') {
        video.pause()
        stage.dataset.mode = 'images'
        if (stage.dataset.clip !== clip.id) {
          stage.dataset.clip = clip.id
          stage.dataset.on = '1'
          startSlideshow(clip)
        }
        stage.dataset.on = '1'
        return
      }
      stopSlides()
      stage.dataset.mode = 'video'
      stage.dataset.clip = ''
      if (video.dataset.clip !== clip.id) {
        video.dataset.clip = clip.id
        video.src = `${ROUTE}/media/${clip.id}.mp4`
        video.load()
      }
      stage.dataset.on = '1'
      setUi({ playing: true })
      startPlayback()
    }

    /** Start playback, tolerating a browser that refuses to autoplay. */
    function startPlayback() {
      if (video === undefined) return
      const started = video.play()
      if (started === undefined || typeof started.then !== 'function') return
      started.then(() => {
        // A later successful start makes an earlier autoplay warning untrue.
        if (ui.message !== null && ui.message.key === 'status.autoplay') {
          setUi({ message: null, playing: true })
        }
      }).catch(() => {
        setUi({ message: { tone: 'warn', key: 'status.autoplay' }, playing: false })
      })
    }

    /**
     * Reconcile every surface with one state object.
     * @param state - the wallpaper state, or null while loading.
     */
    function sync(state) {
      if (state === null) {
        applyLook(undefined)
        if (stage !== undefined) stage.dataset.on = '0'
        return
      }
      applyLook(isLive(state) ? state.settings : undefined)
      applyPicture(state)
      applyMedia(state)
    }

    // ------------------------------------------------------------- components

    /** The 16px video glyph, drawn to sit beside the sidebar's own icons. */
    function TriggerIcon() {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
      },
      h('rect', {
        x: 1.75, y: 3.25, width: 12.5, height: 9.5, rx: 2.25,
        stroke: 'currentColor', strokeWidth: 1.3,
      }),
      h('path', { d: 'M6.6 6.1 10.4 8l-3.8 1.9Z', fill: 'currentColor' }))
    }

    /**
     * Sidebar-foot trigger: one icon button beside Settings.
     * @param props - slot props carrying the locale seat.
     * @returns the button.
     */
    function Trigger({ t }) {
      const open = useUi(store => store.open)
      const playing = useUi(store => store.playing)
      const count = useUi(store => (store.state === null ? 0 : store.state.clips.length))
      // Before anything is installed the tooltip states the purpose, not a state.
      const title = count === 0 ? t('trigger.empty') : t(playing ? 'trigger.on' : 'trigger.off')
      return h('button', {
        type: 'button',
        className: 'dwp-icon',
        'data-dwp-trigger': '',
        'data-playing': playing ? '1' : '0',
        'data-open': open ? '1' : '0',
        'aria-label': t('trigger.label'),
        'aria-expanded': open,
        title,
        onClick: () => { setUi({ open: !ui.open }) },
      }, h(TriggerIcon))
    }

    /**
     * One labelled slider row.
     * @param props - label, value, bounds, step, value formatter, change handler.
     * @returns the row.
     */
    function SliderRow({ label, value, min, max, step, format, onChange }) {
      return h('div', { className: 'dwp-row' },
        h('span', { className: 'dwp-rowLabel' }, label),
        h('input', {
          className: 'dwp-slider',
          type: 'range',
          min, max, step,
          value,
          'aria-label': label,
          onChange: event => { onChange(Number(event.target.value)) },
        }),
        h('span', { className: 'dwp-rowValue' }, format(value)))
    }

    /**
     * One switch row: a real `role="switch"` button with a text label.
     * @param props - label, checked, change handler.
     * @returns the row.
     */
    function SwitchRow({ label, checked, onChange }) {
      return h('div', { className: 'dwp-row' },
        h('span', { className: 'dwp-rowLabel' }, label),
        h('button', {
          type: 'button',
          className: 'dwp-switch',
          role: 'switch',
          'aria-checked': checked,
          'aria-label': label,
          'data-on': checked ? '1' : '0',
          onClick: () => { onChange(!checked) },
        }, h('span', { className: 'dwp-knob' })))
    }

    /**
     * Settings writer: applies locally at once (so a dragged slider never lags),
     * then persists the accumulated patch behind one short debounce.
     * @returns the writer.
     */
    function useSettingsWriter() {
      const timer = React.useRef(undefined)
      const pending = React.useRef({})
      React.useEffect(() => () => {
        if (timer.current !== undefined) clearTimeout(timer.current)
      }, [])
      return React.useCallback((patch) => {
        const state = ui.state
        if (state === null) return
        const next = { ...state, settings: { ...state.settings, ...patch } }
        setUi({ state: next })
        applyLook(isLive(next) ? next.settings : undefined)
        applyPicture(next)
        pending.current = { ...pending.current, ...patch }
        if (timer.current !== undefined) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          const settings = pending.current
          pending.current = {}
          call('/settings', { settings }).catch(() => {})
        }, 220)
      }, [])
    }

    /**
     * The floating control panel: link field, clip strip, and the sliders that
     * shape both the picture and the interface above it.
     * @param props - slot props carrying the locale seat.
     * @returns the panel, or null while closed.
     */
    function Panel({ t }) {
      const open = useUi(store => store.open)
      if (!open) return null
      return h(PanelBody, { t })
    }

    function PanelBody({ t }) {
      const state = useUi(store => store.state)
      const busy = useUi(store => store.busy)
      const draft = useUi(store => store.draft)
      const message = useUi(store => store.message)
      const write = useSettingsWriter()
      const root = React.useRef(null)

      // Close on Escape, and on a pointer press that lands outside the panel.
      // The trigger opts out by attribute: it owns the toggle itself.
      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          setUi({ open: false })
          // Escape came from the keyboard: put the caret back on the entrance.
          const trigger = document.querySelector('[data-dwp-trigger]')
          if (trigger instanceof HTMLElement) trigger.focus()
        }
        const onPointerDown = (event) => {
          const target = event.target
          if (!(target instanceof Node)) return
          if (root.current !== null && root.current.contains(target)) return
          if (target instanceof Element && target.closest('[data-dwp-trigger]') !== null) return
          setUi({ open: false })
        }
        document.addEventListener('keydown', onKey, true)
        document.addEventListener('pointerdown', onPointerDown, true)
        return () => {
          document.removeEventListener('keydown', onKey, true)
          document.removeEventListener('pointerdown', onPointerDown, true)
        }
      }, [])

      const close = () => { setUi({ open: false }) }

      const head = h('div', { className: 'dwp-head' },
        h('span', { className: 'dwp-title' }, t('panel.title')),
        h('button', {
          type: 'button', className: 'dwp-icon', 'aria-label': t('panel.close'),
          title: t('panel.close'), onClick: close,
        }, '✕'))

      if (state === null) {
        return h('div', { className: 'dwp-panel', ref: root, role: 'dialog', 'aria-label': t('panel.title') },
          head,
          h('div', { className: 'dwp-body' },
            message === null
              ? h('div', { className: 'dwp-msg', role: 'status' }, t('status.busy'))
              : h('div', {
                className: 'dwp-msg', 'data-tone': message.tone, role: 'status',
              }, noticeText(message, t))))
      }

      const settings = state.settings

      const startImport = () => {
        const text = ui.draft.trim()
        if (text === '' || ui.busy) return
        setUi({ busy: true, message: null })
        call('/import', { text }).then((reply) => {
          const clip = reply.state.clips.find(entry => entry.id === reply.state.activeId)
          setUi({
            state: reply.state,
            busy: false,
            draft: '',
            message: { tone: 'ok', key: 'status.imported', detail: shortTitle(clip?.title) },
          })
          sync(reply.state)
        }).catch((error) => {
          setUi({ busy: false, message: { tone: 'error', key: 'status.failed', detail: error.message } })
        })
      }

      const percent = value => `${Math.round(value * 100)}%`

      return h('div', { className: 'dwp-panel', ref: root, role: 'dialog', 'aria-label': t('panel.title') },
        head,
        h('div', { className: 'dwp-body' },
          h('div', { className: 'dwp-form' },
            h('input', {
              className: 'dwp-input',
              type: 'text',
              value: draft,
              placeholder: t('panel.placeholder'),
              'aria-label': t('panel.placeholder'),
              spellCheck: false,
              autoComplete: 'off',
              autoFocus: true,
              onChange: event => { setUi({ draft: event.target.value }) },
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  startImport()
                }
              },
            }),
            h('button', {
              type: 'button',
              className: 'dwp-apply',
              disabled: busy || draft.trim() === '',
              onClick: startImport,
            }, busy ? t('panel.applying') : t('panel.apply'))),

          busy && h('div', { className: 'dwp-msg', role: 'status' }, t('status.busy')),
          !busy && message !== null && h('div', {
            className: 'dwp-msg',
            'data-tone': message.tone,
            role: 'status',
            title: noticeText(message, t),
          }, noticeText(message, t)),

          state.clips.length === 0
            ? h('div', { className: 'dwp-empty' }, t('panel.empty'))
            : h('div', { className: 'dwp-clips' }, state.clips.map(clip => h(ClipTile, {
              key: clip.id, clip, t, active: clip.id === state.activeId,
            }))),

          state.clips.length > 0 && h('div', { className: 'dwp-row' },
            h('span', { className: 'dwp-rowLabel' }, t('panel.enabled')),
            h('button', {
              type: 'button',
              className: 'dwp-switch',
              role: 'switch',
              'aria-checked': state.enabled,
              'aria-label': t('panel.enabled'),
              'data-on': state.enabled ? '1' : '0',
              onClick: () => {
                call('/toggle', { enabled: !state.enabled }).then((reply) => {
                  setUi({ state: reply.state })
                  sync(reply.state)
                }).catch((error) => {
                  setUi({ message: { tone: 'error', text: error.message } })
                })
              },
            }, h('span', { className: 'dwp-knob' }))),

          h('div', { className: 'dwp-section' },
            h('div', { className: 'dwp-sectionTitle' }, t('panel.section.look')),
            h(SliderRow, {
              label: t('panel.glass'), value: settings.glass, min: 0.3, max: 0.9, step: 0.01,
              format: percent, onChange: value => { write({ glass: value }) },
            })),
          h('div', { className: 'dwp-section' },
            h('div', { className: 'dwp-sectionTitle' }, t('panel.section.picture')),
            h(SliderRow, {
              label: t('panel.blur'), value: settings.blur, min: 0, max: 30, step: 1,
              format: value => `${Math.round(value)}px`, onChange: value => { write({ blur: value }) },
            }),
            h(SliderRow, {
              label: t('panel.dim'), value: settings.dim, min: 0, max: 0.85, step: 0.01,
              format: percent, onChange: value => { write({ dim: value }) },
            }),
            h(SliderRow, {
              label: t('panel.brightness'), value: settings.brightness, min: 0.5, max: 1.4, step: 0.01,
              format: percent, onChange: value => { write({ brightness: value }) },
            }),
            h(SliderRow, {
              label: t('panel.scale'), value: settings.scale, min: 1, max: 1.4, step: 0.01,
              format: percent, onChange: value => { write({ scale: value }) },
            })),
          h('div', { className: 'dwp-section' },
            h('div', { className: 'dwp-sectionTitle' }, t('panel.section.play')),
            h(SwitchRow, {
              label: t('panel.muted'), checked: settings.muted,
              onChange: value => { write({ muted: value }) },
            }),
            h(SwitchRow, {
              label: t('panel.loop'), checked: settings.loop,
              onChange: value => { write({ loop: value }) },
            }),
            !settings.muted && h(SliderRow, {
              label: t('panel.volume'), value: settings.volume, min: 0, max: 1, step: 0.01,
              format: percent, onChange: value => { write({ volume: value }) },
            })),
          h('div', { className: 'dwp-hint' }, t('panel.hint'))))
    }

    /**
     * One cover tile in the clip strip.
     * @param props - clip, locale seat, and whether it is the active one.
     * @returns the tile with its remove control.
     */
    function ClipTile({ clip, t, active }) {
      // A video clip may carry a cover thumbnail; an image clip shows its first
      // stored picture, which is always there.
      const cover = clip.kind === 'images'
        ? `${ROUTE}/media/${clip.images?.[0] ?? ''}`
        : clip.hasCover ? `${ROUTE}/cover/${clip.id}.jpg?v=${clip.createdAt}` : undefined
      const activate = () => {
        call('/activate', { id: clip.id }).then((reply) => {
          setUi({ state: reply.state })
          sync(reply.state)
        }).catch((error) => {
          setUi({ message: { tone: 'error', text: error.message } })
        })
      }
      const remove = () => {
        call('/remove', { id: clip.id }).then((reply) => {
          setUi({ state: reply.state })
          sync(reply.state)
        }).catch((error) => {
          setUi({ message: { tone: 'error', text: error.message } })
        })
      }
      const label = [clip.title, clip.author].filter(Boolean).join(' · ') || clip.id
      // The tile is a plain container holding two real buttons: the open target
      // fills the cover, the remove control sits above it. Nesting one button in
      // another (or in a role="button") would make the ✕ unreachable by keyboard.
      return h('div', {
        className: 'dwp-clip',
        'data-active': active ? '1' : '0',
        style: cover === undefined ? undefined : { backgroundImage: `url("${cover}")` },
      },
      h('button', {
        type: 'button',
        className: 'dwp-clipOpen',
        title: label,
        'aria-label': label,
        'aria-pressed': active,
        onClick: activate,
      }, cover === undefined && h('span', { className: 'dwp-clipGlyph', 'aria-hidden': true }, '▶')),
      h('button', {
        type: 'button',
        className: 'dwp-clipDel',
        'aria-label': t('panel.remove'),
        title: t('panel.remove'),
        onClick: remove,
      }, '✕'))
    }

    /**
     * Insert one package-owned stylesheet.
     * @param css - the stylesheet text.
     * @returns the remover.
     */
    function insertStyle(css) {
      const element = document.createElement('style')
      element.setAttribute('data-dwp-style', '')
      element.textContent = css
      document.head.append(element)
      return () => { element.remove() }
    }

    // ------------------------------------------------------------------ apply

    /**
     * Mount the stage, register both surfaces, and reconcile with the Host.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'douyin-wallpaper: dictionaries')

      ctx.effect(() => {
        removeStyle = insertStyle(STYLE)
        if (document.body === null) {
          document.addEventListener('DOMContentLoaded', mountStage, { once: true })
        } else {
          mountStage()
        }
        // Switching light/dark changes the color the glass is mixed from.
        paletteObserver = new MutationObserver(() => {
          if (isLive(ui.state)) applyLook(ui.state.settings)
        })
        if (document.body !== null) {
          paletteObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
        }
        return () => { unmountStage() }
      }, 'douyin-wallpaper: stage')

      // A wallpaper nobody is looking at should not decode frames.
      ctx.effect(() => {
        const onVisibility = () => {
          if (video === undefined || ui.state === null || !ui.state.enabled) return
          if (document.hidden) video.pause()
          else startPlayback()
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => { document.removeEventListener('visibilitychange', onVisibility) }
      }, 'douyin-wallpaper: visibility')

      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'douyin-wallpaper-trigger',
        order: 5,
        locale: NS,
      }, Trigger))

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'douyin-wallpaper-panel',
        order: 3,
        locale: NS,
      }, Panel))

      // Read the persisted wallpaper: the page paints the last state without asking.
      call('/state').then((reply) => {
        setUi({ state: reply.state })
        sync(reply.state)
      }).catch((error) => {
        // A state that never arrives must not leave the panel unusable: fall back
        // to an empty one, so the link field and sliders stay interactive.
        const fallback = emptyState()
        setUi({ state: fallback, message: { tone: 'error', key: 'status.readState', detail: error.message } })
        sync(fallback)
      })
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
