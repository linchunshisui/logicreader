
from PIL import Image, ImageDraw
img = Image.new('RGB', (420, 240), (255, 255, 255))
d = ImageDraw.Draw(img)
colors = [(66,133,244),(219,68,55),(244,160,0),(15,157,88),(171,71,188)]
for i, c in enumerate(colors):
    d.rectangle([20 + i*78, 200 - (i+1)*30, 20 + i*78 + 60, 200], fill=c)
d.line([(20, 200), (400, 200)], fill=(120,120,120), width=2)
d.text((20, 12), "Quarterly Revenue (test image)", fill=(20,20,20))
img.save(r'D:\逻辑阅读器\tests\fixtures\chart.png')
print('png ok')
