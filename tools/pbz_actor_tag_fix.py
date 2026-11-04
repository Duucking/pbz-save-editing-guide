"""给 PBZ 存档里的某个世界 actor 补 EventTag / LevelSequenceHasPlay。

用法：
  python pbz_actor_tag_fix.py src.json dst.json \
      --actor PBZ_Houjie_WP-StaticMeshActor_UAID_..._1167014368 \
      --tag "rszx.榕树之心.完成挑战3" \
      --tag "music.解锁条件.完成第一个大榕树" \
      --sequence-play

  # 只知道前缀时，用 --contains 指定该 actor 现有 EventTag 里的关键字，避免选错
  python pbz_actor_tag_fix.py src.json dst.json \
      --prefix PBZ_Houjie_WP-StaticMeshActor --contains 开启任务3 \
      --tag "rszx.榕树之心.完成挑战3" --sequence-play
"""
import argparse
import json


def eventtag_marker(key):
    return f'"{key}":{{"EventTag":['


def find_actor(text, actor=None, prefix=None, contains=None):
    if actor:
        if eventtag_marker(actor) not in text:
            raise SystemExit(f'actor EventTag entry not found: {actor}')
        return actor
    if prefix:
        if not contains:
            raise SystemExit('--prefix 需要同时给 --contains，避免匹配到别的 actor')
        start = 0
        while True:
            i = text.find(f'"{prefix}', start)
            if i < 0:
                break
            j = text.find('"', i + 1)
            key = text[i + 1:j]
            marker = eventtag_marker(key)
            k = text.find(marker)
            if k >= 0:
                arr_end = text.find(']}', k)
                if arr_end >= 0 and contains in text[k:arr_end]:
                    return key
            start = i + 1
        raise SystemExit(f'actor not found: prefix={prefix} contains={contains}')
    raise SystemExit('need --actor or (--prefix + --contains)')


def add_tags(text, key, tags):
    marker = eventtag_marker(key)
    start = text.find(marker)
    if start < 0:
        raise SystemExit('EventTag entry not found')
    arr_start = start + len(marker) - 1  # 指向 '['
    arr_end = text.find(']}', arr_start)
    if arr_end < 0:
        raise SystemExit('EventTag array end not found')
    inner = text[arr_start + 1:arr_end]
    add = []
    for tag in tags:
        q = json.dumps(tag, ensure_ascii=False)
        if q not in inner:
            add.append(q)
    if not add:
        return text
    sep = ',' if inner.strip() else ''
    return text[:arr_end] + sep + ','.join(add) + text[arr_end:]


def add_sequence_play(text, key):
    marker = '"LevelActorManager":{'
    pos = text.find(marker)
    if pos < 0:
        raise SystemExit('LevelActorManager not found')
    insert_at = pos + len(marker)
    if f'"{key}":' in text[insert_at:insert_at + 500000]:
        return text
    entry = f'"{key}":{{"LevelSequenceHasPlay":true}},'
    return text[:insert_at] + entry + text[insert_at:]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--actor', help='完整 actor key')
    ap.add_argument('--prefix', help='actor key 前缀（需配合 --contains）')
    ap.add_argument('--contains', help='用现有 EventTag 里的关键字确认 actor')
    ap.add_argument('--tag', action='append', default=[], help='要追加的 EventTag，可多次')
    ap.add_argument('--sequence-play', action='store_true', help='写 LevelSequenceHasPlay=true')
    args = ap.parse_args()
    text = open(args.src, encoding='utf-8').read()
    key = find_actor(text, args.actor, args.prefix, args.contains)
    if args.tag:
        text = add_tags(text, key, args.tag)
    if args.sequence_play:
        text = add_sequence_play(text, key)
    open(args.dst, 'w', encoding='utf-8', newline='').write(text)
    print(f'patched {key} -> {args.dst} ({len(text)} chars)')


if __name__ == '__main__':
    main()
