"""Score one member screenshot against one sample image. Prints one JSON object."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from pipeline import auto_crop, decide, grid_check, load_bgr, localize, prep


def score_paths(reference: str, query: str) -> dict:
    ref_bgr = load_bgr(Path(reference).read_bytes())
    query_bgr = load_bgr(Path(query).read_bytes())
    x0, y0, x1, y1 = auto_crop(ref_bgr)
    ref = prep(ref_bgr[y0:y1, x0:x1])
    sub = prep(query_bgr)
    loc = localize(ref, sub)
    grid = grid_check(ref, sub, loc["M"], "gray") if loc["M"] is not None else None
    score = 0.0 if grid is None else float(grid["score"])
    return {"score": round(score, 4), "decision": decide(loc, grid)}


def main() -> None:
    if len(sys.argv) != 3:
        print("usage: score_cli.py <reference> <query>", file=sys.stderr)
        sys.exit(2)
    json.dump(score_paths(sys.argv[1], sys.argv[2]), sys.stdout)


if __name__ == "__main__":
    main()
