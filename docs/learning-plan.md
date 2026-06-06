# small OS — 学習プラン

## 学習スタイル

**動く OS を触りながら理解する（トップダウン）**

ゼロから実装するのではなく、すでに動作している small OS のコードを読み、変更し、壊して直す過程で OS の概念を体得する。MIT の xv6 と同じアプローチ。

---

## 前提知識

- TypeScript / JavaScript の基本（async/await、クラス、Map）
- HTML / DOM の基本
- コマンドライン操作の基本（cd、ls 相当）

---

## 学習ロードマップ

```
Module 0  環境確認・全体把握          （0.5日）
    ↓
Module 1  シェルとコマンドを追加する  （1〜2日）
    ↓ シェル〜Syscall の流れが見える
Module 2  ファイルシステムを深掘りする（2〜3日）
    ↓ inode とディレクトリの構造が理解できる
Module 3  プロセス管理を観察・操作する（2〜3日）
    ↓ PCB・状態遷移・スケジューリングが理解できる
Module 4  メモリを意図的に枯渇させる  （1〜2日）
    ↓ ページング・OOM が体感できる
Module 5  割り込みを止めてみる        （1日）
    ↓ 割り込み駆動処理の重要性を逆から理解できる
Module 6  自由課題                    （3〜5日）
```

---

## 実装ルール：ユーザー空間からは Syscall 経由

シェルコマンドや `Pipeline` はユーザー空間として扱います。
カーネル機能に触るときは、必ず `SysHelper` の `sys.call(SYS.XXX, ...)` を使います。

```typescript
// OK: ユーザー空間から syscall 経由で読む
const fd = await sys.call(SYS.OPEN, 'memo.txt', OpenFlag.READ) as number;
const text = await sys.call(SYS.READ, fd) as string;
await sys.call(SYS.CLOSE, fd);
```

`FileSystem` / `Scheduler` / `MemoryManager` の private フィールドを直接読む課題は、原則として「カーネル内部を拡張する課題」に置き換えます。
内部構造を観察したい場合も、public メソッドまたは新しい `SYS` 番号を追加して、境界を保ったままシェルから呼び出します。

---

## セットアップ：コードを取得して起動する

### GitHub からコードを取得する

```bash
# リポジトリをクローン
git clone https://github.com/rex0220/small-os.git
cd small-os

# 依存パッケージをインストール
npm install
```

### 起動確認

```bash
npm run dev
```

ブラウザで `http://localhost:5173` を開くと small OS のターミナルが表示される。

---

## Module 0：環境確認・全体把握

**目標**: small OS を起動し、全コマンドを触ってソースの構造を把握する

### 手順

1. `npm run dev` で起動 → `http://localhost:5173` を開く
2. 全コマンドを一通り実行してみる

```
help
pwd
mkdir test
cd test
touch memo.txt
echo "hello" > memo.txt
cat memo.txt
ls
ps
free
```

3. `src/` のディレクトリ構成を眺める（5分程度）
4. `src/main.ts` から `kernel.boot()` → `Shell.attach()` の流れを追う

### 確認ポイント

- ページをリロードして `cat memo.txt` を実行 → ファイルが残っているか？（localStorage 永続化）
- ブラウザの DevTools → Application → Local Storage に `small-os-fs-v1` が保存されているか？

---

## Module 1：シェルとコマンドを追加する

**目標**: シェル〜Syscall の流れを追い、新しいコマンドを実装する

**学ぶ概念**: ユーザー空間 / カーネル空間の分離、システムコール

### 課題 1-A：`date` コマンドを追加する（入門）

`src/shell/commands/index.ts` に以下を追加：

```typescript
commands.set('date', async () => new Date().toLocaleString('ja-JP'));
```

→ シェルに `date` と打って確認。どこに書けば動くかを理解する。

### 課題 1-B：`echo` に `-n` オプションを追加する

```
$ echo -n "hello"     # 改行なしで出力
$ echo "world"
helloworld
```

`commands/index.ts` の `echo` コマンドを改造する。

### 課題 1-C：`wc` コマンドを実装する（行数・文字数カウント）

