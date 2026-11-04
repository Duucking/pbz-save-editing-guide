# 影之刃零 PBZS v3 存档解码、读取与任务修改指南

> 适用：Steam《Phantom Blade Zero / 影之刃零》
> 实测 build：`26266538`（2026-11）
> 用途：单机存档修复、任务数据研究、坏档自救
> 原则：**先备份、只改自己的档、改完先回读校验再进游戏**

---

## 0. 一分钟版

1. 完全退出游戏，整目录备份 `...\SaveGames\Steam\<SteamID>\`。
2. 从 `platform/steam/PBZ.exe` 里按锚点定位 32 字节 AES 密钥。
3. 解 `PBZSaveGame.sav`：`PBZS v3` 容器 → AES-256-GCM 块 → 目录 → 各槽 Oodle Kraken 数据。
4. 把目标槽解成 JSON，修改 `Narrative.NarrativeSavedQuests[]` 里的任务字段。
5. 用 Oodle stored 块重编码，重新 AES-GCM 加密，重排目录 offset/size，写回。
6. 回读：GCM 认证、目录 tiling、解压、目标槽 JSON、其它槽 SHA 不变。
7. 覆盖回游戏目录，进游戏点“继续游戏”验证。

---

## 1. 环境与工具

### 1.1 需要的环境

- Windows 10/11
- Node.js 18+（用内置 `crypto` 做 AES-256-GCM）
- Python 3.9+（解析 JSON、调用 Oodle DLL、改文本）
- 一个支持 Kraken 的 Oodle 解码库（见 §6）

> 不需要安装 `cryptography`、`pycryptodome`；Node 自带 AES-GCM 就够了。
> Python 只负责 JSON/文本处理，Oodle 通过 `ctypes` 调 DLL。

### 1.2 本指南配套脚本

| 脚本 | 作用 |
|---|---|
| `pbz.js` | 定位密钥、解目录、打印槽表、校验 tiling |
| `pbz_slot.js` | 只解某一个槽的密文载荷（仍是 Oodle 压缩态） |
| `pbz_dump.js` | 解目录并导出所有槽的密文载荷 |
| `pbz_decompress.py` | 用 Oodle DLL 把槽载荷解成 JSON（第三个参数可指定 DLL 路径） |
| `pbz_quest_patch.py` | 只替换目标任务对象，改任务字段 |
| `pbz_actor_tag_fix.py` | 给任务对应的世界 actor 补 EventTag / LevelSequenceHasPlay |
| `pbz_repack.js` | 重编码 stored 块、重新加密、重排目录、写回 `.sav` |

所有脚本都按“输入路径/输出路径”传参，不写死游戏目录。

---

## 2. 存档位置与备份

### 2.1 真实路径

本作是 UE5 打包，但存档不是 UE 的 `GVAS`，而是自研 `PBZS v3`：

```
<游戏安装目录>\ProjectPBZ\Saved\SaveGames\Steam\<SteamID>\
    PBZSaveGame.sav              ← 主容器（继续游戏读它）
    steam_autocloud.vdf
    1RealTime\*.sav              ← 实时滚动备份
    2Hourly\*.sav                ← 小时档
    3Daily\*.sav                 ← 日档
