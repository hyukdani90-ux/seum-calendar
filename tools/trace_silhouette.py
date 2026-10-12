"""달리기 실루엣 스프라이트 -> 좌우 반전된 벡터(SVG) 스트립.

usage: python3 tools/trace_silhouette.py <input.png> <out.svg>
needs: pip install potracer pillow numpy

검은 실루엣이 흰 배경 위에 가로로 놓인 그림을 프레임별로 나누고,
윤곽선을 따라 벡터로 바꿔 화질과 상관없이 매끈하게 만든다.
결과 SVG는 프레임이 가로로 붙은 한 장이며, CSS mask로 써서 색을 자유롭게 입힌다.
"""
import sys

import numpy as np
import potrace
from PIL import Image

UPSCALE = 6        # 윤곽을 매끄럽게 따기 위해 먼저 키운다
CELL_W, CELL_H = 64, 84  # 프레임 한 칸 크기 (원본 픽셀 단위)


def split_frames(mask):
    cols = mask.sum(0)
    runs, start = [], None
    for x, c in enumerate(cols):
        if c > 0 and start is None:
            start = x
        elif c == 0 and start is not None:
            runs.append((start, x))
            start = None
    if start is not None:
        runs.append((start, len(cols)))
    return [r for r in runs if r[1] - r[0] > 8]


def trace(mask):
    """mask(True=채움) -> SVG path d (UPSCALE 배율 좌표)."""
    # potracer는 False를 채움으로 보므로 뒤집어서 넘긴다
    paths = potrace.Bitmap(~mask).trace(turdsize=8, alphamax=1.1, opticurve=True, opttolerance=0.3)
    d = []
    for curve in paths:
        sx, sy = curve.start_point.x, curve.start_point.y
        d.append(f'M{sx:.1f} {sy:.1f}')
        for seg in curve.segments:
            if seg.is_corner:
                d.append(f'L{seg.c.x:.1f} {seg.c.y:.1f}L{seg.end_point.x:.1f} {seg.end_point.y:.1f}')
            else:
                d.append(f'C{seg.c1.x:.1f} {seg.c1.y:.1f} {seg.c2.x:.1f} {seg.c2.y:.1f} {seg.end_point.x:.1f} {seg.end_point.y:.1f}')
        d.append('Z')
    return ''.join(d)


def main(src, out):
    gray = Image.open(src).convert('L')
    padded = Image.new('L', (gray.width + 8, gray.height + 8), 255)
    padded.paste(gray, (4, 4))
    gray = padded
    mask = np.array(gray) < 128
    frames = split_frames(mask)
    rows = np.nonzero(mask.any(1))[0]
    top, bottom = rows.min(), rows.max() + 1

    big = gray.resize((gray.width * UPSCALE, gray.height * UPSCALE), Image.LANCZOS)
    big_mask = np.array(big) < 128

    parts = []
    for i, (x0, x1) in enumerate(frames):
        m = mask[top:bottom, x0:x1]
        # 머리·몸통(위쪽 45%)의 가운데를 기준으로 맞춰야 다리가 흔들려도 몸이 제자리에 있다
        upper = m[: int(m.shape[0] * 0.45)]
        anchor = np.nonzero(upper.any(0))[0].mean() if upper.any() else m.shape[1] / 2
        # 좌우 반전: 오른쪽으로 달리게
        flipped_anchor = (x1 - x0) - anchor
        dx = CELL_W / 2 - flipped_anchor
        dy = CELL_H - (bottom - top) - 2

        # 가장자리가 잘려 윤곽이 틀어지지 않도록 여백을 두고 자른다
        pad = 2
        bm = big_mask[(top - pad) * UPSCALE:(bottom + pad) * UPSCALE, (x0 - pad) * UPSCALE:(x1 + pad) * UPSCALE][:, ::-1]
        d = trace(bm)
        s = 1 / UPSCALE
        parts.append(f'<path transform="translate({i * CELL_W + dx - pad:.2f} {dy - pad:.2f}) scale({s:.5f})" d="{d}"/>')

    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {CELL_W * len(frames)} {CELL_H}" '
           f'width="{CELL_W * len(frames)}" height="{CELL_H}" fill="#000" fill-rule="evenodd">'
           + ''.join(parts) + '</svg>\n')
    with open(out, 'w') as f:
        f.write(svg)
    print(f'{len(frames)} frames, cell {CELL_W}x{CELL_H} -> {out} ({len(svg) // 1024} KB)')


if __name__ == '__main__':
    main(*sys.argv[1:3])
