# Gera os icones da extensao (pin branco em fundo azul arredondado).
# Rodar: py -3.12 gerar.py  (na pasta icons/)
from PIL import Image, ImageDraw

AZUL = (26, 115, 232, 255)
BRANCO = (255, 255, 255, 255)

def icone(tam):
    s = 8  # supersampling para borda lisa
    n = tam * s
    im = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, n - 1, n - 1], radius=n * 0.22, fill=AZUL)
    # pin: circulo + triangulo apontando para baixo
    cx, cy, r = n / 2, n * 0.40, n * 0.22
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=BRANCO)
    d.polygon([(cx - r * 0.86, cy + r * 0.5), (cx + r * 0.86, cy + r * 0.5), (cx, n * 0.86)], fill=BRANCO)
    # furo do pin
    d.ellipse([cx - r * 0.42, cy - r * 0.42, cx + r * 0.42, cy + r * 0.42], fill=AZUL)
    return im.resize((tam, tam), Image.LANCZOS)

for tam in (16, 32, 48, 128):
    icone(tam).save(f"icon{tam}.png")
    print("ok", tam)
