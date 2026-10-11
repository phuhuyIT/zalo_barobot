"""Score one member screenshot against one sample image.

One-shot: ``score_cli.py <reference> <query>`` prints one JSON object.
``score_cli.py --serve`` reads one JSON request per line and writes one JSON
result per line. The worker keeps that process alive and reuses prepared
sample features.
"""
from __future__ import annotations

import ctypes
import gc
import json
import os
import sys
from pathlib import Path

import cv2

from pipeline import W0, auto_crop, decide, grid_check, load_bgr_capped, localize, sift_bgr

REF_CACHE_LIMIT = 8


def score_max_edge() -> int:
    # Eval screenshots reach 2800px on the long edge. Stay above that so their
    # crops stay put. Larger phone photos are reduced before SIFT.
    raw = os.environ.get("IMAGE_MATCH_MAX_EDGE", "3200")
    try:
        value = int(raw)
    except ValueError:
        return 3200
    return value if value >= W0 else 3200


def _resize_width(bgr, width: int):
    height = int(round(bgr.shape[0] * width / bgr.shape[1]))
    return cv2.resize(bgr, (width, height), interpolation=cv2.INTER_AREA)


def _features(bgr):
    """One 640-wide resize, then drop the input before SIFT allocates."""
    small = _resize_width(bgr, W0)
    del bgr
    return sift_bgr(small)


class ReferenceCache:
    """Prepared sample features keyed by path, mtime, and size."""

    def __init__(self, limit: int = REF_CACHE_LIMIT) -> None:
        self.limit = limit
        self._items: dict[tuple, dict] = {}
        self._order: list[tuple] = []

    def get(self, key: tuple) -> dict | None:
        item = self._items.get(key)
        if item is None:
            return None
        self._order.remove(key)
        self._order.append(key)
        return item

    def put(self, key: tuple, value: dict) -> None:
        path = key[0]
        stale = [old for old in self._order if old[0] == path and old != key]
        for old in stale:
            self._order.remove(old)
            self._items.pop(old, None)
        if key in self._items:
            self._order.remove(key)
        self._items[key] = value
        self._order.append(key)
        while len(self._order) > self.limit:
            old = self._order.pop(0)
            self._items.pop(old, None)


def _cache_key(path: str) -> tuple:
    st = os.stat(path)
    return (os.path.abspath(path), st.st_mtime_ns, st.st_size)


def prepare_reference(path: str) -> dict:
    bgr = load_bgr_capped(Path(path).read_bytes(), score_max_edge())
    x0, y0, x1, y1 = auto_crop(bgr)
    small = _resize_width(bgr[y0:y1, x0:x1], W0)
    del bgr
    return sift_bgr(small)


def prepare_query(path: str) -> dict:
    # The load result is only named inside _features, so the full array can
    # be freed before detectAndCompute.
    return _features(load_bgr_capped(Path(path).read_bytes(), score_max_edge()))


def score_paths(reference: str, query: str, cache: ReferenceCache | None = None) -> dict:
    store = cache if cache is not None else ReferenceCache(limit=1)
    key = _cache_key(reference)
    ref = store.get(key)
    if ref is None:
        ref = prepare_reference(reference)
        store.put(key, ref)
    sub = prepare_query(query)
    loc = localize(ref, sub)
    grid = grid_check(ref, sub, loc["M"], "gray") if loc["M"] is not None else None
    del sub
    score = 0.0 if grid is None else float(grid["score"])
    return {"score": round(score, 4), "decision": decide(loc, grid)}


def _release_heap() -> None:
    gc.collect()
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except (OSError, AttributeError):
        return


def serve() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True)
    cache = ReferenceCache()
    for line in sys.stdin:
        text = line.strip()
        if not text:
            continue
        try:
            req = json.loads(text)
            reference = req["reference"]
            query = req["query"]
            if not isinstance(reference, str) or not isinstance(query, str):
                raise ValueError("reference and query must be paths")
            result = score_paths(reference, query, cache)
        except Exception as exc:  # one bad photo must not kill the process
            result = {"error": str(exc)}
        sys.stdout.write(json.dumps(result) + "\n")
        sys.stdout.flush()
        _release_heap()


def main() -> None:
    if len(sys.argv) == 2 and sys.argv[1] == "--serve":
        serve()
        return
    if len(sys.argv) != 3:
        print("usage: score_cli.py <reference> <query> | score_cli.py --serve", file=sys.stderr)
        sys.exit(2)
    json.dump(score_paths(sys.argv[1], sys.argv[2]), sys.stdout)
    sys.stdout.write("\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