```

示例：

```
G:\SteamLibrary\steamapps\common\PBZ\ProjectPBZ\Saved\SaveGames\Steam\<SteamID>\
```

### 2.2 先备份

关游戏后，把整个 `<SteamID>` 目录复制/压缩一份，文件名带时间戳。至少保留：

- `PBZSaveGame.sav` 原始文件
- `1RealTime/2Hourly/3Daily`
- `steam_autocloud.vdf`

备份后**校验**：

```powershell
(Get-FileHash .\PBZSaveGame.sav -Algorithm SHA256).Hash
```

把原始 SHA-256 记下来，后面回滚和比对都用得上。

---

## 3. PBZS v3 容器格式

### 3.1 文件头（12 字节）

| 偏移 | 大小 | 含义 |
|---|---|---|
| 0x00 | 4 | ASCII `PBZS` |
| 0x04 | 1 | 容器版本，实测 `3` |
| 0x05 | 1 | flags，实测 `1` |
| 0x06 | 2 | `uint16` 槽数（示例 16） |
| 0x08 | 4 | `uint32` 目录块总长（含 36 字节块头） |
| 0x0C | — | 目录块，之后是 N 个槽块 |

### 3.2 每个块的 36 字节头

```
"PBZS\x01\x01\x00\x00"  (8 字节，块魔数/版本)
nonce                    (12 字节)
GCM tag                  (16 字节)
ciphertext               (剩余)
```

**最容易踩的坑：GCM tag 在密文前面，不是常见的“密文 + tag”。**
Node 里要 `setAuthTag(tag)`；写回时 `getAuthTag()` 后拼在 nonce 后面。

- 算法：AES-256-GCM
- 无 AAD
- 每个块独立随机 nonce
- `nonce` 必须每次写回重新生成，不能复用

### 3.3 目录块明文

目录块解密后：

```
12 字节头： "PBZS" + version(3) + flags(1) + slotCount(u16) + dirSize(u32)
然后 slotCount 条记录：
  uint16 nameLen
  name        (UTF-8)
  uint8  algo    0=raw 1=zlib 2=Oodle Kraken
  uint8  flag    通常 1，原样保留
  uint32 rawSize    解压后 JSON 字节数
  uint32 offset     相对 12+dirSize 的偏移
  uint32 blockSize  该槽块总长（含 36 字节头）
