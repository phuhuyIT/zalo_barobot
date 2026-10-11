"""Facebook share-proof image pipeline.

SIFT localizes the cropped media. The demo scores that warp twice:
the original grayscale grid, and the Sobel edge grid.

Steps: A2 auto-crop, B1 prep, B2 localize, B3 grid NCC, B4 PASS/REVIEW/FAIL.
Thresholds are the document's starting values.
"""
from __future__ import annotations

import base64
import math
import time

import cv2
import numpy as np
from PIL import Image, ImageOps

W0 = 640
TH = dict(
    min_good=12,
    ratio=0.75,
    ransac_px=4.0,
    min_inliers=25,
    min_inlier_ratio=0.30,
    border_inliers=15,
    scale=(0.3, 3.0),
    max_angle=5.0,
    min_visible=0.65,
    grid_n=8,
    grid_w=256,
    edge_margin=0.04,
    tile_cov=0.70,
    tile_ncc=0.60,
    pass_grid=0.80,
    review_grid=0.60,
    # Facebook light and dark collages use different gutter widths, so a tile
    # may sit about 10px off at the 256px grid. Search that far before scoring.
    tile_search=12,
    # A pale poster splits into short saturated bands. Bridge them only then.
    short_run=0.20,
    bridge_gap=45,
    # The bottom collage cell sits under a dark gutter. Take it when it is
    # the same width and much shorter than a second post.
    bottom_gap=45,
    bottom_min=40,
    bottom_ratio=0.45,
)

SIFT = cv2.SIFT_create(nfeatures=1500)


def load_bgr(raw: bytes) -> np.ndarray:
    im = ImageOps.exif_transpose(Image.open(__import__("io").BytesIO(raw))).convert("RGB")
    return cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)


def load_bgr_capped(raw: bytes, max_edge: int = 3200) -> np.ndarray:
    """Decode for scoring and shrink the long edge before SIFT.

    A phone photo is tens of megabytes uncompressed. The matcher only keeps a
    640-wide copy, so anything above max_edge is reduced here. An image that
    already fits is the same pixels as load_bgr. JPEG without a rotation tag
    is decoded at a smaller DCT scale when Pillow can do that.
    """
    import io

    im = Image.open(io.BytesIO(raw))
    exif = im.getexif()
    orientation = int(exif.get(274) or 1) if exif is not None else 1
    if im.format == "JPEG" and orientation == 1 and max(im.size) > max_edge:
        im.draft("RGB", (max_edge, max_edge))
    im = ImageOps.exif_transpose(im).convert("RGB")
    width, height = im.size
    long_edge = max(width, height)
    if long_edge > max_edge:
        scale = max_edge / float(long_edge)
        im = im.resize(
            (max(1, int(round(width * scale))), max(1, int(round(height * scale)))),
            Image.Resampling.LANCZOS,
        )
    bgr = cv2.cvtColor(np.asarray(im), cv2.COLOR_RGB2BGR)
    del im
    if not bgr.flags["C_CONTIGUOUS"]:
        bgr = np.ascontiguousarray(bgr)
    return bgr


