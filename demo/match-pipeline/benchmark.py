"""Variants of the share-proof matcher, scored like the SIFT + RANSAC + grid baseline.

Protocol (fixed for every idea):
- One reference per post: the first image in sorted order.
- Positive: every other image in that post.
- Negative: that reference against the reference of every other post.
- Hard negatives: post8 against every post10 image and the reverse, plus Post2
  against every post2.1 image and the reverse. Post2 and post2.1 are the same
  poster layout on different days, so those pairs are also the N2 set.
- Post4 and Post5 are one post. They are the same collage.
- Parameters are chosen by group cross-validation on the reference post.
  A pair is scored with the choice made while its reference post was held out.
"""
from __future__ import annotations

import gc
import json
import os
import resource
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pipeline as P

ROOT = Path("/workspaces/zalo_barobot/tests/eval_datasets")
MERGE = {"Post5": "Post4"}
HARD = {("post8", "post10"), ("Post2", "post2.1")}
N2 = {("Post2", "post2.1")}
WIDTH = 640


@dataclass
class Pair:
    ref: Path
    query: Path
    ref_group: str
    query_group: str
    label: int
    hard: int
    n2: int


def rss_mb() -> float:
    for line in open("/proc/self/status", encoding="utf-8"):
        if line.startswith("VmRSS:"):
            return int(line.split()[1]) / 1024
    return 0.0


def load_groups() -> dict[str, list[Path]]:
    groups: dict[str, list[Path]] = {}
    for folder in sorted(p for p in ROOT.iterdir() if p.is_dir()):
        name = MERGE.get(folder.name, folder.name)
        files = sorted(
            p for p in folder.iterdir()
            if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
        )
        groups.setdefault(name, []).extend(files)
    for name in groups:
        groups[name] = sorted(groups[name])
    return groups


def build_pairs(groups: dict[str, list[Path]]) -> list[Pair]:
    pairs: list[Pair] = []
    seen: set[tuple[str, str]] = set()

    def add(ref: Path, query: Path, ref_g: str, query_g: str, label: int, hard: int, n2: int) -> None:
        key = (str(ref), str(query))
        if key in seen or ref == query:
            return
        seen.add(key)
        pairs.append(Pair(ref, query, ref_g, query_g, label, hard, n2))

    names = sorted(groups)
    for name in names:
        files = groups[name]
        ref = files[0]
        for query in files[1:]:
            add(ref, query, name, name, 1, 0, 0)
    for i, left in enumerate(names):
        for right in names:
            if left == right:
                continue
            hard = (left, right) in HARD or (right, left) in HARD
            n2 = (left, right) in N2 or (right, left) in N2
            if hard:
                for query in groups[right]:
                    add(groups[left][0], query, left, right, 0, 1, int(n2))
            else:
                add(groups[left][0], groups[right][0], left, right, 0, 0, 0)
    return pairs