```
$ echo "hello world" > test.txt
$ wc test.txt
1 2 11 test.txt
```

`cat` コマンドの実装を参考に `sys.call(SYS.OPEN)` → `sys.call(SYS.READ)` → `sys.call(SYS.CLOSE)` の流れを理解する。

### 確認ポイント

- コマンド追加に必要なのは何ファイルの変更か？
- Syscall を経由しないとカーネルの何にアクセスできないか？

---

## Module 2：ファイルシステムを深掘りする

**目標**: inode の構造とパス解決の仕組みを理解する

**学ぶ概念**: inode、ディレクトリエントリ、ハードリンク、パス解決

### 課題 2-A：`istat` コマンドを実装する

inode の生データを表示するデバッグコマンド。

```
$ touch a.txt
$ istat a.txt
inode: 2
type:  file
size:  0
links: 1
created:  2026-06-06 10:00:00
modified: 2026-06-06 10:00:00
```

`istat` コマンドの実装は `SYS.STAT` syscall 経由で行う（`extension-guide.md` 参照）。
`inodes` は private フィールドなので直接参照はしない。
これが「Syscall 境界」の学習ポイントでもある。

### 課題 2-B：`rm` 後に inode が解放されているか確認する

```
$ touch b.txt
$ istat b.txt        # inode 番号を確認
$ rm b.txt
$ istat b.txt        # ENOENT になるか？
```

`FileSystem.ts` の `unlink()` の処理を読み、inode が削除されるタイミングを確認する。

### 課題 2-C：ディレクトリの最大エントリ数に上限を設ける

`FileSystem.ts` の `mkdir()` / `open()` を改造して、1ディレクトリあたり最大 10 エントリに制限してみる。エラーメッセージは：

```
mkdir: /test/11th: Too many links
```

### 確認ポイント

- inode とディレクトリエントリはなぜ分離されているか？
- ファイルを削除しても inode が残る場合があるのはなぜか？（nlink の意味）

---

## Module 3：プロセス管理を観察・操作する

**目標**: PCB・プロセス状態遷移・スケジューリングを理解する

**学ぶ概念**: PCB、running/ready/waiting/zombie、ラウンドロビン

### 課題 3-A：`ps` の出力を拡張する

現在の `ps` に CPU 時間と起動経過秒数を追加する。

```
$ ps
PID  PPID  STATE    CPU_MS  ELAPSED  NAME
1    0     running  0       120s     init
2    1     ready    0       5s       shell
```

`Scheduler.ts` の `list()` と `PCB` の `startTime` / `cpuTime` フィールドを参照する。
コマンド側からは `sys.call(SYS.PS)` で取得し、`Syscall.ts` の `PS` 処理で返す情報を増やす。

### 課題 3-B：プロセス状態遷移を観察する

`Scheduler.ts` の `handleYield()` にログを追加して、プロセスがどのタイミングで `running` → `ready` → `running` を繰り返すかをコンソールで確認する。

```typescript
// handleYield に追加
console.log(`[Scheduler] PID ${pid}: running → ready`);
```

### 課題 3-C：優先度付きスケジューリングを実装する

`PCB.priority` フィールドが 0（高）〜19（低）で定義されている。
現在はラウンドロビンだが、priority が低いプロセスは2回に1回だけ resume するよう改造する。

### 確認ポイント

- PID=1（init）を kill できないのはなぜか？（`Scheduler.ts` の kill を確認）
- `zombie` 状態はいつ発生するか？zombie になったプロセスはどうなるか？

---

## Module 4：メモリを意図的に枯渇させる

**目標**: ページング・断片化・OOM（Out of Memory）を体感する

**学ぶ概念**: ページング、断片化、スワップなしの制約

### 課題 4-A：`free` コマンドの出力を詳細化する

現在の表示にページ単位の情報を追加する。

```
$ free
              total   used   free   pages
Mem:            64K     4K    60K   1/16
```

`MemoryManager.ts` の `getUsage()` を拡張し、使用ページ数 / 総ページ数も返す。
コマンド側からは `sys.call(SYS.MEMINFO)` で取得する。

### 課題 4-B：メモリ使用量の可視化コマンド `memmap` を実装する