def sift_bgr(img: np.ndarray) -> dict:
    """SIFT on an image that is already the working width."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    kp, des = SIFT.detectAndCompute(gray, None)
    return dict(img=img, gray=gray, kp=kp or [], des=des, kind="sift")


def _jpeg_b64(bgr: np.ndarray, quality: int = 72) -> str:
    ok, buf = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        raise RuntimeError("jpeg encode failed")
    return base64.b64encode(buf.tobytes()).decode("ascii")


def _longest_run(v: np.ndarray, thr: float, max_gap: int) -> tuple[int, int]:
    on = v > thr
    best = (0, 0)
    i, n = 0, len(v)
    while i < n:
        if on[i]:
            j, last = i, i
            while j < n and (on[j] or j - last <= max_gap):
                if on[j]:
                    last = j
                j += 1
            if last - i > best[1] - best[0]:
                best = (i, last)
            i = last + 1
        else:
            i += 1
    return best


def _bridge_short_run(row: np.ndarray, y0: int, y1: int, thr: float) -> tuple[int, int]:
    """Join nearby saturated bands when the longest one is only a strip of a pale poster."""
    if y1 - y0 >= TH["short_run"] * len(row):
        return y0, y1
    on = row > thr
    runs = []
    i, n = 0, len(on)
    while i < n:
        if on[i]:
            j = i
            while j < n and on[j]:
                j += 1
            runs.append((i, j - 1))
            i = j
        else:
            i += 1
    if not runs:
        return y0, y1
    clusters = [[runs[0]]]
    for run in runs[1:]:
        if run[0] - clusters[-1][-1][1] <= TH["bridge_gap"]:
            clusters[-1].append(run)
        else:
            clusters.append([run])
    best = max(clusters, key=lambda cluster: cluster[-1][1] - cluster[0][0])
    return best[0][0], best[-1][1]


def _extend_bottom_cell(row: np.ndarray, y0: int, y1: int, thr: float) -> int:
    """Append the next saturated band when a gutter cut the last collage row off."""
    if y1 - y0 > 0.55 * len(row):
        return y1
    on = row > thr
    i = y1 + 1
    while i < len(on) and not on[i]:
        i += 1
    if i >= len(on) or i - y1 > TH["bottom_gap"]:
        return y1
    j = i
    while j < len(on) and on[j]:
        j += 1
    height = j - i
    main = max(1, y1 - y0)
    if height < TH["bottom_min"] or height > TH["bottom_ratio"] * main:
        return y1
    return j - 1


def _thin_strip(x0: int, y0: int, x1: int, y1: int, width: int, height: int) -> bool:
    bw, bh = x1 - x0, y1 - y0
    if bw < 8 or bh < 8:
        return True
    return bh < 0.22 * bw or (bw * bh) / (width * height) < 0.08


def _page_shaped(x0: int, y0: int, x1: int, y1: int, width: int, height: int) -> bool:
    bw, bh = x1 - x0, y1 - y0
    if bw < 0.40 * width or bh < 0.28 * height:
        return False
    aspect = bh / bw
    area = (bw * bh) / (width * height)
    return 0.9 <= aspect <= 2.8 and area <= 0.92


def _paper_rect(img: np.ndarray) -> tuple[int, int, int, int] | None:
    """Cream page on a dark screen. Light-mode screens are bright all over and return nothing."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    paper = ((hsv[..., 2] > 180) & (hsv[..., 1] < 80)).astype(np.uint8) * 255
    paper = cv2.morphologyEx(paper, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    contours, _ = cv2.findContours(paper, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    height, width = img.shape[:2]
    best = None
    for contour in contours:
        x, y, bw, bh = cv2.boundingRect(contour)
        if not _page_shaped(x, y, x + bw, y + bh, width, height):
            continue
        if bw < 0.55 * width:
            continue
        area = bw * bh
        if best is None or area > best[0]:
            best = (area, (x, y, x + bw, y + bh))
    return None if best is None else best[1]


def _red_frame(img: np.ndarray) -> tuple[int, int, int, int] | None:
    """Bounding box of a red corner frame and seal. Ignores a small logo above the page."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    hue, sat, val = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    # Gold borders sit a little past pure red. Collages never reach this path.
    red = (((hue < 25) | (hue > 168)) & (sat > 50) & (val > 40)).astype(np.uint8)
    height, width = red.shape
    columns = np.where(red.sum(0) > 2)[0]
    if len(columns) < 10:
        return None
    x0 = int(np.percentile(columns, 2))
    x1 = int(np.percentile(columns, 98))
    if x1 - x0 < 0.45 * width:
        return None
    side = max(8, (x1 - x0) // 5)
    left = red[:, x0:x0 + side].sum(1) > 0
    right = red[:, x1 - side:x1].sum(1) > 0
    rows = np.where(left & right)[0]
    if len(rows) < 8:
        rows = np.where(red[:, x0:x1].sum(1) > 3)[0]
    if len(rows) < 8:
        return None
    y0, y1 = int(rows.min()), int(rows.max())
    band = red[y0:y1 + 1]
    cols = np.where(band.sum(0) > 0)[0]
    if len(cols) < 10:
        return None
    box = (int(cols.min()), y0, int(cols.max()) + 1, y1 + 1)
    if not _page_shaped(*box, width, height):
        return None
    return box


def auto_crop(bgr: np.ndarray, w: int = W0, sat_thr: int = 45, row_thr: float = 0.20,
              col_thr: float = 0.15, gap: int = 15) -> tuple[int, int, int, int]:
    """A2: longest saturated band, then columns inside that band. Original-image coords.

    A color photo fills that band. A cream letter only leaves a thin red ornament, so
    the crop then uses the bright page, or the red corner frame.
    """
    h0, w0 = bgr.shape[:2]
    s = w / w0
    img = cv2.resize(bgr, (w, int(h0 * s)), interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    mask = ((hsv[..., 1] > sat_thr) & (hsv[..., 2] > 40)).astype(np.float32)
    row = cv2.blur(mask.mean(1).reshape(-1, 1), (1, 9)).ravel()
    y0, y1 = _longest_run(row, row_thr, gap)
    y0, y1 = _bridge_short_run(row, y0, y1, row_thr)
    y1 = _extend_bottom_cell(row, y0, y1, row_thr)
    col = np.convolve(mask[y0:y1 + 1].mean(0), np.ones(9) / 9, "same")
    x0, x1 = _longest_run(col, col_thr, gap)
    scaled_h, scaled_w = img.shape[:2]
    if _thin_strip(x0, y0, x1, y1, scaled_w, scaled_h):
        paper = _paper_rect(img)
        frame = _red_frame(img)
        page = paper or frame
        if paper is not None and frame is not None:
            paper_area = (paper[2] - paper[0]) * (paper[3] - paper[1])
            frame_area = (frame[2] - frame[0]) * (frame[3] - frame[1])
            # A white web page makes the bright box swallow the chrome. Use the frame.
            if paper_area > 0.75 * scaled_w * scaled_h and frame_area < paper_area:
                page = frame
        if page is not None:
            x0, y0, x1, y1 = page
    if x1 <= x0 or y1 <= y0:
        return (0, 0, w0, h0)
    box = tuple(int(round(v / s)) for v in (x0, y0, x1 + 1, y1 + 1))
    x0, y0, x1, y1 = box
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(w0, x1), min(h0, y1)
    if x1 - x0 < 8 or y1 - y0 < 8:
        return (0, 0, w0, h0)
    return (x0, y0, x1, y1)


def prep(bgr: np.ndarray, kind: str = "sift", w: int = W0) -> dict:
    h = int(round(bgr.shape[0] * w / bgr.shape[1]))
    img = cv2.resize(bgr, (w, h), interpolation=cv2.INTER_AREA)
    return sift_bgr(img)


def localize(ref: dict, sub: dict) -> dict:
    r = dict(good=0, inliers=0, ratio=0.0, M=None, scale=None, angle=None,
             visible=0.0, bbox=None, ok=False, why="")
    if ref["des"] is None or sub["des"] is None or len(sub["kp"]) < 2 or len(ref["kp"]) < 2:
        r["why"] = "no features"
        return r
    knn = cv2.BFMatcher(cv2.NORM_L2).knnMatch(ref["des"], sub["des"], k=2)
    good = [p[0] for p in knn if len(p) == 2 and p[0].distance < TH["ratio"] * p[1].distance]
    r["good"] = len(good)
    if len(good) < TH["min_good"]:
        r["why"] = f"few good matches ({len(good)})"
        return r
    src = np.float32([ref["kp"][m.queryIdx].pt for m in good])
    dst = np.float32([sub["kp"][m.trainIdx].pt for m in good])
    M, inl = cv2.estimateAffinePartial2D(
        src, dst, method=cv2.RANSAC,
        ransacReprojThreshold=TH["ransac_px"], maxIters=3000, confidence=0.995,
    )
    if M is None:
        r["why"] = "RANSAC failed"
        return r
    inl = inl.ravel().astype(bool)
    r["inliers"] = int(inl.sum())
    r["ratio"] = float(inl.sum() / len(good))
    r["M"] = M
    r["scale"] = float(math.hypot(M[0, 0], M[1, 0]))
    r["angle"] = float(math.degrees(math.atan2(M[1, 0], M[0, 0])))
    h, w = ref["gray"].shape
    corners = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    pc = cv2.transform(corners[None], M)[0]
    r["bbox"] = pc
    x0, y0 = pc.min(0)
    x1, y1 = pc.max(0)
    H, W = sub["gray"].shape
    ix = max(0.0, min(x1, W) - max(x0, 0))
    iy = max(0.0, min(y1, H) - max(y0, 0))
    area = max(1e-6, (x1 - x0) * (y1 - y0))
    r["visible"] = float(ix * iy / area)
    reasons = []
    if r["inliers"] < TH["min_inliers"]:
        reasons.append(f"low inliers ({r['inliers']})")
    if r["ratio"] < TH["min_inlier_ratio"]:
        reasons.append(f"low inlier ratio ({r['ratio']:.2f})")
    if not (TH["scale"][0] <= r["scale"] <= TH["scale"][1]):
        reasons.append(f"scale ({r['scale']:.2f})")
    if abs(r["angle"]) > TH["max_angle"]:
        reasons.append(f"rotation ({r['angle']:.1f} deg)")
    if r["visible"] < TH["min_visible"]:
        reasons.append(f"visible {r['visible']:.0%}")
    r["ok"] = not reasons
    r["why"] = "; ".join(reasons)
    return r


def _sobel_mag(gray: np.ndarray) -> np.ndarray:
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    return cv2.magnitude(gx, gy)


def _tile_ncc(left: np.ndarray, right: np.ndarray) -> float:
    if left.std() < 1e-3 and right.std() < 1e-3:
        return 1.0
    if left.std() < 1e-3 or right.std() < 1e-3:
        return 0.0
    left = left - left.mean()
    right = right - right.mean()
    denom = float(np.linalg.norm(left) * np.linalg.norm(right))
    return float(np.dot(left, right) / denom) if denom > 1e-6 else 0.0


def grid_check(ref: dict, sub: dict, M: np.ndarray, signal: str = "gray") -> dict:
    """B3 on one warp. signal='gray' is the old baseline; 'sobel' is the edge grid."""
    h, w = ref["gray"].shape
    flags = cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP
    warped = cv2.warpAffine(sub["gray"], M, (w, h), flags=flags)
    warped_c = cv2.warpAffine(sub["img"], M, (w, h), flags=flags)
    mask = cv2.warpAffine(
        np.full(sub["gray"].shape, 255, np.uint8), M, (w, h),
        flags=cv2.INTER_NEAREST | cv2.WARP_INVERSE_MAP,
    )
    sw = TH["grid_w"]
    sh = int(round(h * sw / w))
    if signal == "sobel":
        a = _sobel_mag(cv2.resize(ref["gray"], (sw, sh), interpolation=cv2.INTER_AREA))
        b = _sobel_mag(cv2.resize(warped, (sw, sh), interpolation=cv2.INTER_AREA))
    else:
        a = cv2.GaussianBlur(cv2.medianBlur(cv2.resize(ref["gray"], (sw, sh), interpolation=cv2.INTER_AREA), 5), (5, 5), 0).astype(np.float32)
        b = cv2.GaussianBlur(cv2.medianBlur(cv2.resize(warped, (sw, sh), interpolation=cv2.INTER_AREA), 5), (5, 5), 0).astype(np.float32)
    mk = cv2.resize(mask, (sw, sh), interpolation=cv2.INTER_AREA) > 200
    n = TH["grid_n"]
    mx, my = int(sw * TH["edge_margin"]), int(sh * TH["edge_margin"])
    ys = np.linspace(my, sh - my, n + 1).astype(int)
    xs = np.linspace(mx, sw - mx, n + 1).astype(int)
    ncc = np.full((n, n), np.nan)
    state = np.zeros((n, n), int)
    for i in range(n):
        for j in range(n):
            sl = (slice(ys[i], ys[i + 1]), slice(xs[j], xs[j + 1]))
            if mk[sl].mean() < TH["tile_cov"]:
                continue
            if signal == "sobel":
                v = _tile_ncc(a[sl].ravel(), b[sl].ravel())
            else:
                ta = a[sl]
                if ta.std() < 3:
                    window = b[max(0, ys[i] - 2):min(sh, ys[i + 1] + 2), max(0, xs[j] - 2):min(sw, xs[j + 1] + 2)]
                    v = 1.0 if window.size and abs(float(ta.mean()) - float(window.mean())) < 12 else 0.0
                else:
                    rad = TH["tile_search"]
                    window = b[max(0, ys[i] - rad):min(sh, ys[i + 1] + rad), max(0, xs[j] - rad):min(sw, xs[j + 1] + rad)]
                    if window.shape[0] < ta.shape[0] or window.shape[1] < ta.shape[1]:
                        v = 0.0
                    else:
                        res = cv2.matchTemplate(window, ta, cv2.TM_CCOEFF_NORMED)
                        v = float(res.max()) if res.size else 0.0
            ncc[i, j] = v
            state[i, j] = 1 if v >= TH["tile_ncc"] else -1
    valid = int((state != 0).sum())
    matched = int((state == 1).sum())
    score = matched / valid if valid else 0.0
    return dict(score=score, valid=valid, matched=matched, ncc=ncc, state=state,
                warped=warped_c, ys=ys, xs=xs, sh=sh, sw=sw)


def decide(loc: dict, grid: dict | None) -> str:
    # A correct warp can have few inliers on a small screenshot. Trust the grid
    # once the pose itself is plausible.
    pose_ok = (
        loc["M"] is not None
        and loc["scale"] is not None
        and TH["scale"][0] <= loc["scale"] <= TH["scale"][1]
        and abs(loc["angle"]) <= TH["max_angle"]
        and loc["visible"] >= TH["min_visible"]
        and loc["inliers"] >= 7
    )
    if pose_ok and grid is not None:
        if grid["score"] >= TH["pass_grid"]:
            return "PASS"
        if grid["score"] >= TH["review_grid"]:
            return "REVIEW"
        return "FAIL"
    if loc["ok"] and grid is not None:
        if grid["score"] >= TH["pass_grid"]:
            return "PASS"
        if grid["score"] >= TH["review_grid"]:
            return "REVIEW"
        return "FAIL"
    border = (
        loc["M"] is not None
        and TH["border_inliers"] <= loc["inliers"] < TH["min_inliers"]
        and loc["ratio"] >= TH["min_inlier_ratio"]
        and loc["visible"] >= 0.4
    )
    return "REVIEW" if border else "FAIL"


def _draw_box(bgr: np.ndarray, box: tuple[int, int, int, int]) -> np.ndarray:
    out = bgr.copy()
    x0, y0, x1, y1 = box
    cv2.rectangle(out, (x0, y0), (x1, y1), (40, 180, 40), max(2, bgr.shape[1] // 200))
    return out


def _draw_poly(bgr: np.ndarray, pts: np.ndarray) -> np.ndarray:
    out = bgr.copy()
    p = np.round(pts).astype(np.int32)
    cv2.polylines(out, [p], True, (40, 180, 40), max(2, bgr.shape[1] // 200))
    return out


def _draw_grid(warped: np.ndarray, grid: dict) -> np.ndarray:
    vis = cv2.resize(warped, (grid["sw"], grid["sh"]), interpolation=cv2.INTER_AREA)
    overlay = vis.copy()
    n = TH["grid_n"]
    ys, xs = grid["ys"], grid["xs"]
    for i in range(n):
        for j in range(n):
            color = (160, 160, 160)
            if grid["state"][i, j] == 1:
                color = (40, 170, 40)
            elif grid["state"][i, j] == -1:
                color = (40, 40, 200)
            cv2.rectangle(overlay, (xs[j], ys[i]), (xs[j + 1], ys[i + 1]), color, -1)
    return cv2.addWeighted(vis, 0.55, overlay, 0.45, 0)


def _loc_public(loc: dict) -> dict:
    return {
        "good": loc["good"],
        "inliers": loc["inliers"],
        "inlier_ratio": round(loc["ratio"], 3),
        "scale": None if loc["scale"] is None else round(loc["scale"], 3),
        "angle_deg": None if loc["angle"] is None else round(loc["angle"], 2),
        "visible": round(loc["visible"], 3),
        "ok": loc["ok"],
        "why": loc["why"],
    }


def _grid_public(grid: dict | None, loc: dict, ms: float) -> dict:
    decision = decide(loc, grid)
    return {
        "grid": None if grid is None else {
            "score": round(grid["score"], 3),
            "valid": grid["valid"],
            "matched": grid["matched"],
            "overlay_jpeg": _jpeg_b64(_draw_grid(grid["warped"], grid)),
        },
        "decision": decision,
        "admin": "pending" if decision == "REVIEW" else ("accepted" if decision == "PASS" else "rejected"),
        "ms": ms,
    }


def run_pair(ref: dict, sub_bgr: np.ndarray) -> dict:
    t0 = time.perf_counter()
    sub = prep(sub_bgr)
    t_prep = time.perf_counter()
    loc = localize(ref, sub)
    t_loc = time.perf_counter()
    grids = {}
    for signal in ("gray", "sobel"):
        t_grid = time.perf_counter()
        grid = grid_check(ref, sub, loc["M"], signal) if loc["M"] is not None else None
        grids[signal] = _grid_public(grid, loc, round((time.perf_counter() - t_grid) * 1000, 1))
    preview = sub["img"]
    if loc["bbox"] is not None:
        preview = _draw_poly(sub["img"], loc["bbox"])
    return {
        "features": len(sub["kp"]),
        "localize": _loc_public(loc),
        "bbox_jpeg": _jpeg_b64(preview),
        "grids": grids,
        "ms": {
            "prep": round((t_prep - t0) * 1000, 1),
            "localize": round((t_loc - t_prep) * 1000, 1),
        },
    }


def analyze(sample_bgr: np.ndarray, submissions: list[tuple[str, np.ndarray]]) -> dict:
    t0 = time.perf_counter()
    box = auto_crop(sample_bgr)
    x0, y0, x1, y1 = box
    crop = sample_bgr[y0:y1, x0:x1]
    ref = prep(crop)
    crop_ms = round((time.perf_counter() - t0) * 1000, 1)
    rows = []
    for name, bgr in submissions:
        rows.append({"name": name, "result": run_pair(ref, bgr)})
    return {
        "thresholds": {k: (list(v) if isinstance(v, tuple) else v) for k, v in TH.items()},
        "sample": {
            "width": int(sample_bgr.shape[1]),
            "height": int(sample_bgr.shape[0]),
            "crop_box": {"x0": x0, "y0": y0, "x1": x1, "y1": y1},
            "crop_ms": crop_ms,
            "full_jpeg": _jpeg_b64(_draw_box(sample_bgr, box), 60),
            "crop_jpeg": _jpeg_b64(ref["img"]),
            "features": len(ref["kp"]),
        },
        "submissions": rows,
    }
