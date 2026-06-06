# small OS — 仕様書

## 概要

**small OS** は OS の基本的な仕組みを学習するためのブラウザー動作型シミュレーター OS です。
TypeScript + Vite で実装し、インストール不要・環境依存なしで OS の概念を体験的に学べます。

---

## 設計方針

| 項目 | 仕様 |
|------|------|
| カーネル構造 | モノリシックカーネル |
| 非同期モデル | async / await（システムコールはすべて非同期） |
| プロセス並行 | Web Worker — 各プロセスを独立 Worker で実行（協調方式） |
| 仮想メモリ | 64 KB、ページサイズ 4 KB（16 ページ）、スワップなし |
| ファイルシステム | inode 上限 1,000、localStorage で永続化、CWD / FD はプロセス単位で管理 |
| シェル | パイプ（`|`）・リダイレクト（`>`）をサポート |
| エラー処理 | Linux ライクなメッセージ、カーネルパニック時もエラー表示して継続 |

---

## アーキテクチャ

```
┌──────────────────────────────────────────────────┐
│                ユーザー空間                        │
│  ┌─────────────────────────────────────────────┐ │
│  │  Terminal UI (DOM)  ←→  Shell(PID) / コマンド群 │ │
│  └──────────────────────┬──────────────────────┘ │
├─────────────────────────┼────────────────────────┤
│          カーネル空間    │                        │
│  ┌──────────────────────▼──────────────────────┐ │
│  │          システムコール層 (Syscall.ts)        │ │
│  └───────┬──────────────┬──────────────┬───────┘ │
│          │              │              │          │
│  ┌───────▼──────┐ ┌─────▼──────┐ ┌───▼────────┐ │
│  │  プロセス管理 │ │ メモリ管理  │ │ファイル    │ │
│  │ Scheduler.ts │ │MemoryMgr   │ │システム    │ │
│  │ Worker 協調  │ │64KB/4KBページ│ │FileSystem  │ │
│  └───────┬──────┘ └─────┬──────┘ └───┬────────┘ │
│          └──────────────┼────────────┘          │
│  ┌──────────────────────▼──────────────────────┐ │
│  │       割り込みコントローラー                  │ │
│  │         InterruptController.ts               │ │
│  └──────────────────────┬──────────────────────┘ │
├─────────────────────────┼────────────────────────┤
│    ハードウェア抽象層    │                        │
│  ┌──────────────────────▼──────────────────────┐ │
│  │  setTimeout / setInterval / localStorage     │ │
│  └─────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

---

## カーネル仕様

### システムコール層（Syscall.ts）

ユーザー空間とカーネルを分離する唯一の窓口。シェル・コマンド・Pipeline からのカーネル操作は `SysHelper` の `sys.call(SYS.XXX, ...)` 経由で行う。

| 番号 | 名前 | 説明 |
|------|------|------|
| 0 | READ | ファイルディスクリプターから読み込み |
| 1 | WRITE | ファイルディスクリプターへ書き込み |
| 2 | OPEN | ファイルを開く |
| 3 | CLOSE | ファイルディスクリプターを閉じる |
| 4 | FORK | プロセスを生成 |
| 5 | EXIT | プロセスを終了 |
| 6 | GETPID | 現在のプロセス ID を取得 |
| 7 | KILL | プロセスを終了させる |
| 8 | MKDIR | ディレクトリを作成 |
| 9 | UNLINK | ファイルを削除 |
| 10 | STAT | ファイル情報を取得 |
| 11 | READDIR | ディレクトリエントリ一覧を取得 |
| 12 | CHDIR | カレントディレクトリを変更 |
| 13 | GETCWD | カレントディレクトリパスを取得 |
| 14 | MEMINFO | メモリ使用状況を取得 |
| 15 | PS | プロセス一覧を取得 |

### プロセス管理（Scheduler.ts）

**PCB（Process Control Block）フィールド：**

| フィールド | 型 | 説明 |
|-----------|-----|------|
| pid | number | プロセス ID |
| ppid | number | 親プロセス ID |
| name | string | プロセス名 |
| state | string | running / ready / waiting / zombie |
| priority | number | 優先度（0=高〜19=低） |
| worker | Worker | 対応する Web Worker |
| memory | MemorySegment | 割り当てメモリ |
| openFiles | number[] | 開いている FD（学習用フィールド、実体は FileSystem 側で PID ごとに管理） |
| startTime | number | 起動時刻（Unix ms） |
| cpuTime | number | 累積 CPU 時間（ms） |
| cwd | number | カレントディレクトリの inode ID |

**協調スケジューリング：**

```
Worker → postMessage({ type: "yield" })
       ← postMessage({ type: "resume" })
