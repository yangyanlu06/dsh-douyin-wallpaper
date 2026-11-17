#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Resolve one Douyin link to a playable mp4 for the DSH wallpaper plugin.

This is the same method as `douyin_lapian.py` — playwright drives the system
Edge (channel="msedge") headless, the page's own `/aweme/v1/web/` JSON supplies
`video.play_addr`, the CDN address is downloaded with the session cookies — but
it waits for the *event* instead of a fixed 4.2 s:

  * `douyin_lapian.resolve_and_download` waits 4200 ms and then reads whatever
    arrived. Measured on this machine (2026-11-17), the page's detail XHR
    (`www-hj.douyin.com/aweme/v1/web/aweme/detail/`) and the `<video>.currentSrc`
    often land after that window, and sometimes after 9 s, so that fixed wait
    reports "未拿到播放直链" on pages that do carry one.
  * This bridge polls for a playable source (API JSON first, then the video
    element, then the CDN media requests) up to `--timeout` seconds, then
    downloads once.

Nothing is retried, no signature is reversed, and the lapian script itself is
imported read-only — its helpers, user agent and storage-state file are reused
as they are.

Usage:
  python lapian_bridge.py "<share text or link>" --lapian <douyin_lapian.py> --out <dir>

Output: one line, `__DWP_JSON__{"ok": true, "mp4": ..., "meta": {...}}` or
`__DWP_JSON__{"ok": false, "reason": "..."}`. The exit code stays 0 when a line
was printed, so a clean refusal is not mistaken for a crash.
"""
import argparse
import json
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

MARKER = "__DWP_JSON__"
CDN_KEYS = ("douyinvod", "aweme.snssdk", "bytecdn", "snssdk", "video.toutiao", "ixigua")


def emit(payload):
    sys.stdout.write(MARKER + json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("share", help="整段分享口令、短链或长链")
    parser.add_argument("--lapian", required=True, help="douyin_lapian.py 的路径")
    parser.add_argument("--out", required=True, help="下载目录")
    parser.add_argument("--page-url", default="", help="已解析好的页面 URL（可选）")
    parser.add_argument("--timeout", type=float, default=25.0, help="等待播放直链秒数")
    args = parser.parse_args()

    lab = Path(args.lapian).expanduser().resolve()
    if not lab.is_file():
        emit({"ok": False, "reason": f"找不到 douyin_lapian.py：{lab}"})
        return
    sys.path.insert(0, str(lab.parent))
    try:
        import douyin_lapian as lapian
    except Exception as error:
        emit({"ok": False, "reason": f"导入 douyin_lapian 失败：{type(error).__name__}: {error}"})
        return
    try:
        from playwright.sync_api import sync_playwright
        import requests
    except Exception as error:
        emit({"ok": False, "reason": f"缺少依赖：{type(error).__name__}: {error}"})
        return

    page_url = args.page_url.strip() or lapian.extract_url(args.share)
    out = Path(args.out).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)

    state = getattr(lapian, "STATE", None)
    ua = getattr(lapian, "UA", "Mozilla/5.0")
    blobs = []
    media = []

    with sync_playwright() as driver:
        browser = driver.chromium.launch(
            channel="msedge", headless=True,
            args=["--disable-blink-features=AutomationControlled", "--mute-audio"],
        )
        context_kwargs = {"user_agent": ua, "viewport": {"width": 1280, "height": 720}, "locale": "zh-CN"}
        if state is not None and Path(state).exists():
            context_kwargs["storage_state"] = str(state)
        context = browser.new_context(**context_kwargs)
        page = context.new_page()

        def on_response(response):
            if "/aweme/v1/" in response.url:
                try:
                    blobs.append(response.json())
                except Exception:
                    pass

        def on_request(request):
            if request.resource_type in ("media", "fetch", "other"):
                url = request.url
                if url.startswith("http") and any(key in urlparse(url).netloc for key in CDN_KEYS):
                    if ".m4s" not in url and "/fmp4/" not in url:
                        media.append(url)

        page.on("response", on_response)
        page.on("request", on_request)
        try:
            page.goto(page_url, wait_until="domcontentloaded", timeout=60000)
        except Exception as error:
            browser.close()
            emit({"ok": False, "reason": f"打开页面失败：{type(error).__name__}: {str(error)[:160]}"})
            return

        # Poll until a playable address exists: API JSON first (it carries the
        # highest rendition), then any CDN media request, then the element.
        deadline = time.time() + max(5.0, args.timeout)
        src = ""
        api_urls = []
        dom_src = ""
        while time.time() < deadline:
            page.wait_for_timeout(1200)
            api_urls = lapian.play_urls_from_blobs(blobs)
            if api_urls:
                src = lapian.pick_best_src(api_urls) or api_urls[0]
                break
            if media:
                src = media[0]
                break
            try:
                dom_src = page.evaluate(
                    "() => { const v = document.querySelector('video'); "
                    "return v && v.currentSrc && v.currentSrc.startsWith('http') ? v.currentSrc : '' }")
            except Exception:
                dom_src = ""
            if dom_src:
                src = dom_src
                break

        vids = []
        try:
            vids = page.eval_on_selector_all(
                "video", "els => els.map(e => ({src: e.currentSrc, d: e.duration, w: e.videoWidth, h: e.videoHeight}))")
        except Exception:
            pass
        good = max([v for v in vids if (v.get("d") or 0) > 1], key=lambda v: v["d"], default={})
        meta = {
            "aweme_id": (page.url.rstrip("/").split("/")[-1].split("?")[0] or "video"),
            "page_url": page.url,
            "title": page.title(),
            "duration": good.get("d"),
            "width": good.get("w"),
            "height": good.get("h"),
            "src_kind": "api" if api_urls and src == lapian.pick_best_src(api_urls) else ("dom" if src else ""),
            "api_play_urls": len(api_urls),
            "video_src_host": urlparse(src).netloc if src else "",
            "waited_s": round(max(0.0, args.timeout - max(0.0, deadline - time.time())), 1),
        }
        cookies = {cookie["name"]: cookie["value"] for cookie in context.cookies()}
        try:
            context.storage_state(path=str(state))
        except Exception:
            pass
        browser.close()

    if not src:
        hint = "页面没有可播放源（图文作品请在插件里走图片链路）" if "/note/" in meta["page_url"] else "页面在等待窗口内没有给出播放直链"
        emit({"ok": False, "reason": f"{hint}；page={meta['page_url'][:120]}；title={meta['title'][:60]}"})
        return

    mp4 = out / f"dy_{meta['aweme_id']}.mp4"
    try:
        with requests.get(
            src,
            headers={"Referer": "https://www.douyin.com/", "User-Agent": ua},
            cookies=cookies, stream=True, timeout=(15, 180),
        ) as response:
            response.raise_for_status()
            with mp4.open("wb") as handle:
                for chunk in response.iter_content(1 << 20):
                    if chunk:
                        handle.write(chunk)
    except Exception as error:
        if mp4.exists():
            mp4.unlink()
        emit({"ok": False, "reason": f"下载失败：{type(error).__name__}: {str(error)[:160]}"})
        return
    if not mp4.exists() or mp4.stat().st_size < 100_000:
        if mp4.exists():
            mp4.unlink()
        emit({"ok": False, "reason": f"下载到的文件太小（{mp4.name}），按约定停止"})
        return
    meta["bytes"] = mp4.stat().st_size
    # The page's <video> element often has no duration yet when the API JSON
    # already carries the play address; read it from the downloaded file then.
    duration = meta.get("duration")
    if not isinstance(duration, (int, float)) or duration != duration or duration <= 0:
        try:
            import cv2

            probe = cv2.VideoCapture(str(mp4))
            fps = probe.get(cv2.CAP_PROP_FPS) or 0
            frames = probe.get(cv2.CAP_PROP_FRAME_COUNT) or 0
            if fps and frames:
                meta["duration"] = round(frames / fps, 3)
                meta["width"] = int(probe.get(cv2.CAP_PROP_FRAME_WIDTH))
                meta["height"] = int(probe.get(cv2.CAP_PROP_FRAME_HEIGHT))
                meta["probe"] = "opencv"
            probe.release()
        except Exception:
            pass
    emit({"ok": True, "mp4": str(mp4), "meta": meta})


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    try:
        main()
    except SystemExit:
        raise
    except Exception as fatal:
        emit({"ok": False, "reason": f"{type(fatal).__name__}: {fatal}"})
