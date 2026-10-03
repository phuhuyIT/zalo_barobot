"""
Demo pipeline: doi chieu anh bao cao chia se bai Facebook
B1 tien xu ly -> B2 SIFT + RANSAC (dinh vi) -> B3 kiem tra luoi o -> B4 quyet dinh
Nguong la gia tri khoi diem, chua hieu chinh.
"""
import json, time, math, os, sys
import cv2, numpy as np
from PIL import Image, ImageOps

U = '/mnt/user-data/uploads/'
REFDIR = '/home/claude/demo/refs/'
OUT = '/mnt/user-data/outputs/'
W0 = 640

# ---- nguong khoi diem ----
TH = dict(min_good=12, ratio=0.75, ransac_px=4.0,
          min_inliers=25, min_inlier_ratio=0.30, border_inliers=15,
          scale=(0.3, 3.0), max_angle=5.0, min_visible=0.65,
          grid_n=8, grid_w=256, edge_margin=0.04, tile_cov=0.70, tile_ncc=0.60,
          pass_grid=0.85, review_grid=0.60)

sift = cv2.SIFT_create(nfeatures=1500)


def load_bgr(path):
    im = ImageOps.exif_transpose(Image.open(path)).convert('RGB')
    return cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)


def prep(bgr, w=W0):
    """B1: thu nho ve chieu rong 640, grayscale, SIFT"""
    h = int(round(bgr.shape[0] * w / bgr.shape[1]))
    img = cv2.resize(bgr, (w, h), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    kp, des = sift.detectAndCompute(gray, None)
    return dict(img=img, gray=gray, kp=kp, des=des)


def _longest_run(v, thr, max_gap):
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


def auto_crop(bgr, w=W0, sat_thr=45, row_thr=0.20, col_thr=0.15, gap=15):
    """A2: tu dong tim khung media trong anh mau (khong can nguoi crop).
    Phan giao dien Facebook gan nhu khong co mau bao hoa, con anh/do hoa thi co.
    Tra ve (x0, y0, x1, y1) theo toa do anh goc."""
    h0, w0 = bgr.shape[:2]
    s = w / w0
    img = cv2.resize(bgr, (w, int(h0 * s)), interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    mask = ((hsv[..., 1] > sat_thr) & (hsv[..., 2] > 40)).astype(np.float32)
    row = cv2.blur(mask.mean(1).reshape(-1, 1), (1, 9)).ravel()
    y0, y1 = _longest_run(row, row_thr, gap)
    col = np.convolve(mask[y0:y1 + 1].mean(0), np.ones(9) / 9, 'same')
    x0, x1 = _longest_run(col, col_thr, gap)
    return tuple(int(round(v / s)) for v in (x0, y0, x1 + 1, y1 + 1))


def make_ref(bgr, box=None):
    """A3: crop media (tu dong hoac theo box nguoi dung chinh) -> anh mau"""
    box = box or auto_crop(bgr)
    x0, y0, x1, y1 = box
    return prep(bgr[y0:y1, x0:x1]), box


def localize(ref, sub):
    """B2: knn match + ratio test + RANSAC affine (scale, xoay, dich)"""
    r = dict(good=0, inliers=0, ratio=0.0, M=None, scale=None, angle=None,
             visible=0.0, bbox=None, ok=False, why='', good_list=[], inl_mask=None)
    if ref['des'] is None or sub['des'] is None or len(sub['kp']) < 2:
        r['why'] = 'khong co dac trung'
        return r
    knn = cv2.BFMatcher(cv2.NORM_L2).knnMatch(ref['des'], sub['des'], k=2)
    good = [p[0] for p in knn if len(p) == 2 and p[0].distance < TH['ratio'] * p[1].distance]
    r['good'] = len(good)
    r['good_list'] = good
    if len(good) < TH['min_good']:
        r['why'] = f'it match tot ({len(good)})'
        return r
    src = np.float32([ref['kp'][m.queryIdx].pt for m in good])
    dst = np.float32([sub['kp'][m.trainIdx].pt for m in good])
    M, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC,
                                         ransacReprojThreshold=TH['ransac_px'],
                                         maxIters=3000, confidence=0.995)
    if M is None:
        r['why'] = 'RANSAC that bai'
        return r
    inl = inl.ravel().astype(bool)
    r['inl_mask'] = inl
    r['inliers'] = int(inl.sum())
    r['ratio'] = float(inl.sum() / len(good))
    r['M'] = M
    r['scale'] = float(math.hypot(M[0, 0], M[1, 0]))
    r['angle'] = float(math.degrees(math.atan2(M[1, 0], M[0, 0])))
    h, w = ref['gray'].shape
    corners = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    pc = cv2.transform(corners[None], M)[0]
    r['bbox'] = pc
    x0, y0 = pc.min(0)
    x1, y1 = pc.max(0)
    H, W = sub['gray'].shape
    ix = max(0.0, min(x1, W) - max(x0, 0))
    iy = max(0.0, min(y1, H) - max(y0, 0))
    area = max(1e-6, (x1 - x0) * (y1 - y0))
    r['visible'] = float(ix * iy / area)
    reasons = []
    if r['inliers'] < TH['min_inliers']:
        reasons.append(f"inlier thap ({r['inliers']})")
    if r['ratio'] < TH['min_inlier_ratio']:
        reasons.append(f"ti le inlier thap ({r['ratio']:.2f})")
    if not (TH['scale'][0] <= r['scale'] <= TH['scale'][1]):
        reasons.append(f"scale la ({r['scale']:.2f})")
    if abs(r['angle']) > TH['max_angle']:
        reasons.append(f"xoay ({r['angle']:.1f})")
    if r['visible'] < TH['min_visible']:
        reasons.append(f"media nhin thay {r['visible']:.0%}")
    r['ok'] = not reasons
    r['why'] = '; '.join(reasons)
    return r


def grid_check(ref, sub, M):
    """B3: warp ve khung anh mau, chia luoi 8x8, NCC tung o"""
    h, w = ref['gray'].shape
    flags = cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP
    warped = cv2.warpAffine(sub['gray'], M, (w, h), flags=flags)
    warped_c = cv2.warpAffine(sub['img'], M, (w, h), flags=flags)
    mask = cv2.warpAffine(np.full(sub['gray'].shape, 255, np.uint8), M, (w, h),
                          flags=cv2.INTER_NEAREST | cv2.WARP_INVERSE_MAP)
    sw = TH['grid_w']
    sh = int(round(h * sw / w))
    # median 5x5 xoa khe mong giua cac anh trong collage (den/trang tuy dark/light), roi lam mo nhe
    a = cv2.GaussianBlur(cv2.medianBlur(cv2.resize(ref['gray'], (sw, sh), interpolation=cv2.INTER_AREA), 5), (5, 5), 0).astype(np.float32)
    b = cv2.GaussianBlur(cv2.medianBlur(cv2.resize(warped, (sw, sh), interpolation=cv2.INTER_AREA), 5), (5, 5), 0).astype(np.float32)
    mk = cv2.resize(mask, (sw, sh), interpolation=cv2.INTER_AREA) > 200
    n = TH['grid_n']
    # bo vien ngoai (border cua card, goc bo tron, nen dark/light) truoc khi chia luoi
    mx, my = int(sw * TH['edge_margin']), int(sh * TH['edge_margin'])
    ys = np.linspace(my, sh - my, n + 1).astype(int)
    xs = np.linspace(mx, sw - mx, n + 1).astype(int)
    ncc = np.full((n, n), np.nan)
    state = np.zeros((n, n), int)  # 0 invalid, 1 match, -1 mismatch
    for i in range(n):
        for j in range(n):
            sl = (slice(ys[i], ys[i + 1]), slice(xs[j], xs[j + 1]))
            if mk[sl].mean() < TH['tile_cov']:
                continue
            ta, tb = a[sl].ravel(), b[sl].ravel()
            sa, sb = ta.std(), tb.std()
            if sa < 3 and sb < 3:
                v = 1.0 if abs(ta.mean() - tb.mean()) < 12 else 0.0
            elif sa < 3 or sb < 3:
                v = 0.0
            else:
                v = float(np.corrcoef(ta, tb)[0, 1])
            ncc[i, j] = v
            state[i, j] = 1 if v >= TH['tile_ncc'] else -1
    valid = int((state != 0).sum())
    matched = int((state == 1).sum())
    score = matched / valid if valid else 0.0
    return dict(score=score, valid=valid, matched=matched, ncc=ncc, state=state,
                warped=warped_c, ys=ys, xs=xs, sh=sh, sw=sw)


RANK = {'PASS': 3, 'REVIEW': 2, 'FAIL': 1}


def decide(loc, grid):
    """B4"""
    if loc['ok']:
        if grid['score'] >= TH['pass_grid']:
            return 'PASS'
        if grid['score'] >= TH['review_grid']:
            return 'REVIEW'
        return 'FAIL'
    border = (loc['M'] is not None and TH['border_inliers'] <= loc['inliers'] < TH['min_inliers']
              and loc['ratio'] >= TH['min_inlier_ratio'] and loc['visible'] >= 0.4)
    return 'REVIEW' if border else 'FAIL'


def run_task(sub, refs, exclude=()):
    """chay tat ca anh mau cua 1 task, lay ket qua tot nhat"""
    best = None
    for name, ref in refs.items():
        if name in exclude:
            continue
        t0 = time.time()
        loc = localize(ref, sub)
        grid = grid_check(ref, sub, loc['M']) if loc['ok'] else None
        dec = decide(loc, grid) if (loc['ok'] or loc['M'] is not None or True) else 'FAIL'
        res = dict(ref=name, loc=loc, grid=grid, decision=dec, sec=time.time() - t0)
        key = (RANK[dec], grid['score'] if grid else 0, loc['inliers'])
        if best is None or key > best[0]:
            best = (key, res)
    return best[1] if best else None


def load_refs():
    tasks = {'A': {}, 'B': {}}
    for fn in sorted(os.listdir(REFDIR)):
        if fn.endswith('.png'):
            t = fn[0]
            name = fn[:-4]
            tasks[t][name] = prep(load_bgr(REFDIR + fn))
    return tasks


if __name__ == '__main__':
    tasks = load_refs()
    for t, d in tasks.items():
        for k, v in d.items():
            print(f'ref {k}: {v["img"].shape[1]}x{v["img"].shape[0]}, {len(v["kp"])} SIFT')
