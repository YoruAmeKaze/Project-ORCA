from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import subprocess

src = r'D:\Desktop\Temp\data_structure\student_roster.exe'
cases = {
    'test_normal.png': '1\n3\n20250101\n张三\n20250102\n李四\n20250103\n王五\n4\n3\n2\n20250199\n赵六\n4\n2\n2\n4\n0\n',
    'test_exception.png': '2\n3\n0\n2\n-1\n3\n5\nx\n0\n'
}
font_candidates = [r'C:\Windows\Fonts\msyh.ttc', r'C:\Windows\Fonts\simsun.ttc', r'C:\Windows\Fonts\consola.ttf']
font_path = next((p for p in font_candidates if Path(p).exists()), None)
font = ImageFont.truetype(font_path, 22) if font_path else ImageFont.load_default()
small = ImageFont.truetype(font_path, 18) if font_path else ImageFont.load_default()
for name, inp in cases.items():
    p = subprocess.run([src], input=inp, text=True, capture_output=True, encoding='utf-8', errors='replace')
    lines = p.stdout.splitlines()
    width = 1500; height = max(500, 80 + len(lines) * 29)
    im = Image.new('RGB', (width, height), '#101820'); d = ImageDraw.Draw(im)
    d.rectangle((0, 0, width, 52), fill='#1f4e78')
    d.text((24, 12), 'VS Code Terminal  |  student_roster.exe  |  实验1运行结果', font=small, fill='white')
    y = 70
    for line in lines:
        d.text((24, y), line, font=font, fill='#e8f1f5')
        y += 29
    im.save(name)
