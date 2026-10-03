# 產生電子紙用的中文字型：從 Google Noto Sans TC 可變字重字型，切出 Regular(400)/Bold(700) 兩個靜態字重，
# 只保留 ASCII、常用符號與 Big5(繁體)+JIS X 0208(日文漢字)+GB2312(簡體)的字元，放到屏幕內建 Flash 的 /fonts/ 由屏幕按需讀取
# 用法：pip install fonttools，然後 python make_fonts.py(會自動下載原始字型)
import os
import urllib.request
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, 'NotoSansTC-VF.ttf')
SOURCE_URL = 'https://github.com/google/fonts/raw/main/ofl/notosanstc/NotoSansTC%5Bwght%5D.ttf'
EXTRA = '　、。，．・：；？！︰…‧─│★☆●○◆◇■□▲△▼▽→←↑↓✓✔✕✗×÷±≦≧≠％＄＃＆＊＠（）〔〕【】「」『』《》〈〉°℃‘’“”'


def decode_double_byte(codec, lead_range, trail_range):
    out = set()
    for hi in lead_range:
        for lo in trail_range:
            try:
                out.add(bytes([hi, lo]).decode(codec))
            except UnicodeDecodeError:
                pass
    return out


def charset():
    chars = set(chr(c) for c in range(0x20, 0x7F)) | set(EXTRA)
    # Big5：繁體常用+次常用
    chars |= decode_double_byte('big5', range(0xA1, 0xFA), list(range(0x40, 0x7F)) + list(range(0xA1, 0xFF)))
    # 日文 JIS X 0208(例如「粋」這類日文漢字變體，專案/客戶名稱偶爾會出現)
    chars |= decode_double_byte('shift_jis', list(range(0x81, 0xA0)) + list(range(0xE0, 0xEB)), range(0x40, 0xFD))
    # 簡體 GB2312
    chars |= decode_double_byte('gb2312', range(0xA1, 0xF8), range(0xA1, 0xFF))
    return ''.join(sorted(chars))


def main():
    if not os.path.exists(SOURCE):
        print('下載', SOURCE_URL)
        urllib.request.urlretrieve(SOURCE_URL, SOURCE)
    text = charset()
    for weight, name in ((400, 'Regular'), (700, 'Bold')):
        font = instancer.instantiateVariableFont(TTFont(SOURCE), {'wght': weight})
        opts = subset.Options()
        opts.layout_features = ['*']
        opts.hinting = False
        opts.name_IDs = ['*']
        opts.notdef_outline = True
        sub = subset.Subsetter(opts)
        sub.populate(text=text)
        sub.subset(font)
        out = os.path.join(HERE, 'NotoSansTC-%s.ttf' % name)
        font.save(out)
        print(out, os.path.getsize(out) // 1024, 'KB')


if __name__ == '__main__':
    main()