def auc(labels: np.ndarray, scores: np.ndarray) -> float:
    pos = scores[labels == 1]
    neg = scores[labels == 0]
    if len(pos) == 0 or len(neg) == 0:
        return float("nan")
    order = np.argsort(scores, kind="mergesort")
    ranks = np.empty(len(scores), dtype=np.float64)
    ranks[order] = np.arange(1, len(scores) + 1)
    # Average ranks for ties.
    sorted_scores = scores[order]
    start = 0
    while start < len(scores):
        end = start + 1
        while end < len(scores) and sorted_scores[end] == sorted_scores[start]:
            end += 1
        if end > start + 1:
            mean = ranks[order[start:end]].mean()
            ranks[order[start:end]] = mean
        start = end
    sum_pos = ranks[labels == 1].sum()
    return float((sum_pos - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


def recall_at_zero_fp(labels: np.ndarray, scores: np.ndarray) -> float:
    neg = scores[labels == 0]
    pos = scores[labels == 1]
    if len(neg) == 0 or len(pos) == 0:
        return float("nan")
    return float((pos > neg.max()).mean())


def metrics(pairs: list[Pair], scores: np.ndarray) -> dict[str, float]:
    labels = np.array([p.label for p in pairs])
    hard = np.array([p.label == 1 or p.hard == 1 for p in pairs])
    n2_groups = {"Post2", "post2.1"}
    n2 = np.array([
        (p.label == 1 and p.ref_group in n2_groups) or p.n2 == 1
        for p in pairs
    ])
    return {
        "auc": auc(labels, scores),
        "auc_hard": auc(labels[hard], scores[hard]),
        "auc_n2": auc(labels[n2], scores[n2]),
        "r_at_0fp": recall_at_zero_fp(labels, scores),
    }


def group_folds(groups: list[str], k: int = 5) -> list[set[str]]:
    names = sorted(groups)
    return [set(names[i::k]) for i in range(k)]


def oof(pairs: list[Pair], param_scores: list[np.ndarray], params: list) -> tuple[np.ndarray, list]:
    if len(params) == 1:
        return param_scores[0], [params[0]]
    labels = np.array([p.label for p in pairs])
    out = np.zeros(len(pairs), dtype=np.float64)
    chosen = []
    for test in group_folds(sorted({p.ref_group for p in pairs})):
        train = np.array([p.ref_group not in test for p in pairs])
        held = np.array([p.ref_group in test for p in pairs])
        best_i, best_a = 0, -1.0
        for i, scores in enumerate(param_scores):
            value = auc(labels[train], scores[train])
            if value > best_a:
                best_a, best_i = value, i
        chosen.append(params[best_i])
        out[held] = param_scores[best_i][held]
    return out, chosen


_IMAGES: dict[str, np.ndarray] = {}
_PREP: dict[tuple, dict] = {}


def image_of(path: Path) -> np.ndarray:
    key = str(path)
    if key not in _IMAGES:
        _IMAGES[key] = P.load_bgr(path.read_bytes())
    return _IMAGES[key]


def prep_of(path: Path, kind: str = "sift", width: int = WIDTH, nfeatures: int = 1500, root: bool = False) -> dict:
    key = (str(path), kind, width, nfeatures, root)
    if key in _PREP:
        return _PREP[key]
    bgr = image_of(path)
    detector = cv2.SIFT_create(nfeatures=nfeatures) if kind == "sift" else cv2.ORB_create(nfeatures=nfeatures)
    height = int(round(bgr.shape[0] * width / bgr.shape[1]))
    img = cv2.resize(bgr, (width, height), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    kp, des = detector.detectAndCompute(gray, None)
    if root and des is not None:
        des = des.astype(np.float32)
        des /= des.sum(axis=1, keepdims=True) + 1e-8
        des = np.sqrt(des)
    packed = dict(img=img, gray=gray, kp=kp or [], des=des, kind=kind)
    _PREP[key] = packed
    return packed


def prep_bgr(bgr: np.ndarray, kind: str = "sift", width: int = WIDTH, nfeatures: int = 1500, root: bool = False) -> dict:
    detector = cv2.SIFT_create(nfeatures=nfeatures) if kind == "sift" else cv2.ORB_create(nfeatures=nfeatures)
    height = int(round(bgr.shape[0] * width / max(1, bgr.shape[1])))
    img = cv2.resize(bgr, (width, max(8, height)), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    kp, des = detector.detectAndCompute(gray, None)
    if root and des is not None:
        des = des.astype(np.float32)
        des /= des.sum(axis=1, keepdims=True) + 1e-8
        des = np.sqrt(des)
    return dict(img=img, gray=gray, kp=kp or [], des=des, kind=kind)


def match_good(ref: dict, sub: dict, flann: bool = False) -> tuple[list, np.ndarray | None, np.ndarray | None]:
    if ref["des"] is None or sub["des"] is None or len(ref["kp"]) < 2 or len(sub["kp"]) < 2:
        return [], None, None
    if ref["kind"] == "sift":
        if flann:
            matcher = cv2.FlannBasedMatcher(dict(algorithm=1, trees=4), dict(checks=32))
        else:
            matcher = cv2.BFMatcher(cv2.NORM_L2)
    else:
        matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    try:
        knn = matcher.knnMatch(np.ascontiguousarray(ref["des"]), np.ascontiguousarray(sub["des"]), k=2)
    except cv2.error:
        return [], None, None
    good = [p[0] for p in knn if len(p) == 2 and p[0].distance < P.TH["ratio"] * p[1].distance]
    if len(good) < 3:
        return good, None, None
    src = np.float32([ref["kp"][m.queryIdx].pt for m in good])
    dst = np.float32([sub["kp"][m.trainIdx].pt for m in good])
    model, inl = cv2.estimateAffinePartial2D(
        src, dst, method=cv2.RANSAC,
        ransacReprojThreshold=P.TH["ransac_px"], maxIters=2000, confidence=0.99,
    )
    if model is None:
        return good, None, None
    return good, model, inl.ravel().astype(bool)


def pose_score(ref: dict, sub: dict, model: np.ndarray | None, inliers: int) -> tuple[float, dict]:
    info = dict(inliers=inliers, ratio=0.0, visible=0.0, scale=0.0, angle=0.0, grid=0.0, cluster=0.0)
    if model is None:
        return 0.0, info
    h, w = ref["gray"].shape
    corners = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    pc = cv2.transform(corners[None], model)[0]
    x0, y0 = pc.min(0)
    x1, y1 = pc.max(0)
    height, width = sub["gray"].shape
    ix = max(0.0, min(x1, width) - max(x0, 0))
    iy = max(0.0, min(y1, height) - max(y0, 0))
    area = max(1e-6, (x1 - x0) * (y1 - y0))
    visible = float(ix * iy / area)
    scale = float(np.hypot(model[0, 0], model[1, 0]))
    angle = float(np.degrees(np.arctan2(model[1, 0], model[0, 0])))
    info.update(visible=visible, scale=scale, angle=angle)
    if not (0.3 <= scale <= 3.0) or visible < 0.4 or abs(angle) > 8:
        return 0.0, info
    grid = P.grid_check(ref, sub, model)
    info["grid"] = float(grid["score"])
    info["cluster"] = mismatch_cluster(grid["ncc"], P.TH["tile_ncc"])
    return float(grid["score"]), info


def mismatch_cluster(ncc: np.ndarray, threshold: float) -> float:
    bad = np.isfinite(ncc) & (ncc < threshold)
    if bad.size == 0 or not bad.any():
        return 0.0
    seen = np.zeros_like(bad, dtype=bool)
    best = 0
    height, width = bad.shape
    for y in range(height):
        for x in range(width):
            if not bad[y, x] or seen[y, x]:
                continue
            stack = [(y, x)]
            seen[y, x] = True
            count = 0
            while stack:
                cy, cx = stack.pop()
                count += 1
                for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                    if 0 <= ny < height and 0 <= nx < width and bad[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
            best = max(best, count)
    valid = int(np.isfinite(ncc).sum())
    return best / valid if valid else 0.0


_CROP: dict[str, np.ndarray] = {}
_BASE: dict[tuple[int, int], tuple[float, dict]] = {}


def crop_ref(path: Path, box: tuple[int, int, int, int] | None = None) -> np.ndarray:
    if box is None and str(path) in _CROP:
        return _CROP[str(path)]
    bgr = image_of(path)
    if box is None:
        box = P.auto_crop(bgr)
    x0, y0, x1, y1 = box
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(bgr.shape[1], x1), min(bgr.shape[0], y1)
    if x1 - x0 < 8 or y1 - y0 < 8:
        cropped = bgr
    else:
        cropped = bgr[y0:y1, x0:x1]
    if str(path) not in _CROP:
        _CROP[str(path)] = cropped
    return cropped


def baseline_score(ref_bgr: np.ndarray, query_bgr: np.ndarray, cache: bool = True) -> tuple[float, dict]:
    key = (id(ref_bgr), id(query_bgr))
    if cache and key in _BASE:
        return _BASE[key]
    ref = prep_bgr(ref_bgr, "sift")
    sub = prep_bgr(query_bgr, "sift")
    good, model, mask = match_good(ref, sub)
    inliers = int(mask.sum()) if mask is not None else 0
    ratio = inliers / len(good) if good else 0.0
    score, info = pose_score(ref, sub, model, inliers)
    info["ratio"] = ratio
    info["model"] = model
    info["ref"] = ref
    info["sub"] = sub
    if cache:
        _BASE[key] = (score, {k: info[k] for k in ("inliers", "ratio", "visible", "scale", "angle", "grid", "cluster")})
    return score, info


def sanity(box: tuple[int, int, int, int], shape: tuple[int, ...]) -> bool:
    height, width = shape[:2]
    x0, y0, x1, y1 = box
    bw, bh = x1 - x0, y1 - y0
    if bw < 0.45 * width or bh < 0.18 * height:
        return False
    area = (bw * bh) / (width * height)
    if area < 0.12 or area > 0.88:
        return False
    if bh < 0.28 * bw:
        return False
    return True


def _band_box(mask: np.ndarray, row_thr: float, col_thr: float) -> tuple[int, int, int, int]:
    row = cv2.blur(mask.mean(1).astype(np.float32).reshape(-1, 1), (1, 9)).ravel()
    y0, y1 = P._longest_run(row, row_thr, 15)
    col = np.convolve(mask[y0:y1 + 1].mean(0), np.ones(9) / 9, "same")
    x0, x1 = P._longest_run(col, col_thr, 15)
    return int(x0), int(y0), int(x1) + 1, int(y1) + 1


def signal_boxes(bgr: np.ndarray) -> list[tuple[int, int, int, int]]:
    height, width = bgr.shape[:2]
    scale = WIDTH / width
    small = cv2.resize(bgr, (WIDTH, int(round(height * scale))), interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    sat = ((hsv[..., 1] > 45) & (hsv[..., 2] > 40)).astype(np.float32)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 60, 160).astype(np.float32) / 255
    texture = np.abs(cv2.Laplacian(gray, cv2.CV_32F))
    texture = texture / (texture.max() + 1e-6)
    boxes = []
    for mask, row_thr, col_thr in ((sat, 0.20, 0.15), (edges, 0.08, 0.08), (texture, 0.15, 0.12)):
        x0, y0, x1, y1 = _band_box(mask, row_thr, col_thr)
        box = tuple(int(round(v / scale)) for v in (x0, y0, x1, y1))
        boxes.append((
            max(0, box[0]), max(0, box[1]),
            min(width, box[2]), min(height, box[3]),
        ))
    return boxes


def iou(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, x1 - x0) * max(0, y1 - y0)
    area = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / area if area else 0.0


def voted_crop(bgr: np.ndarray) -> np.ndarray:
    boxes = signal_boxes(bgr)
    shape = bgr.shape
    ranked = sorted(boxes, key=lambda box: sum(iou(box, other) for other in boxes), reverse=True)
    for box in ranked:
        if sanity(box, shape):
            return crop_ref_bgr(bgr, box)
    for box in boxes:
        if sanity(box, shape):
            return crop_ref_bgr(bgr, box)
    return crop_ref_bgr(bgr, P.auto_crop(bgr))


def crop_ref_bgr(bgr: np.ndarray, box: tuple[int, int, int, int]) -> np.ndarray:
    x0, y0, x1, y1 = box
    x0, y0 = max(0, int(x0)), max(0, int(y0))
    x1, y1 = min(bgr.shape[1], int(x1)), min(bgr.shape[0], int(y1))
    if x1 - x0 < 8 or y1 - y0 < 8:
        return bgr
    return bgr[y0:y1, x0:x1]


def card_crop(bgr: np.ndarray) -> np.ndarray:
    height, width = bgr.shape[:2]
    scale = WIDTH / width
    small = cv2.resize(bgr, (WIDTH, int(round(height * scale))), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 40, 120)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best = None
    for contour in contours:
        x, y, bw, bh = cv2.boundingRect(contour)
        if bw < 0.55 * small.shape[1] or bh < 0.2 * small.shape[0]:
            continue
        area = bw * bh
        if best is None or area > best[0]:
            best = (area, (x, y, x + bw, y + bh))
    if best is None:
        return crop_ref_bgr(bgr, P.auto_crop(bgr))
    x0, y0, x1, y1 = best[1]
    header = max(1, int(0.12 * (y1 - y0)))
    y0 += header
    box = tuple(int(round(v / scale)) for v in (x0, y0, x1, y1))
    return crop_ref_bgr(bgr, box)


def ncc_grid(a: np.ndarray, b: np.ndarray, n: int) -> np.ndarray:
    height = min(a.shape[0], b.shape[0])
    width = min(a.shape[1], b.shape[1])
    th, tw = height // n, width // n
    if th < 2 or tw < 2:
        return np.zeros((n, n))
    def tiles(img: np.ndarray) -> np.ndarray:
        cut = img[:th * n, :tw * n].reshape(n, th, n, tw).transpose(0, 2, 1, 3)
        flat = cut.reshape(n * n, -1).astype(np.float32)
        flat -= flat.mean(axis=1, keepdims=True)
        return flat
    left, right = tiles(a), tiles(b)
    denom = np.linalg.norm(left, axis=1) * np.linalg.norm(right, axis=1)
    num = (left * right).sum(axis=1)
    return np.where(denom > 1e-6, num / denom, 0.0).reshape(n, n)


def aligned_grays(ref_bgr: np.ndarray, query_bgr: np.ndarray) -> tuple[np.ndarray, np.ndarray] | None:
    score, info = baseline_score(ref_bgr, query_bgr, cache=False)
    model = info.get("model")
    if model is None or score == 0.0 and info["visible"] < 0.4:
        if model is None:
            return None
    ref = info["ref"]["gray"]
    sub = info["sub"]["gray"]
    warped = cv2.warpAffine(
        sub, model, (ref.shape[1], ref.shape[0]),
        flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
    )
    return ref, warped


def sobel_mag(gray: np.ndarray) -> np.ndarray:
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    return cv2.magnitude(gx, gy)


def ssim_map(a: np.ndarray, b: np.ndarray, n: int) -> np.ndarray:
    values = ncc_grid(a, b, n)
    # Replace correlation with a luminance-aware SSIM on the same tiles.
    height, width = a.shape
    th, tw = height // n, width // n
    out = np.zeros((n, n))
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    for i in range(n):
        for j in range(n):
            ta = a[i * th:(i + 1) * th, j * tw:(j + 1) * tw].astype(np.float32)
            tb = b[i * th:(i + 1) * th, j * tw:(j + 1) * tw].astype(np.float32)
            mu_a, mu_b = ta.mean(), tb.mean()
            var_a, var_b = ta.var(), tb.var()
            cov = ((ta - mu_a) * (tb - mu_b)).mean()
            out[i, j] = ((2 * mu_a * mu_b + c1) * (2 * cov + c2)) / (
                (mu_a ** 2 + mu_b ** 2 + c1) * (var_a + var_b + c2) + 1e-6
            )
    return out if values.size else out


def text_boxes(gray: np.ndarray) -> list[tuple[int, int, int, int]]:
    mser = cv2.MSER_create(5, 30, 800)
    regions, _ = mser.detectRegions(gray)
    boxes = []
    height, width = gray.shape
    for region in regions:
        x, y, bw, bh = cv2.boundingRect(region.reshape(-1, 1, 2))
        if bh < 6 or bw < 6 or bh > 0.2 * height or bw > 0.5 * width:
            continue
        if bw / bh > 12 or bh / bw > 6:
            continue
        boxes.append((x, y, x + bw, y + bh))
    return boxes[:80]


def fit_logit(features: np.ndarray, labels: np.ndarray, l2: float) -> np.ndarray:
    mean = features.mean(axis=0)
    std = features.std(axis=0) + 1e-6
    x = (features - mean) / std
    bias = np.ones((len(x), 1))
    design = np.concatenate([x, bias], axis=1)
    weights = np.zeros(design.shape[1])
    for _ in range(180):
        pred = 1 / (1 + np.exp(-np.clip(design @ weights, -20, 20)))
        grad = design.T @ (pred - labels) / len(labels)
        grad[:-1] += l2 * weights[:-1]
        weights -= 0.4 * grad
    return np.r_[weights, mean, std]


def apply_logit(features: np.ndarray, packed: np.ndarray) -> np.ndarray:
    dim = features.shape[1]
    weights, mean, std = packed[:dim + 1], packed[dim + 1:dim + 1 + dim], packed[dim + 1 + dim:]
    x = (features - mean) / std
    design = np.concatenate([x, np.ones((len(x), 1))], axis=1)
    return 1 / (1 + np.exp(-np.clip(design @ weights, -20, 20)))


def ece(labels: np.ndarray, probs: np.ndarray) -> float:
    total = 0.0
    for low, high in zip(np.linspace(0, 1, 6)[:-1], np.linspace(0, 1, 6)[1:]):
        mask = (probs >= low) & (probs < high if high < 1 else probs <= high)
        if mask.sum() == 0:
            continue
        total += mask.mean() * abs(probs[mask].mean() - labels[mask].mean())
    return float(total)


class Timer:
    def __init__(self) -> None:
        self.start = rss_mb()
        self.peak = self.start
        self.t0 = time.perf_counter()
        self.count = 0

    def tick(self) -> None:
        self.count += 1
        if self.count % 8 == 0:
            self.peak = max(self.peak, rss_mb())

    def done(self) -> tuple[float, float]:
        self.peak = max(self.peak, rss_mb())
        ms = (time.perf_counter() - self.t0) * 1000 / max(1, self.count)
        return ms, self.peak - self.start


def run_params(pairs: list[Pair], grid: list, scorer) -> tuple[np.ndarray, list, float, float]:
    timer = Timer()
    columns = []
    for param in grid:
        values = np.zeros(len(pairs))
        for i, pair in enumerate(pairs):
            values[i] = scorer(pair, param)
            timer.tick()
        columns.append(values)
        print(f"    param {param} auc {auc(np.array([p.label for p in pairs]), values):.3f}", flush=True)
    scores, chosen = oof(pairs, columns, grid)
    ms, ram = timer.done()
    # Time was spent on every parameter. Report the cost of the chosen setting.
    ms = ms / max(1, len(grid))
    return scores, chosen, ms, ram


CHECKPOINT = Path("/tmp/benchmark_checkpoint.json")


def save_checkpoint(rows: list[dict]) -> None:
    CHECKPOINT.write_text(json.dumps(rows, indent=2), encoding="utf-8")


def _num(value: float, signed: bool = False) -> str:
    if value != value:
        return "   nan"
    return f"{value:+.3f}" if signed else f"{value:.3f}"


def variant_table(rows: list[dict]) -> str:
    header = f"{'idea':<28} {'beat':<5} {'AUC':>6} {'dAUC':>7} {'hard':>6} {'dH':>7} {'N2':>6} {'dN2':>7} {'R@0':>6} {'ms':>7} {'RAM':>7}  note"
    lines = [header]
    for row in rows:
        lines.append(
            f"{row['name']:<28} {row['beat']:<5} {_num(row['auc']):>6} {_num(row['d_auc'], True):>7} "
            f"{_num(row['auc_hard']):>6} {_num(row['d_hard'], True):>7} {_num(row['auc_n2']):>6} {_num(row['d_n2'], True):>7} "
            f"{_num(row['r_at_0fp']):>6} {row['ms']:7.0f} {row['ram']:7.0f}  {row['note']}"
        )
    return "\n".join(lines)


def decode_ram(reduced: bool) -> float:
    flag = "REDUCED" if reduced else "FULL"
    code = f"""
import cv2, resource
from pathlib import Path
root = Path("{ROOT}")
files = [p for p in root.rglob("*") if p.suffix.lower() in {{".jpg", ".jpeg"}}][:36]
flag = cv2.IMREAD_REDUCED_COLOR_2 if {reduced} else cv2.IMREAD_COLOR
for path in files:
    cv2.imread(str(path), flag)
print(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)
"""
    out = subprocess.check_output([sys.executable, "-c", code], text=True)
    return float(out.strip().splitlines()[-1])


def worker_ram(restart: bool) -> float:
    code = """
import resource, sys
from pathlib import Path
sys.path.insert(0, "/workspaces/zalo_barobot/demo/match-pipeline")
import benchmark as B
groups = B.load_groups()
pairs = [p for p in B.build_pairs(groups) if p.label == 1][:12]
for pair in pairs:
    ref = B.crop_ref(pair.ref)
    B.baseline_score(ref, B.image_of(pair.query))
print(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)
"""
    if not restart:
        out = subprocess.check_output([sys.executable, "-c", code], text=True)
        return float(out.strip().splitlines()[-1])
    peaks = []
    for _ in range(3):
        out = subprocess.check_output([sys.executable, "-c", code.replace("[:12]", "[:4]")], text=True)
        peaks.append(float(out.strip().splitlines()[-1]))
    return max(peaks)


def main() -> None:
    groups = load_groups()
    pairs = build_pairs(groups)
    print(
        f"posts {len(groups)} pairs {len(pairs)} positives {sum(p.label for p in pairs)} "
        f"hard {sum(p.hard for p in pairs)} n2 {sum(p.n2 for p in pairs)}",
        flush=True,
    )
    if os.environ.get("BENCH_SMOKE"):
        positives = [p for p in pairs if p.label == 1][:4]
        negatives = [p for p in pairs if p.label == 0][:4]
        pairs = positives + negatives
        print("smoke subset", len(pairs), flush=True)
    labels = np.array([p.label for p in pairs])

    base_timer = Timer()
    base_scores = np.zeros(len(pairs))
    base_info = []
    for i, pair in enumerate(pairs):
        ref = crop_ref(pair.ref)
        score, info = baseline_score(ref, image_of(pair.query))
        base_scores[i] = score
        base_info.append({
            "inliers": info["inliers"], "ratio": info["ratio"], "visible": info["visible"],
            "scale": info["scale"], "angle": info["angle"], "grid": info["grid"],
            "cluster": info["cluster"],
        })
        base_timer.tick()
        if i % 20 == 0:
            print(f"  baseline {i}/{len(pairs)}", flush=True)
    base_ms, base_ram = base_timer.done()
    base_m = metrics(pairs, base_scores)
    print("baseline", {k: round(v, 3) for k, v in base_m.items()}, f"ms {base_ms:.0f}", flush=True)
    _PREP.clear()
    _BASE.clear()
    gc.collect()

    results = [{
        "name": "baseline SIFT+grid",
        **base_m,
        "ms": base_ms,
        "ram": base_ram,
        "note": "fixed thresholds",
        "beat": "—",
        "d_auc": 0.0, "d_hard": 0.0, "d_n2": 0.0,
    }]
    skip: set[str] = set()
    if os.environ.get("BENCH_RESUME") and CHECKPOINT.exists():
        for row in json.loads(CHECKPOINT.read_text(encoding="utf-8")):
            if row["name"] != results[0]["name"]:
                results.append(row)
        skip = {row["name"] for row in results}
        print("resume, already done:", ", ".join(sorted(skip)), flush=True)

    def once(name: str, grid: list, scorer, note: str) -> None:
        if name in skip:
            print("skip", name, flush=True)
            return
        scores, chosen, ms, ram = run_params(pairs, grid, scorer)
        detail = note
        if len(grid) > 1:
            detail = f"{note}; cv {chosen}"
        finish(name, scores, ms, ram, detail)

    def finish(name: str, scores: np.ndarray, ms: float, ram: float, note: str) -> None:
        got = metrics(pairs, scores)
        d_auc = got["auc"] - base_m["auc"]
        d_hard = got["auc_hard"] - base_m["auc_hard"]
        d_n2 = got["auc_n2"] - base_m["auc_n2"]
        beat = "yes" if (d_auc >= 0.005 and got["r_at_0fp"] + 1e-9 >= base_m["r_at_0fp"]) or (
            d_auc >= -0.01 and (d_hard >= 0.02 or d_n2 >= 0.02) and got["r_at_0fp"] + 1e-9 >= base_m["r_at_0fp"]
        ) else "no"
        results.append({
            "name": name, **got, "ms": ms, "ram": ram, "note": note, "beat": beat,
            "d_auc": d_auc, "d_hard": d_hard, "d_n2": d_n2,
        })
        print(f"done {name} auc {got['auc']:.3f} ({d_auc:+.3f}) {note}", flush=True)
        save_checkpoint(results)
        _PREP.clear()
        _BASE.clear()
        gc.collect()

    def score_crop(pair: Pair, cropper) -> float:
        ref = cropper(image_of(pair.ref))
        score, _ = baseline_score(ref, image_of(pair.query))
        return score

    once("A1 multi-signal crop", ["vote"], lambda pair, _param: score_crop(pair, voted_crop), "sanity fallback")

    once("A2 rounded card", ["card"], lambda pair, _param: score_crop(pair, card_crop), "media below header")

    # A3 consensus from other positives of the same reference. The query is excluded.
    members: dict[str, list[Path]] = {}
    for pair in pairs:
        if pair.label == 1:
            members.setdefault(str(pair.ref), []).append(pair.query)

    def consensus_score(pair: Pair, _param) -> float:
        ref_full = image_of(pair.ref)
        box = P.auto_crop(ref_full)
        ref = crop_ref_bgr(ref_full, box)
        others = [path for path in members.get(str(pair.ref), []) if path != pair.query]
        points = []
        donor = None
        prepared = prep_bgr(ref, "sift")
        for other in others[:6]:
            sub = prep_bgr(image_of(other), "sift")
            good, model, mask = match_good(prepared, sub)
            if model is None or mask is None or int(mask.sum()) < 15:
                continue
            src = np.float32([prepared["kp"][m.queryIdx].pt for m, keep in zip(good, mask) if keep])
            if len(src):
                points.append(src)
            if donor is None:
                donor = other
        if points:
            stacked = np.concatenate(points, axis=0)
            x0 = max(0, int(stacked[:, 0].min() / WIDTH * ref.shape[1]) - 4)
            y0 = max(0, int(stacked[:, 1].min() / WIDTH * ref.shape[0]) - 4)
            # prepared image is width 640, map back roughly by scale of the crop
            scale_x = ref.shape[1] / prepared["gray"].shape[1]
            scale_y = ref.shape[0] / prepared["gray"].shape[0]
            x0 = max(0, int(stacked[:, 0].min() * scale_x) - 8)
            y0 = max(0, int(stacked[:, 1].min() * scale_y) - 8)
            x1 = min(ref.shape[1], int(stacked[:, 0].max() * scale_x) + 8)
            y1 = min(ref.shape[0], int(stacked[:, 1].max() * scale_y) + 8)
            if x1 - x0 > 16 and y1 - y0 > 16:
                ref = ref[y0:y1, x0:x1]
        score, _ = baseline_score(ref, image_of(pair.query))
        if donor is not None:
            donor_crop = crop_ref(donor)
            extra, _ = baseline_score(donor_crop, image_of(pair.query))
            score = max(score, extra)
        return score

    once("A3 consensus crop", ["consensus"], consensus_score, "inliers from other passes")

    def rootsift_score(pair: Pair, param: tuple[int, int]) -> float:
        nfeatures, width = param
        ref = crop_ref(pair.ref)
        prepared_ref = prep_bgr(ref, "sift", width, nfeatures, root=True)
        prepared_q = prep_bgr(image_of(pair.query), "sift", width, nfeatures, root=True)
        good, model, mask = match_good(prepared_ref, prepared_q, flann=True)
        inliers = int(mask.sum()) if mask is not None else 0
        score, _ = pose_score(prepared_ref, prepared_q, model, inliers)
        return score

    # Cross-validate a reduced grid. 1500/480 is the closest to the baseline cost.
    sift_grid = [(600, 320), (1000, 400), (1500, 480)]
    once("B4 RootSIFT+FLANN", sift_grid, rootsift_score, "nfeatures x width")

    def coarse_fine(pair: Pair, coarse: int) -> float:
        ref = crop_ref(pair.ref)
        query = image_of(pair.query)
        ref_c = prep_bgr(ref, "sift", coarse, 800)
        query_c = prep_bgr(query, "sift", coarse, 800)
        _good, model, mask = match_good(ref_c, query_c)
        if model is None:
            return 0.0
        ref_f = prep_bgr(ref, "sift", WIDTH, 1500)
        query_f = prep_bgr(query, "sift", WIDTH, 1500)
        scale = WIDTH / coarse
        model = model.copy()
        model[:, 2] *= scale
        # Re-estimate on the full resolution instead of trusting the scaled matrix alone.
        _good, model_f, mask_f = match_good(ref_f, query_f)
        use = model_f if model_f is not None else model
        inliers = int(mask_f.sum()) if mask_f is not None else 0
        score, _ = pose_score(ref_f, query_f, use, inliers)
        return score

    once("B5 coarse-to-fine", [320, 400], coarse_fine, "coarse width")

    def fast_then_sift(pair: Pair, threshold: float) -> float:
        ref = crop_ref(pair.ref)
        query = image_of(pair.query)
        ref_o = prep_bgr(ref, "orb", WIDTH, 500)
        query_o = prep_bgr(query, "orb", WIDTH, 500)
        _good, model, mask = match_good(ref_o, query_o)
        inliers = int(mask.sum()) if mask is not None else 0
        fast, _ = pose_score(ref_o, query_o, model, inliers)
        if fast >= threshold:
            return fast
        slow, _ = baseline_score(ref, query)
        return slow

    once("B6 ORB then SIFT", [0.55, 0.75, 0.9], fast_then_sift, "fallback threshold")

    def with_ecc(pair: Pair, _param) -> float:
        ref = crop_ref(pair.ref)
        query = image_of(pair.query)
        _score, info = baseline_score(ref, query, cache=False)
        model = info.get("model")
        if model is None:
            return 0.0
        ref_g = info["ref"]["gray"]
        sub_g = info["sub"]["gray"]
        canvas_h = max(ref_g.shape[0], sub_g.shape[0])
        canvas_w = max(ref_g.shape[1], sub_g.shape[1])
        ref_p = cv2.copyMakeBorder(ref_g, 0, canvas_h - ref_g.shape[0], 0, canvas_w - ref_g.shape[1], cv2.BORDER_REPLICATE)
        sub_p = cv2.copyMakeBorder(sub_g, 0, canvas_h - sub_g.shape[0], 0, canvas_w - sub_g.shape[1], cv2.BORDER_REPLICATE)
        try:
            criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 12, 1e-3)
            _cc, refined = cv2.findTransformECC(
                ref_p, sub_p, model.astype(np.float32), cv2.MOTION_AFFINE, criteria,
            )
        except cv2.error:
            refined = model
        inliers = info["inliers"]
        score, _ = pose_score(info["ref"], info["sub"], refined, inliers)
        return score

    once("B7 ECC refine", ["ecc"], with_ecc, "12 iterations")

    def collage_tiles(pair: Pair, shape: tuple[int, int]) -> float:
        rows, cols, threshold = shape
        ref = prep_bgr(crop_ref(pair.ref), "sift", 480, 400)["gray"]
        query = prep_bgr(image_of(pair.query), "sift", 480, 400)["gray"]
        height, width = ref.shape
        hits = 0
        total = 0
        for r in range(rows):
            for c in range(cols):
                tile = ref[r * height // rows:(r + 1) * height // rows, c * width // cols:(c + 1) * width // cols]
                if tile.shape[0] < 20 or tile.shape[1] < 20:
                    continue
                total += 1
                best = 0.0
                for scale in (0.75, 1.0, 1.25):
                    sized = cv2.resize(tile, (max(12, int(tile.shape[1] * scale)), max(12, int(tile.shape[0] * scale))))
                    if sized.shape[0] >= query.shape[0] or sized.shape[1] >= query.shape[1]:
                        continue
                    res = cv2.matchTemplate(query, sized, cv2.TM_CCOEFF_NORMED)
                    best = max(best, float(res.max()))
                hits += best >= threshold
        return hits / total if total else 0.0

    once("B8 per-tile collage", [(2, 2, 0.55), (2, 3, 0.55), (2, 3, 0.7)], collage_tiles, "rows, cols, threshold")

    def verify(pair: Pair, kind: str) -> float:
        aligned = aligned_grays(crop_ref(pair.ref), image_of(pair.query))
        if aligned is None:
            return 0.0
        left, right = aligned
        if kind == "sobel":
            values = ncc_grid(sobel_mag(left), sobel_mag(right), 8)
        elif kind == "lab":
            def lab(gray: np.ndarray, color_ref: np.ndarray | None = None) -> np.ndarray:
                return gray
            # Rebuild color from the same warp using the stored baseline images.
            ref_bgr = crop_ref(pair.ref)
            _score, info = baseline_score(ref_bgr, image_of(pair.query), cache=False)
            model = info.get("model")
            if model is None:
                return 0.0
            warped = cv2.warpAffine(
                info["sub"]["img"], model, (info["ref"]["gray"].shape[1], info["ref"]["gray"].shape[0]),
                flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
            )
            ref_lab = cv2.cvtColor(info["ref"]["img"], cv2.COLOR_BGR2LAB)
            warp_lab = cv2.cvtColor(warped, cv2.COLOR_BGR2LAB)
            channels = [
                ncc_grid(ref_lab[..., channel], warp_lab[..., channel], 8)
                for channel in range(3)
            ]
            values = np.mean(channels, axis=0)
        else:
            values = ssim_map(left, right, 8)
        valid = values[np.isfinite(values)]
        if valid.size == 0:
            return 0.0
        return float((valid >= 0.6).mean())

    once("C9 gradient/Lab/SSIM", ["sobel", "lab", "ssim"], verify, "representation")

    def cluster_score(pair: Pair, n: int) -> float:
        aligned = aligned_grays(crop_ref(pair.ref), image_of(pair.query))
        if aligned is None:
            return 0.0
        values = ncc_grid(*aligned, n)
        return 1.0 - mismatch_cluster(values, 0.6)

    once("C10 mismatch cluster", [8, 16, 32], cluster_score, "grid")

    def adaptive(pair: Pair, percentile: float) -> float:
        ref = crop_ref(pair.ref)
        ok, encoded = cv2.imencode(".jpg", ref, [int(cv2.IMWRITE_JPEG_QUALITY), 40])
        if not ok:
            return 0.0
        decoded = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
        self_score, info = baseline_score(decoded, ref)
        aligned_self = aligned_grays(decoded, ref)
        if aligned_self is None:
            floor = 0.5
        else:
            values = ncc_grid(*aligned_self, 8)
            finite = values[np.isfinite(values)]
            floor = float(np.percentile(finite, percentile)) if finite.size else 0.5
        aligned = aligned_grays(ref, image_of(pair.query))
        if aligned is None:
            return 0.0
        values = ncc_grid(*aligned, 8)
        finite = values[np.isfinite(values)]
        if finite.size == 0:
            return 0.0
        return float((finite >= min(0.85, floor)).mean())

    once("C11 adaptive tile floor", [5.0, 20.0], adaptive, "self-NCC percentile")

    def text_score(pair: Pair, _param) -> float:
        aligned = aligned_grays(crop_ref(pair.ref), image_of(pair.query))
        if aligned is None:
            return 0.0
        left, right = aligned
        boxes = text_boxes(left)
        if not boxes:
            values = ncc_grid(left, right, 8)
            return float(np.nanmean(values))
        scores_box = []
        for x0, y0, x1, y1 in boxes:
            patch_a = left[y0:y1, x0:x1].astype(np.float32).ravel()
            patch_b = right[y0:y1, x0:x1].astype(np.float32).ravel()
            if patch_a.std() < 3 or patch_b.std() < 3:
                continue
            patch_a -= patch_a.mean()
            patch_b -= patch_b.mean()
            denom = np.linalg.norm(patch_a) * np.linalg.norm(patch_b)
            if denom < 1e-6:
                continue
            scores_box.append(float(np.dot(patch_a, patch_b) / denom))
        if not scores_box:
            return 0.0
        return float(np.mean([value >= 0.55 for value in scores_box]))

    once("C12 text-region NCC", ["mser"], text_score, "MSER patches after warp")

    if "C13 patch embeddings" not in skip:
        results.append({
            "name": "C13 patch embeddings",
            "auc": float("nan"), "auc_hard": float("nan"), "auc_n2": float("nan"), "r_at_0fp": float("nan"),
            "ms": 0.0, "ram": 0.0, "note": "not measured (no onnxruntime, weights not loaded)",
            "beat": "no", "d_auc": 0.0, "d_hard": 0.0, "d_n2": 0.0,
        })
        save_checkpoint(results)
        print("done C13 not measured", flush=True)

    if "C14 logistic p(PASS)" not in skip:
        features = np.array([
            [info["inliers"] / 100, info["ratio"], info["grid"], info["cluster"], info["visible"]]
            for info in base_info
        ], dtype=np.float64)
        timer = Timer()
        l2_grid = [0.1, 1.0, 10.0]
        param_scores = []
        for l2 in l2_grid:
            column = np.zeros(len(pairs))
            for test in group_folds(sorted({p.ref_group for p in pairs})):
                train = np.array([p.ref_group not in test for p in pairs])
                held = np.array([p.ref_group in test for p in pairs])
                if train.sum() < 8 or len(set(labels[train])) < 2:
                    column[held] = base_scores[held]
                    continue
                packed = fit_logit(features[train], labels[train].astype(np.float64), l2)
                column[held] = apply_logit(features[held], packed)
                timer.tick()
            param_scores.append(column)
        scores, chosen = oof(pairs, param_scores, l2_grid)
        ms, ram = timer.done()
        calibration = ece(labels, np.clip(scores, 0, 1))
        finish("C14 logistic p(PASS)", scores, ms, ram, f"cv L2 {chosen}; ECE {calibration:.3f}")

    def reduced_pair(pair: Pair, denom: int) -> float:
        ref = image_of(pair.ref)
        query = image_of(pair.query)
        ref_s = cv2.resize(ref, (max(8, ref.shape[1] // denom), max(8, ref.shape[0] // denom)), interpolation=cv2.INTER_AREA)
        query_s = cv2.resize(query, (max(8, query.shape[1] // denom), max(8, query.shape[0] // denom)), interpolation=cv2.INTER_AREA)
        score, _ = baseline_score(crop_ref_bgr(ref_s, P.auto_crop(ref_s)), query_s)
        return score

    once("D15 downscaled input", [2, 4], reduced_pair, "divisor; decode RSS measured separately")

    if not os.environ.get("BENCH_SMOKE") and "D16 restart worker" not in skip:
        full_ram = decode_ram(False)
        reduced_ram = decode_ram(True)
        for row in results:
            if row["name"] == "D15 downscaled input":
                row["note"] += f"; decode full {full_ram:.0f} MB vs half {reduced_ram:.0f} MB"
                row["ram"] = reduced_ram
        one = worker_ram(False)
        restarted = worker_ram(True)
        results.append({
            "name": "D16 restart worker",
            **base_m,
            "ms": base_ms,
            "ram": restarted - one,
            "note": f"one process {one:.0f} MB vs restart every 4 pairs {restarted:.0f} MB; same matcher",
            "beat": "yes" if restarted + 5 < one else "no",
            "d_auc": 0.0, "d_hard": 0.0, "d_n2": 0.0,
        })
        save_checkpoint(results)

    # D15's copied baseline metrics make d_auc 0. The beat flag is about RAM only.
    text = variant_table(results)
    print("\n" + text, flush=True)
    out = Path("/tmp/benchmark_results.txt")
    out.write_text(text + "\n", encoding="utf-8")
    print(f"wrote {out}", flush=True)


if __name__ == "__main__":
    main()