```

**第二个坑：`offset` 不是文件绝对偏移，而是相对 `12 + dirSize`。**
校验时用 `offset` 连续累加，最后应正好等于文件长度。

---

## 4. 定位 AES 密钥

### 4.1 原理

密钥不在服务器，也不按账号派生；它是**每个 build 一个常量**，藏在 `PBZ.exe` 里。

在 exe 中搜索 UTF-16LE 字符串：

```
sealed but block is PLAINTEXT
```

以该字符串结尾为起点，在 `0~15` 字节的 padding 范围内尝试读 64 字节材料：

```
key = material[0:32] XOR material[32:64]
```

然后用这个 key 去解文件 0x0C 处的目录块；**GCM 认证通过**就说明 key 找对了。

### 4.2 已验证值（build 26266538）

```
文件：platform/steam/PBZ.exe
锚点：sealed but block is PLAINTEXT（UTF-16LE）
材料偏移：0xC1C7B28（203,193,128）
key = 15a1fe0f55e0eb298e7c9461548351696a2a0700ed2d17ba1f871457e8f93e2d
```

**不要把 key 写死到通用工具里**：游戏更新后位置/值会变。正确做法是每次从 exe 现场定位，并用目录 GCM 认证验证。

### 4.3 定位伪代码（Node）

```js
const ANCHOR = Buffer.from('sealed but block is PLAINTEXT', 'utf16le');
// 扫 exe，找到 ANCHOR 后，从 end+pad (pad=0..15) 读 64 字节
const mat = exe.slice(at + pad, at + pad + 64);
const key = Buffer.alloc(32);
for (let i = 0; i < 32; i++) key[i] = mat[i] ^ mat[i + 32];
// 用 key 解目录块，GCM final() 不抛异常 = 命中
```

---

## 5. 解密与读取

### 5.1 解密一个块（Node）

```js
function openBlock(save, key, off, len) {
  const nonce = save.slice(off + 8, off + 20);
  const tag   = save.slice(off + 20, off + 36);
  const ct    = save.slice(off + 36, off + len);
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
```

### 5.2 读目录

```js
const count = save.readUInt16LE(6);
const dirSize = save.readUInt32LE(8);
const dir = openBlock(save, key, 12, dirSize);
const base = 12 + dirSize;
let p = 12;
for (let i = 0; i < count; i++) {
  const n = dir.readUInt16LE(p); p += 2;
  const name = dir.slice(p, p + n).toString('utf8'); p += n;
  const algo = dir[p], flag = dir[p + 1]; p += 2;
  const rawSize = dir.readUInt32LE(p); p += 4;
  const offset  = dir.readUInt32LE(p); p += 4;
  const blockSize = dir.readUInt32LE(p); p += 4;
  // 绝对位置 = base + offset
}
```

### 5.3 目录/槽的常见内容

| 槽 | 内容 |
|---|---|
| `__Advanced__` | 账号级：`LastContinueSlot`、衣柜、Boss 记录、LoadingTips |
| `AutoSave0/1/2` | 自动存档（继续游戏通常读 `LastContinueSlot`） |
| `__Achievements__` | 成就 `UnlockedIds` / `Counters` |
| `ManualSave1..11` | 手动存档 |

> 只改你要载入的那个槽。手动档之间互不影响；“继续游戏”读 `__Advanced__.LastContinueSlot` 指向的槽。

---

## 6. 解压 Oodle Kraken

### 6.1 为什么需要 Oodle

`algo=2` 的槽不是 zlib，而是 Oodle Kraken。Oodle 没有公开编码器，但**解码器**可用。

### 6.2 可用的解码器

1. **OodleUE 的 `oodle-data-shared.dll`**（本指南实测）
   - 版本需足够新（支持 Kraken；`oo2core_5` 太老，实测解不出）
   - 从 OodleUE release 下载 `clang-cl-x64-release.zip`，里面有 `bin/oodle-data-shared.dll`
   - 这是最省事的路线

2. **oozextract**（MIT，Rust）
   - https://github.com/lvlvllvlvllvlvl/oozextract
   - 只有源码，没有现成 Windows release；需要 Rust 工具链
   - 支持 Kraken / Mermaid / Selkie / Leviathan / LZNA / Bitknit

3. **PBZ-Editor 的 `pbz_codec.dll`**
   - https://github.com/qry6868/PBZ-Editor
   - 项目自带开放解码组件，ABI 为 `pbz_decode(data, len, out, outSize)`

> `oo2core_5_win64.dll`（RDR2 自带）实测**不能**解本作的 Kraken 块，不要用它。

### 6.3 Python ctypes 调用

```python
import ctypes
lib = ctypes.CDLL(r'...\oodle-data-shared.dll')
lib.OodleLZ_Decompress.restype = ctypes.c_ssize_t
lib.OodleLZ_Decompress.argtypes = [
    ctypes.c_char_p, ctypes.c_ssize_t,          # comp, compSize
    ctypes.c_char_p, ctypes.c_ssize_t,          # raw, rawSize
    ctypes.c_int, ctypes.c_int, ctypes.c_int,   # fuzzSafe, checkCRC, verbosity
    ctypes.c_void_p, ctypes.c_ssize_t,          # decBufBase, decBufSize
    ctypes.c_void_p, ctypes.c_void_p,           # callback, userData
    ctypes.c_void_p, ctypes.c_ssize_t,          # decoderMemory, memorySize
    ctypes.c_int                                # threadPhase (3 = All)
]

def oodle_decompress(data, size):
    out = ctypes.create_string_buffer(size)
    n = lib.OodleLZ_Decompress(data, len(data), out, size, 1, 0, 0,
                               None, 0, None, None, None, 0, 3)
    if n != size:
        raise RuntimeError(f'oodle failed: {n} != {size}')
    return out.raw
```

`size` 用目录里的 `rawSize`。解出来应当是一段完整 JSON（以 `{` 开头）。

---

## 7. 存档 JSON 数据模型

### 7.1 顶层

示例顶层键：

```
PBZGameSystem, BellManager, MapSubsystem, EventPipeline,
LevelActorManager, None, ShopSystem, UIVisibilityManager,
PBZDeathMeta, AISystem, Inventory, Player, Narrative,
BossRecord, PBZAppearanceComponent, ...
```

任务相关主要在 `Narrative`；世界 actor 状态在 `EventPipeline` / `LevelActorManager`。

### 7.2 任务结构

`Narrative.NarrativeSavedQuests[]`，每个任务一条：

```json
{
  "QuestClass": "/Game/PBZstory/PBZQuest/Collect/RongShuZhiXin.RongShuZhiXin_C",
  "QuestBranches": [
    {
      "BranchID": "1",
      "TasksProgress": [1, 1, 0, 0, 0],
      "BranchType": "EBranchType::BranchActivating",
      "DirtyTime": "2026.11.01-00.30.32"
    }
  ],
  "QuestCompletion": "EQuestCompletion::QC_Started",
  "CompletedBranches": [],
  "ReachedStateNames": []
}
```

字段说明：

| 字段 | 含义 |
|---|---|
| `QuestClass` | 任务蓝图路径 |
| `QuestBranches[]` | 分支列表 |
| `BranchID` | 分支 ID，字符串，如 `"1"`、`"S1"`、`"2"` |
| `TasksProgress[]` | 该分支每个子任务的完成标志，`1`=完成，`0`=未完成 |
| `BranchType` | `EBranchType::None` / `BranchActivating` / `BranchCompleted` |
| `DirtyTime` | 最后修改时间，字符串，格式 `YYYY.MM.DD-HH.MM.SS` |
| `QuestCompletion` | `EQuestCompletion::QC_Started` / `QC_Succeded` |
| `CompletedBranches` | 已完成分支 ID 数组 |
| `ReachedStateNames` | 任务状态机节点，通常为空，非必要不要动 |

其他：

- `Narrative.QuestGameTimes[]`：任务时间记录，`{QuestClass, GameTime}`；不是严格的先后顺序依据，修改时可不动。
- `Narrative.MainQuestUpdateRecords[]`：主线推进记录。
- `Narrative.CurrentMainQuestPath` / `LastUpdatedMainQuestPath`：当前/最近主线。
- `PBZGameSystem.NarrativePercentage`：不是任务进度条，别拿它当完成度。

### 7.3 `TasksProgress` 的语义（重要）

- 进行中：`1` = 该子任务已完成，`0` = 未完成。
- **任务完成时，游戏会把整个数组清成 0**，同时把分支设为 `BranchCompleted`、任务设为 `QC_Succeded`。

实测对照（同一条收集任务）：

```
进行中： [1,1,1,1,0]  QC_Started
完成后： [0,0,0,0,0]  QC_Succeded / BranchCompleted
```

所以：

- “只补第 N 个子任务” → 把第 N 位设 1，保持 `QC_Started` / `BranchActivating`。
- “整条完成” → 数组清 0 + `QC_Succeded` + `BranchCompleted` + `CompletedBranches`，不要写全 1。

### 7.4 世界树/actor 状态（进阶）

任务计数和世界 actor 的“已完成”图标是**两套数据**。典型任务（如“榕树之心”）：

- 任务进度在 `NarrativeSavedQuests[].QuestBranches[].TasksProgress`
- 树的交互状态在：
  - `EventPipeline.ComponentInfoJson[actorKey].EventTag[]`
  - `LevelActorManager[actorKey].LevelSequenceHasPlay`
  - `EventPipeline.ExecuteNodeGuid[actorKey_<GUID>] = true`

完成的树，EventTag 通常包含：

```
rszx.<任务名>.开启任务N
rszx.<任务名>.完成挑战N
music.解锁条件.完成第一个大榕树
```

并且 `LevelActorManager[actorKey] = {"LevelSequenceHasPlay": true}`。

**只改 `TasksProgress` 可能只让任务显示 N/5，树图标仍显示未完成**——这时要补 actor 状态。

### 7.5 怎么定位任务对应的 actor

1. 在 `EventPipeline.ComponentInfoJson` 里搜 `EventTag` 含任务短名的条目，例如：
   - `rszx.榕树之心.开启任务3`
   - `rszx.榕树之心.完成挑战3`
2. 找到 `开启任务N` 的 actor key。
3. 用历史档对比：`TasksProgress` 第 N 位从 0 变 1 的前后，`LevelActorManager` 里新增/变化的 key 就是这棵树的 actor。
4. 完成态对照：
   - EventTag 同时有 `开启任务N`、`完成挑战N`、`music.解锁条件...`
   - `LevelActorManager[actor].LevelSequenceHasPlay == true`
   - 通常有两个 `ExecuteNodeGuid[actorKey_<GUID>] == true`

> `ExecuteNodeGuid` 的 GUID 是关卡事件图节点 ID，不在存档里生成。缺失时只能从关卡资产或其它完成档里找，**不要伪造**。

---

## 8. 修改任务（三种场景）

以下命令以 `pbz_quest_patch.py` 为例。它只替换目标 JSON 对象，其余字节不动。

### 8.1 只补某个子任务，保持进行中

```powershell
python pbz_quest_patch.py .\AutoSave0.json .\AutoSave0_patch.json `
  RongShuZhiXin --tasks 1,1,1,0,0 --active `
  --date 2026.11.04-01:14:00
```

- `--tasks` 必须和原数组长度一致。
- `--active` 会把任务退回 `QC_Started` / `BranchActivating`，并移除 `CompletedBranches`。
- 不写 `--active` 时，只改数组，任务状态保持原样。

### 8.2 整条任务完成（原生完成态）

```powershell
python pbz_quest_patch.py .\AutoSave0.json .\AutoSave0_done.json `
  RongShuZhiXin --tasks 0,0,0,0,0 --complete --time
```

效果：

- `QuestCompletion` → `QC_Succeded`
- 分支 → `BranchCompleted`
- `CompletedBranches` 写入分支 ID
- `TasksProgress` → 全 0（对齐原生）
- `--time` 会把 `QuestGameTimes` 同步到当前 `HasGameTime`

### 8.3 从“已完成”退回“进行中”

```powershell
python pbz_quest_patch.py .\AutoSave0.json .\AutoSave0_active.json `
  RongShuZhiXin --tasks 1,1,0,0,0 --active
```

用于“整条完成改多了，想继续做剩下部分”。

### 8.4 补世界树 actor 状态

```powershell
python pbz_actor_tag_fix.py .\AutoSave0.json .\AutoSave0_tree.json `
  --actor PBZ_Houjie_WP-StaticMeshActor_UAID_E89C25A7512023B302_1167014368 `
  --tag "rszx.榕树之心.完成挑战3" `
  --tag "music.解锁条件.完成第一个大榕树" `
  --sequence-play
```

- `--actor` 也可以改用 `--prefix` 传前缀，但要同时用 `--contains` 指定该 actor 现有 EventTag 里的关键字（例如 `开启任务3`），避免选错 actor。
- `--sequence-play` 会写 `LevelActorManager[actor] = {"LevelSequenceHasPlay": true}`。
- 如果该树还缺第二个 `ExecuteNodeGuid`，本脚本不会伪造 GUID；需要从关卡资产里找（见 §11）。

---

## 9. 重打包（写回 .sav）

### 9.1 为什么不能直接改密文

槽数据是 Oodle 压缩后再 AES-GCM 加密的；改 JSON 后必须：

1. 把新 JSON 编成 Oodle 块；
2. 用新 nonce 重新 AES-GCM 加密；
3. 重排目录的 `rawSize/offset/blockSize`；
4. 重新加密目录块；
5. 重写文件头。

### 9.2 没有 Oodle 编码器怎么办

用 **stored/raw 块** 伪装成 Kraken，`algo` 仍写 `2`：

```python
result = b''.join(
    b'\xcc\x06' + data[p:p + 0x40000]
    for p in range(0, len(data), 0x40000)
)
```

- 原生块头常见 `8C 0A...`，stored 块头是 `CC 06`。
- 每 0x40000（256KB）一块。
- 用 §6 的解码器做往返校验：`decompress(result, len(data)) == data`。
- 这是社区工具（PBZ-Editor）验证过的做法；代价是**不压缩**，槽会变大。

### 9.3 用 `pbz_repack.js`

准备一个 spec：

```json
{
  "slots": {
    "AutoSave0": "G:\\work\\AutoSave0_patch.json"
  }
}
```

执行：

```powershell
node pbz_repack.js .\PBZSaveGame.sav "G:\SteamLibrary\steamapps\common\PBZ" `
  spec.json .\PBZSaveGame_patched.sav
```

脚本会：

- 定位 key、解目录；
- 未指定的槽原样解密再加密（内容不变）；
- 指定槽用 stored 块编码；
- 重新生成目录（含 `dirSize`）；
- 用新 nonce 加密每个块；
- 写回。

### 9.4 体积

一个 ~760KB 的槽改成 stored 块后会变成 ~760KB（原来压缩后 ~141KB），整个文件从 1.4MB 变成 ~2.0MB；改三个槽约 3.3MB。游戏能读，但不要无脑把所有槽都改一遍。

---

## 10. 校验清单

每次写回后至少做这些：

1. **目录 GCM 认证**：`pbz.js` 能解目录且不抛异常。
2. **tiling**：每条 `offset` 连续，`base + end == fileSize`，无 trailing。
3. **解压**：每个 `algo=2` 槽都能解到 `rawSize`，JSON 能 parse。
4. **目标字段**：目标任务/actor 字段符合预期。
5. **其它槽**：未修改槽的 JSON SHA-256 与原件逐一致。
6. **文件大小/哈希**：记录新文件 SHA-256。
7. **进游戏实测**：先复制到存档目录，点继续游戏，确认任务列表/图标。
8. **回滚**：解压备份覆盖。

示例校验命令：

```powershell
node pbz.js .\PBZSaveGame_patched.sav "G:\SteamLibrary\steamapps\common\PBZ"
node pbz_dump.js .\PBZSaveGame_patched.sav "G:\SteamLibrary\steamapps\common\PBZ" .\slots
python pbz_decompress.py .\slots .\json
```

---

## 11. 常见坑与排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 目录 GCM 解不开 | key 不对 / 游戏版本变了 / dirSize 读错 | 重新按锚点定位 key；确认 0x08 的 dirSize |
| Oodle 解压返回 0/-1 | DLL 太老（如 oo2core_5）/ rawSize 错 / 块偏移错 | 换支持 Kraken 的 DLL；用目录 rawSize；检查 36 字节头 |
| 游戏读档失败 | 目录 offset/size 没重排 / nonce 复用 / tag 顺序错 | 重跑 repack；确认 tag 在密文前 |
| 改了没效果 | 改错槽 / 游戏读 1RealTime / Steam Cloud 覆盖 | 改 `LastContinueSlot` 指向的槽；同步最新 1RealTime；断云 |
| 任务显示 N/5，但树图标仍“未完成” | 任务计数 ≠ 世界 actor 状态 | 补 `EventTag` + `LevelSequenceHasPlay`；可能还缺 `ExecuteNodeGuid` |
| 任务整条显示完成 | 写了 `QC_Succeded` + `BranchCompleted` | 想保留后续内容就改回 `QC_Started` + `BranchActivating` |
| 奖杯没弹 | 成就在 `__Achievements__` 槽，和任务槽分开 | 任务修改不会补发奖杯；需要另改成就槽（风险更高） |
| 改完文件变大 | stored 块不压缩 | 正常；只改必要槽 |
| 游戏更新后全失效 | 容器版本/密钥变化 | 重新跑 `pbz.js` 定位；不要硬编码旧 key |

### 关于 `ExecuteNodeGuid`

完成的树通常有两个 `ExecuteNodeGuid` 为 `true`，未完成的只有“开启”那个。这个 GUID 是关卡事件图节点 ID，**不在存档里生成**；如果补了 EventTag 和 `LevelSequenceHasPlay` 仍不生效，需要从关卡资产/其他完成档里找缺失的第二个 GUID。不要随便伪造 GUID。

### 关于手动档

`ManualSave1..11` 是独立快照；只改 `AutoSave0` 不会影响手动档。要全档一致就逐槽改，但文件会变大。

---

## 12. 给 DSH 的提示词模板

把下面这段直接发给 DSH（把路径和目标改成你的）：

```text
你是 Windows 上的《影之刃零》存档修复代理。目标：修复 PBZSaveGame.sav 中的任务数据。

已知：
- 游戏目录：G:\SteamLibrary\steamapps\common\PBZ
- 存档：<游戏目录>\ProjectPBZ\Saved\SaveGames\Steam\<SteamID>\PBZSaveGame.sav
- 容器：PBZS v3；块头 "PBZS\x01\x01\x00\x00" + nonce(12) + tag(16) + ciphertext；AES-256-GCM
- key 从 platform/steam/PBZ.exe 的 UTF-16LE 锚点 "sealed but block is PLAINTEXT" 后 0~15 字节处的 64 字节材料推得：key = material[0:32] XOR material[32:64]
- 槽数据 algo=2 为 Oodle Kraken；写回可用 stored 块 b'\xcc\x06' + 每 0x40000 字节
- 工具在 <工具目录>：pbz.js / pbz_dump.js / pbz_decompress.py / pbz_quest_patch.py / pbz_repack.js

要求：
1. 先只读：定位 key、解目录、列出槽表，确认目标槽（继续游戏看 __Advanced__.LastContinueSlot）。
2. 修改前把整个 <SteamID> 目录打包备份，记录原文件 SHA-256；不要动游戏目录以外的无关文件。
3. 解出目标槽 JSON，找到目标任务的 Narrative.NarrativeSavedQuests 记录，先打印当前字段给我确认。
4. 按我的要求改 TasksProgress / QuestCompletion / BranchType / CompletedBranches；不要动其它任务和槽。
5. 如果任务涉及世界 actor（树/机关等），同时检查 EventPipeline.ComponentInfoJson[actor].EventTag 和 LevelActorManager[actor].LevelSequenceHasPlay；只改任务计数可能不够。
6. 用 stored 块重打包，回读校验：GCM、tiling、解压、目标字段、其它槽 SHA 不变。
7. 输出：修改前后 diff、备份路径、新文件 SHA-256、回滚步骤。
8. 没有我的明确同意，不要直接覆盖游戏目录；先给我工作区里的成品文件。
```

### DSH 使用注意

- 把本分享包的 `tools` 目录（以及 `oodle-data-shared.dll` 的路径）一起给 DSH；也可以把这份 md 直接作为上下文发给它。
- DSH 默认是 workspace-write 沙箱；写游戏目录属于工作区外，需要你明确同意。
- 让 DSH 先做只读分析，确认 key/槽表后再写。
- 让它把备份、成品、校验报告都放在工作区，方便你检查。
- 不要让它执行 `pip install` 之类的联网安装；优先用 Node 内置 crypto + 现成 Oodle DLL。

---

## 13. 实战案例：榕树之心第 3 棵

这是一个“任务计数改了、树图标却没变”的典型例子：

- 任务：`/Game/PBZstory/PBZQuest/Collect/RongShuZhiXin.RongShuZhiXin_C`
- `QuestBranches[0].TasksProgress` 长度 5，对应五棵人面榕树
- 出问题时的记录：`[1,1,0,0,0]`、`QC_Started`、`BranchActivating`
- 第 3 棵树 actor：
  `PBZ_Houjie_WP-StaticMeshActor_UAID_E89C25A7512023B302_1167014368`
- 它的 `EventTag` 只有：
  `"rszx.榕树之心.开启任务3"`
- `LevelActorManager` 里没有这个 actor 的 `LevelSequenceHasPlay`

只把 `TasksProgress` 第 3 位改成 1 后：

- 任务列表显示 3/5、进行中（正确）
- 树图标/交互仍然“未完成”（因为世界 actor 状态没补）

补齐后才和已完成的第 1、2 棵结构一致：

```json
"EventTag": [
  "rszx.榕树之心.开启任务3",
  "rszx.榕树之心.完成挑战3",
  "music.解锁条件.完成第一个大榕树"
]
```

```json
"LevelActorManager": {
  "PBZ_Houjie_WP-StaticMeshActor_UAID_E89C25A7512023B302_1167014368": {
    "LevelSequenceHasPlay": true
  }
}
```

教训：

1. **任务进度和世界 actor 状态是两套数据**，不要只改 `TasksProgress`。
2. 完成态的树通常有两个 `ExecuteNodeGuid`；如果补完上面两项图标仍不消失，说明还缺第二个节点 GUID，需要从关卡资产/其它完成档里找。
3. 改任务前先确认“第 N 位”到底对应哪个 actor：用历史档看第 N 位翻转时 `LevelActorManager` 新增了哪个 key。

---

## 14. 参考

- PBZ-Editor（MIT，含密钥定位/压缩/编辑器）：https://github.com/qry6868/PBZ-Editor
- PBZERO（Boss/周目/死亡数）：https://github.com/idedit/pbzero
- oozextract（MIT，Kraken/Mermaid/… 解码器）：https://github.com/lvlvllvlvllvlvl/oozextract
- CUE4Parse / OodleUE 的 Oodle 共享库：https://github.com/WorkingRobot/OodleUE
- PBZ Save Reader（C# 读取/自动拆分）：https://github.com/gudqs7/pbz-auto-splitter
- 格式拆解文章（AES-GCM + Oodle Kraken）：https://dev.to/fancy39_9841cbc02f99f729c/inside-phantom-blade-zeros-pbzs-v3-save-format-aes-256-gcm-oodle-kraken-in-the-browser-14gm

---

## 15. 最后

- 这是单机存档修复/研究，别用于联机作弊或传播别人的存档。
- 改坏的概率永远存在：**备份、回读、再进游戏**。
- 游戏更新后，先跑一遍只读流程验证 key/格式，再改。
