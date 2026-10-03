# 產生「字型沒有的字 -> 繁體對應字」對照表 src/main/charFallback.json
# 屏幕的中文字型(Noto Sans TC)缺少日文專用漢字(例如「粋」)與簡體專用字；桌面工具在產生看板數據時，
# 把這些字換成字型有的繁體寫法(粋->粹)，不用換字型(屏幕的字型渲染器只編譯了 TrueType，不支援 CFF 格式的完整 CJK 字型)
# 用法：pip install fonttools opencc-python-reimplemented，然後 python make_fallback_map.py
import json
import os

import opencc
from fontTools.ttLib import TTFont

import make_fonts

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', 'src', 'main', 'charFallback.json')


def jp_variants_reverse():
    """OpenCC 的 JPVariants.txt 是「繁體 -> 日文新字體」，這裡反過來用：日文漢字 -> 繁體"""
    path = os.path.join(os.path.dirname(opencc.__file__), 'dictionary', 'JPVariants.txt')
    rev = {}
    for line in open(path, encoding='utf-8'):
        parts = line.rstrip('\n').split('\t')
        if len(parts) < 2:
            continue
        for jp in parts[1].split():
            if len(jp) == 1 and len(parts[0]) == 1:
                rev.setdefault(jp, parts[0])
    return rev


def main():
    cmap = TTFont(make_fonts.SOURCE).getBestCmap()
    have = lambda c: ord(c) in cmap
    # 候選：日文 JIS X 0208 與簡體 GB2312 裡，字型沒有的字
    wanted = [c for c in make_fonts.charset() if not have(c)]
    converters = [opencc.OpenCC(cfg) for cfg in ('s2t', 's2tw')]
    jp_to_t = jp_variants_reverse()
    mapping = {}
    for ch in wanted:
        candidates = [jp_to_t.get(ch)] + [cv.convert(ch) for cv in converters]
        for out in candidates:
            if out and len(out) == 1 and out != ch and have(out):
                mapping[ch] = out
                break
    json.dump(mapping, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=0, sort_keys=True)
    print(f'字型缺 {len(wanted)} 字，找到繁體對應 {len(mapping)} 個 -> {os.path.normpath(OUT)}')
    for ch in '粋简国专乱':
        print(' ', ch, '->', mapping.get(ch, '(字型已有/無對應)'))


if __name__ == '__main__':
    main()