```

Worker が処理の区切りで yield を送り、スケジューラーがラウンドロビンで次のプロセスに resume を送る。

`kill` / `exit` 時は `Scheduler.exit()` に集約され、Worker 停止、zombie 化、ready queue からの除去、メモリ解放、exit ハンドラー通知を行う。Kernel の exit ハンドラーは、その PID が開いた FD を `FileSystem.closeAllForPid(pid)` で回収する。

### メモリ管理（MemoryManager.ts）

| 項目 | 値 |
|------|----|
| 仮想メモリサイズ | 64 KB |
| ページサイズ | 4 KB（固定） |
| 総ページ数 | 16 ページ |
| スワップ | なし |

メモリ不足時は `ENOMEM` エラーを表示して継続（システム停止しない）。

### ファイルシステム（FileSystem.ts）

**inode 構造：**

| フィールド | 型 | 説明 |
|-----------|-----|------|
| id | number | inode 番号（1〜1000） |
| type | string | "file" または "dir" |
| size | number | バイト数 |
| created | number | 作成時刻（Unix ms） |
| modified | number | 更新時刻（Unix ms） |
| data | string | ファイル内容（dir は空） |
| nlink | number | ハードリンク数 |

- inode 上限：1,000
- 永続化：`localStorage`（キー: `small-os-fs-v1`）
- ページリロード後もファイルシステムが維持される
- CWD はグローバルではなく、各 `PCB.cwd` に inode ID として保持する
- FD は `FileSystem` が PID ごとに管理する
- `READ` / `WRITE` / `CLOSE` は FD 所有者 PID を検証し、不一致または存在しない FD は `EBADF` を返す
- プロセス終了時に、その PID が開いた FD は自動的に閉じられる

### エラー処理（KernelError.ts）

**errno 定義：**

| errno | 定数 | メッセージ |
|-------|------|-----------|
| 1 | EPERM | Operation not permitted |
| 2 | ENOENT | No such file or directory |
| 3 | ESRCH | No such process |
| 9 | EBADF | Bad file descriptor |
| 12 | ENOMEM | Cannot allocate memory |
| 13 | EACCES | Permission denied |
| 17 | EEXIST | File exists |
| 20 | ENOTDIR | Not a directory |
| 21 | EISDIR | Is a directory |
| 22 | EINVAL | Invalid argument |
| 28 | ENOSPC | No space left on device |

**エラーメッセージ書式（Linux ライク）：**

```
<command>: <target>: <message>
例:
  rm: /home/foo.txt: No such file or directory
  mkdir: /home: File exists
  kill: (99): No such process
```

---

## シェル仕様

`kernel.boot()` は init プロセス（PID=1）を生成したあと、シェル用プロセス（通常 PID=2）を fork し、その PID を `Shell` に渡す。`Shell` の constructor は shell PID に束縛した `SysHelper` を作り、通常のコマンド実行と Pipeline はすべてその `SysHelper` 経由で syscall を発行する。

Shell は DOM 上で動く UI オブジェクトでもあるため、shell プロセスの zombie 検出と再起動だけは UI 管理用の制御プレーンとして `Scheduler` を直接参照する。`kill 2` などでシェルプロセスが zombie になった場合、次の入力時に Shell は新しい shell プロセスを fork して再起動する。

### 対応コマンド

| コマンド | 書式 | 説明 |
|---------|------|------|
| help | `help` | コマンド一覧を表示 |
| clear | `clear` | 画面をクリア |
| echo | `echo <text>` | テキストを出力 |
| pwd | `pwd` | カレントディレクトリを表示 |
| ls | `ls [path]` | ディレクトリ一覧を表示 |
| cd | `cd <path>` | ディレクトリを移動 |
| mkdir | `mkdir <path>` | ディレクトリを作成 |
| touch | `touch <file>` | ファイルを作成 |
| cat | `cat <file>` | ファイル内容を表示 |
| rm | `rm <file>` | ファイルを削除 |
| ps | `ps` | プロセス一覧を表示 |
| kill | `kill <pid>` | プロセスを終了 |
| free | `free` | メモリ使用状況を表示 |

### パイプ・リダイレクト

```bash
# パイプ
ls | echo

# リダイレクト（上書き）
echo "hello" > file.txt

# リダイレクト（追記）
echo "world" >> file.txt
```

---

## ファイル構成

```
src/
├── main.ts                      # エントリーポイント・カーネル boot
├── types/
│   └── index.ts                 # 共通型定義
├── kernel/
│   ├── index.ts                 # Kernel クラス・起動シーケンス
│   ├── Syscall.ts               # システムコール層（非同期）
│   ├── Scheduler.ts             # Worker 協調スケジューラー
│   ├── MemoryManager.ts         # ページベース仮想メモリ管理
│   ├── FileSystem.ts            # inode ベース VFS（localStorage 永続化、PID別FD）
│   ├── InterruptController.ts   # タイマー・割り込み制御
│   └── KernelError.ts           # errno 定義・エラー書式
├── shell/
│   ├── Shell.ts                 # メインシェル
│   ├── Pipeline.ts              # パイプ・リダイレクト実行エンジン
│   └── commands/
│       └── index.ts             # 全コマンド実装
├── terminal/
│   ├── Terminal.ts              # DOM 端末エミュレーター
│   └── terminal.css             # ターミナルスタイル
└── workers/
    └── process.worker.ts        # プロセス実行用 Web Worker

docs/
└── spec.md                      # 本仕様書
```

---

## カーネル起動シーケンス

```
1. MemoryManager.init()       — ページテーブル初期化
2. FileSystem.init()          — localStorage 復元 or ルートディレクトリ作成
3. Scheduler.setMemory()      — Scheduler に MemoryManager を注入
4. Scheduler.connect()        — syscall / stdout / exit ハンドラー登録
5. InterruptController 登録・開始 — タイマー割り込みハンドラー設定と start()
6. spawnInit()                — init プロセス（PID=1）生成
7. Scheduler.fork(1, "shell") — シェルプロセスを生成し PID を返す
8. new Shell(kernel, term, pid) — shell PID に束縛した SysHelper を作成
9. Shell.attach()             — 入力ハンドラー登録・プロンプト表示
```

---

## 技術スタック

| ツール | バージョン | 用途 |
|--------|-----------|------|
| TypeScript | 5.5.x | コアロジック |
| Vite | 5.4.x | バンドラー・開発サーバー |
| Web Worker API | ブラウザー標準 | プロセス並行実行 |
| localStorage | ブラウザー標準 | ファイルシステム永続化 |
