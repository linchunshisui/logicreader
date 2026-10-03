
from PIL import Image, ImageDraw
sizes = [16, 24, 32, 48, 64, 128, 256]
img = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
# 圆角底板
d.rounded_rectangle([8, 8, 248, 248], radius=48, fill=(30, 30, 30, 255))
# 三个节点 + 连线（逻辑图意象）
def node(cx, cy, r, color):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)
d.line([(78, 78), (78, 178)], fill=(120, 170, 220, 255), width=10)
d.line([(78, 78), (178, 78)], fill=(120, 170, 220, 255), width=10)
d.line([(78, 128), (178, 178)], fill=(120, 170, 220, 255), width=8)
node(78, 78, 26, (61, 127, 209, 255))
node(178, 78, 22, (111, 191, 115, 255))
node(78, 178, 22, (224, 164, 88, 255))
node(178, 178, 24, (198, 120, 221, 255))
img.save(r'D:\逻辑阅读器\resources\icons\app.png')
img.save(r'D:\逻辑阅读器\resources\icons\app.ico', sizes=[(s, s) for s in sizes])
print('icons ok')
