"""Surgically patch one quest inside a PBZ save JSON (no full re-serialize).

Examples:
  # 只把「榕树之心」第 3/4/5 棵树标成已调查，任务保持进行中
  python pbz_quest_patch.py src.json dst.json RongShuZhiXin --tasks 1,1,1,1,1

  # 按原生“已完成”形态收尾：任务成功、分支完成、任务数组清零
  python pbz_quest_patch.py src.json dst.json RongShuZhiXin --complete --time
"""
import json
import argparse

DATE = "2026.11.04-00.45.00"


def find_object(text, needle):
    pos = text.find(needle)
    if pos < 0:
        raise SystemExit(f"quest not found: {needle}")
    start = text.rfind('{', 0, pos)
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == '\\':
                esc = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    return start, i + 1
    raise SystemExit("unbalanced object")


def patch(text, quest, branch=None, tasks=None, complete=False, time=False, date=DATE, active=False):
    section = text.find('"NarrativeSavedQuests":')
    if section < 0:
        raise SystemExit('NarrativeSavedQuests not found')
    start, end = find_object(text[section:], f'{quest}.{quest}_C"')
    start += section
    end += section
    q = json.loads(text[start:end])
    if complete and active:
        raise SystemExit('--complete 与 --active 不能同时使用')
    if tasks is None and not complete and not active:
        complete = True  # 兼容旧用法：不带参数时直接完成任务
    branches = q.get("QuestBranches", [])
    target = [b for b in branches if branch is None or b.get("BranchID") == branch]
    if not target:
        raise SystemExit(f"branch not found: {branch}")

    if tasks is not None:
        vals = [int(x) for x in tasks.split(',') if x.strip() != '']
        for b in target:
            cur = b.get("TasksProgress")
            if not isinstance(cur, list) or len(cur) != len(vals):
                raise SystemExit(f"TasksProgress length mismatch: {cur} vs {vals}")
            b["TasksProgress"] = vals
    elif complete:
        # 原生已完成任务的 TasksProgress 会被清成 0
        for b in target:
            if isinstance(b.get("TasksProgress"), list):
                b["TasksProgress"] = [0 for _ in b["TasksProgress"]]

    if complete:
        done = q.setdefault("CompletedBranches", [])
        for b in target:
            b["BranchType"] = "EBranchType::BranchCompleted"
            b["DirtyTime"] = date
            if b.get("BranchID") not in done:
                done.append(b["BranchID"])
        q["QuestCompletion"] = "EQuestCompletion::QC_Succeded"

    if active:
        # 把整条任务从“已完成”退回“进行中”，只保留 TasksProgress 里已置 1 的进度
        q["QuestCompletion"] = "EQuestCompletion::QC_Started"
        ids = {b.get("BranchID") for b in target}
        for b in target:
            b["BranchType"] = "EBranchType::BranchActivating"
            b["DirtyTime"] = date
        done = [x for x in q.get("CompletedBranches", []) if x not in ids]
        if done:
            q["CompletedBranches"] = done
        else:
            q.pop("CompletedBranches", None)

    new = json.dumps(q, ensure_ascii=False, separators=(",", ":"))
    out = text[:start] + new + text[end:]

    if time:
        # QuestGameTimes 里同步成当前游戏时间，和原生完成时一致
        import re
        m = re.search(r'"HasGameTime":(\d+)', out)
        if m:
            gt = int(m.group(1))
            pos = out.find('"QuestGameTimes":')
            if pos >= 0:
                i = out.find(f'{quest}.{quest}_C', pos)
                if i >= 0:
                    gpos = out.find('"GameTime":', i)
                    if gpos >= 0:
                        j = gpos + len('"GameTime":')
                        k = j
                        while k < len(out) and out[k].isdigit():
                            k += 1
                        out = out[:j] + str(gt) + out[k:]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("quest", help="QuestClass 里的短名，例如 RongShuZhiXin")
    ap.add_argument("--branch", help="只改这个 BranchID")
    ap.add_argument("--tasks", help="精确设置 TasksProgress，逗号分隔，例如 1,1,1,1,1")
    ap.add_argument("--complete", action="store_true", help="标记任务/分支完成")
    ap.add_argument("--active", action="store_true", help="退回进行中（配合 --tasks 使用）")
    ap.add_argument("--time", action="store_true", help="同步 QuestGameTimes 到当前游戏时间")
    ap.add_argument("--date", default=DATE, help="DirtyTime 时间串")
    args = ap.parse_args()
    text = open(args.src, encoding="utf-8").read()
    out = patch(text, args.quest, args.branch, args.tasks, args.complete, args.time, args.date, args.active)
    open(args.dst, "w", encoding="utf-8", newline="").write(out)
    print(f"patched {args.quest} -> {args.dst} ({len(text)} -> {len(out)} chars)")


if __name__ == "__main__":
    main()