ページテーブルを視覚的に表示するコマンド。

```
$ memmap
Page map (16 pages, 4KB each):
[1][.][.][.][.][.][.][.][.][.][.][.][.][.][.][.]
 ^-- PID 1 使用中  . = 空き
```

`MemoryManager.ts` に `getPageMap()` のような public メソッドを追加し、`Syscall.ts` に `SYS.MEMMAP` を追加してシェルから呼び出す。
`pageTable` をコマンドから直接参照しない。

### 課題 4-C：大量プロセスを生成して OOM を発生させる

`stress` コマンドを作り、内部で `sys.call(SYS.FORK, 'stress-worker')` を繰り返してメモリが枯渇したときに何が起きるかを観察する。
`Scheduler.fork()` をコマンドから直接呼び出さない。

### 確認ポイント

- スワップがないと何が起きるか？
- 16ページ（64KB）の制約でどんなプログラムが動かせなくなるか？

---

## Module 5：割り込みを止めてみる

**目標**: 割り込み駆動処理の重要性を逆から理解する

**学ぶ概念**: 割り込み駆動、ポーリング、タイマー割り込み

### 課題 5-A：タイマー割り込みを無効化する

`kernel/index.ts` の `irq.start()` をコメントアウトして起動してみる。

```typescript
// this.irq.start();  // ← コメントアウト
```

何が変わるか（変わらないか）を観察する。

### 課題 5-B：割り込みハンドラーを追加する

タイマーが呼ばれるたびにカウンターを増やし、`uptime` コマンドで表示する。

```
$ uptime
System uptime: 42 ticks (2100ms)
```

`InterruptController.ts` に `TIMER` ハンドラーを追加し、`Kernel` でカウンターを管理する。

### 確認ポイント

- タイマー割り込みを止めるとスケジューラーはどう変わるか？
- ポーリング方式（`while(true)` でチェック）と割り込み方式の違いは？

---

## Module 6：自由課題

**目標**: ここまでの理解を組み合わせて自分のアイデアを実装する

### 推奨テーマ

| テーマ | 難易度 | 関連モジュール |
|--------|--------|--------------|
| `history` コマンド（コマンド履歴の永続化） | ★☆☆ | Shell + localStorage |
| `cp` コマンド（ファイルコピー） | ★☆☆ | FileSystem |
| `grep` コマンド（文字列検索） | ★☆☆ | Shell + Pipeline |
| `top` コマンド（リアルタイムプロセス監視） | ★★☆ | Scheduler + Terminal |
| `chmod` コマンド（パーミッション管理） | ★★☆ | FileSystem + Inode 拡張 |
| パイプライン `ls | grep txt | wc` | ★★★ | Pipeline 拡張 |
| シェルスクリプト実行（`.sh` ファイル） | ★★★ | Shell + FileSystem |

---

## 各モジュールの対応関係

| モジュール | 主に読むファイル | 学べる OS の概念 |
|-----------|---------------|----------------|
| Module 1 | Shell.ts / Pipeline.ts / commands/index.ts | ユーザー空間・カーネル空間分離 |
| Module 2 | FileSystem.ts | inode・ディレクトリ・パス解決 |
| Module 3 | Scheduler.ts / process.worker.ts | PCB・プロセス状態遷移・スケジューリング |
| Module 4 | MemoryManager.ts | ページング・断片化・OOM |
| Module 5 | InterruptController.ts / kernel/index.ts | 割り込み駆動処理 |

---

## 参考：OS 概念と実装の対応表

| OS の概念 | small OS での実装 | 本物の OS での実装 |
|----------|-----------------|-----------------|
| ユーザー空間 / カーネル空間 | Syscall.ts による境界 | CPU 特権モード（Ring 0/3） |
| プロセス | Web Worker + PCB | カーネルが管理するスレッド |
| コンテキストスイッチ | yield / resume メッセージ | レジスタ退避・復元 |
| ページング | ArrayBuffer + pageTable | MMU（メモリ管理ユニット） |
| ファイルシステム | inode + localStorage | ディスク上の inode テーブル |
| 割り込み | setInterval | CPU 割り込みベクター |
