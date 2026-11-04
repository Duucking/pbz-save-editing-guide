PBZS 工具包使用说明
==================

这些脚本是《影之刃零》PBZS v3 存档读写的参考实现，按“输入/输出路径”传参，不写死游戏目录。

一、准备 Oodle 解码器
--------------------
1. 下载 OodleUE release（例如 2026-06-04-1357）：
   https://github.com/WorkingRobot/OodleUE/releases
   取 clang-cl-x64-release.zip。
2. 解压后把 bin/oodle-data-shared.dll 放到本目录，或设置环境变量：
   set OODLE_DLL=G:\path\to\oodle-data-shared.dll
3. 需要支持 Kraken 的新版本；oo2core_5_win64.dll 解不了本作的块。

二、最小流程
------------
set GAME=G:\SteamLibrary\steamapps\common\PBZ
set SAVE=%GAME%\ProjectPBZ\Saved\SaveGames\Steam\<SteamID>\PBZSaveGame.sav
set WORK=G:\work\pbz

1) 看槽表 / 验证 key
   node pbz.js "%SAVE%" "%GAME%"

2) 导出所有槽的压缩载荷
   node pbz_dump.js "%SAVE%" "%GAME%" "%WORK%\slots"

3) 解成 JSON
   python pbz_decompress.py "%WORK%\slots" "%WORK%\json" oodle-data-shared.dll

4) 改任务（示例：只补第 3 个子任务，保持进行中）
   python pbz_quest_patch.py "%WORK%\json\AutoSave0.json" "%WORK%\json\AutoSave0_patch.json" ^
       RongShuZhiXin --tasks 1,1,1,0,0 --active --date 2026.11.04-01:14:00

   整条完成（原生完成态，数组清 0）：
   python pbz_quest_patch.py ... --tasks 0,0,0,0,0 --complete --time

5) 补世界 actor 状态（可选，树图标/交互）
   python pbz_actor_tag_fix.py "%WORK%\json\AutoSave0_patch.json" "%WORK%\json\AutoSave0_tree.json" ^
       --actor PBZ_Houjie_WP-StaticMeshActor_UAID_E89C25A7512023B302_1167014368 ^
       --tag "rszx.榕树之心.完成挑战3" ^
       --tag "music.解锁条件.完成第一个大榕树" ^
       --sequence-play

6) 重打包
   写 spec.json：
   {"slots":{"AutoSave0":"G:\\work\\pbz\\json\\AutoSave0_tree.json"}}
   node pbz_repack.js "%SAVE%" "%GAME%" spec.json "%WORK%\PBZSaveGame_patched.sav"

7) 回读校验
   node pbz.js "%WORK%\PBZSaveGame_patched.sav" "%GAME%"
   node pbz_dump.js "%WORK%\PBZSaveGame_patched.sav" "%GAME%" "%WORK%\verify_slots"
   python pbz_decompress.py "%WORK%\verify_slots" "%WORK%\verify_json" oodle-data-shared.dll

三、注意
--------
- 改之前整目录备份，记录原文件 SHA-256。
- 只改要载入的槽；“继续游戏”看 __Advanced__.LastContinueSlot。
- 游戏更新后 key 会变，先跑 pbz.js 验证，不要硬编码旧 key。
- 写回后文件变大是正常的：stored 块不压缩。
- 这些脚本是示例实现，按你的游戏版本/路径调整；不要用于联机作弊或传播他人存档。
