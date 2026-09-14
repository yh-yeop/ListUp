"""앱 아이콘을 만든다 — 앱 로그인 화면의 로고(파란 둥근 사각형 + 흰 folder-open)와 같은 모양.

    python scripts/make-icons.py

만드는 것 (app/assets/)
  icon.png           1024px, 불투명. iOS·예전 안드로이드 런처용. 모서리는 OS 가 자른다
  adaptive-icon.png  1024px, 투명 배경에 흰 글리프. 안드로이드 적응형 아이콘의 앞면이자 단색(테마) 아이콘.
                     런처가 원·둥근 사각형 등으로 자르므로 글리프를 안전 영역(지름 66/108) 안에 둔다
  favicon.png        48px. 서버가 주는 웹의 브라우저 탭

색과 비율은 app/src/theme.ts 의 accent 와 app/app/login.tsx 의 로고(60px 상자, 모서리 16, 글리프 30)를 따른다.
글리프는 앱이 쓰는 Ionicons 폰트에서 그대로 그린다. PIL 이 필요하다 (pip install pillow).
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'app' / 'assets'
FONT = ROOT / 'node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.ttf'
GLYPH = chr(62246)  # Ionicons "folder-open"
ACCENT = (0x2F, 0x6D, 0xF6)  # theme.ts light accent
WHITE = (255, 255, 255)

# 로그인 화면 로고의 비율
CORNER_RATIO = 16 / 60
GLYPH_RATIO = 30 / 60
# 적응형 아이콘: 108dp 캔버스 중 지름 66dp 원은 어떤 모양으로 잘려도 남는다.
# 글리프의 네 모서리까지 그 원 안에 들어가야 하므로 대각선 기준으로 크기를 정한다.
SAFE_DIAMETER_RATIO = 66 / 108


def glyph_layer(size: int, max_box: float) -> Image.Image:
    """투명한 size×size 캔버스 가운데에, 가장 긴 변이 max_box 픽셀인 흰 글리프."""
    probe = ImageFont.truetype(str(FONT), 1000)
    left, top, right, bottom = probe.getbbox(GLYPH)
    scale = max_box / max(right - left, bottom - top)
    font = ImageFont.truetype(str(FONT), max(1, round(1000 * scale)))
    left, top, right, bottom = font.getbbox(GLYPH)
    layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    # 폰트의 여백(bearing) 말고 실제로 그려지는 상자를 가운데에 맞춘다.
    x = (size - (right - left)) / 2 - left
    y = (size - (bottom - top)) / 2 - top
    ImageDraw.Draw(layer).text((x, y), GLYPH, font=font, fill=WHITE + (255,))
    return layer


def glyph_box_fitting_circle(size: int, diameter_ratio: float) -> float:
    """원 안에 들어가는 글리프의 긴 변. 글리프 상자의 대각선이 지름 이하가 되게."""
    probe = ImageFont.truetype(str(FONT), 1000)
    left, top, right, bottom = probe.getbbox(GLYPH)
    w, h = right - left, bottom - top
    diagonal_per_long_side = (w * w + h * h) ** 0.5 / max(w, h)
    return size * diameter_ratio / diagonal_per_long_side


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    # icon.png — 꽉 찬 배경. 불투명해야 한다(iOS).
    size = 1024
    icon = Image.new('RGBA', (size, size), ACCENT + (255,))
    icon.alpha_composite(glyph_layer(size, size * GLYPH_RATIO))
    icon.convert('RGB').save(OUT / 'icon.png', optimize=True)

    # adaptive-icon.png — 투명 배경, 글리프는 안전 원 안에 (조금 여유를 둔다).
    box = glyph_box_fitting_circle(size, SAFE_DIAMETER_RATIO) * 0.92
    glyph_layer(size, box).save(OUT / 'adaptive-icon.png', optimize=True)

    # favicon.png — 로고 모양 그대로(둥근 사각형). 크게 그려 줄여 가장자리를 매끄럽게.
    big = 192
    favicon = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(favicon).rounded_rectangle(
        (0, 0, big - 1, big - 1), radius=round(big * CORNER_RATIO), fill=ACCENT + (255,)
    )
    favicon.alpha_composite(glyph_layer(big, big * GLYPH_RATIO))
    favicon.resize((48, 48), Image.LANCZOS).save(OUT / 'favicon.png', optimize=True)

    for name in ('icon.png', 'adaptive-icon.png', 'favicon.png'):
        path = OUT / name
        with Image.open(path) as im:
            print(f'{path.relative_to(ROOT)}  {im.size[0]}x{im.size[1]} {im.mode}  {path.stat().st_size // 1024}KB')


if __name__ == '__main__':
    main()
