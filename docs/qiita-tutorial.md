# WebエンジニアのためのOS概念入門

## はじめに

Web アプリを書いていると、プロセス、メモリ、ファイル、権限、システムコールといった言葉に出会います。

でも、普段はブラウザや Node.js、フレームワークの上で開発しているため、OS が何を管理しているのかを実感する機会はあまり多くありません。

**small OS** は TypeScript + Vite で実装した、**ブラウザー上で動作する OS シミュレーター**です。  
そうした OS の基本概念を、使い慣れた TypeScript とブラウザ API で小さく再現しています。  
OS 専用のエミュレーターや仮想マシンは不要で、Node.js 環境があればすぐに体験できます。

> **注意**：small OS はブート可能な実 OS ではありません。OS の基本概念をブラウザ上で学ぶためのシミュレーターです。

以下の OS の基本概念をハンズオンで体験できます。

- プロセス管理・スケジューリング
- ファイルシステム（inode）
- メモリ管理（ページング）
- システムコール（ユーザー空間 / カーネル空間の分離）
- 割り込み制御

**動くコードを触りながら理解する**設計になっています。

この記事で学べること：

- システムコールがなぜ必要か
- inode とファイル名の関係
- PCB とプロセス状態遷移
- ページングの超小型モデル
- ブラウザ API で OS 概念をどう模擬できるか

## デモ

ブラウザ上でターミナルが動きます。

```
$ mkdir projects
$ cd projects
$ echo "hello" > readme.txt
$ cat readme.txt
hello
$ ps
PID  PPID  STATE    NAME
1    0     running  init
2    1     ready    shell
$ free
              total   used   free
Mem:            64K     8K    56K
```

パイプも使えます。

```
$ echo "hello world" > test.txt
$ cat test.txt | echo
hello world
```

リロードしても `readme.txt` が残ります（localStorage に永続化）。

![screenshot.png](https://qiita-image-store.s3.ap-northeast-1.amazonaws.com/0/100572/09b89062-8778-4845-afe6-4b475be87f73.png)

## セットアップ

```bash
git clone https://github.com/rex0220/small-os.git
cd small-os
npm install
npm run dev
```

`http://localhost:5173` をブラウザで開くとターミナルが表示されます。

## アーキテクチャ概要

```
┌──────────────────────────────────────────┐
│             ユーザー空間                  │
│  Terminal UI  ←→  Shell / コマンド群     │
├──────────────────┬───────────────────────┤
│   カーネル空間    │                       │
│  ┌───────────────▼─────────────────────┐ │
│  │     システムコール層 (Syscall.ts)    │ │  ← 唯一の境界
│  └────────┬─────────────┬─────────────┘ │
│  Scheduler │  MemoryMgr  │  FileSystem   │
│  (PCB/RR)  │  (64KB/4KB) │  (inode/VFS)  │
│  └─────────┴─────────────┴─────────────┘ │
│  InterruptController (setInterval 50ms)   │
├───────────────────────────────────────────┤
│  ハードウェア抽象層（ブラウザー API）       │
│  setTimeout / setInterval / localStorage  │
└───────────────────────────────────────────┘
```

| 実 OS の概念 | small OS での実装 | 備考 |
|---|---|---|
| CPU 特権モード（Ring 0/3） | Syscall.ts による境界 | ユーザー空間からカーネル空間へのアクセス制限 |
| プロセス | Web Worker + PCB | スレッドの独立性を利用 |
| コンテキストスイッチ | `yield` / `resume` メッセージ | メッセージ駆動による協調的マルチタスク |
| ページング（メモリ管理） | ArrayBuffer 64KB ÷ 4KB | 固定長ページによるアロケーションの模擬 |
| ファイルシステム | inode + localStorage | データの永続化 |
| タイマー割り込み | `setInterval`（50ms） | 拡張用の骨組みとして用意 |

## チュートリアル

### Step 1：全コマンドを触ってみる

まず全部のコマンドを一通り実行してみましょう。

```bash
help                     # コマンド一覧
pwd                      # カレントディレクトリ
mkdir test               # ディレクトリ作成
cd test                  # ディレクトリ移動
touch memo.txt           # ファイル作成
echo "hello OS" > memo.txt
cat memo.txt             # hello OS
ls
ps                       # プロセス一覧
free                     # メモリ使用状況
```

**確認ポイント**：ページをリロードして `cat memo.txt` を実行してみてください。  
ファイルが残っているはずです。ブラウザの DevTools → Application → Local Storage に `small-os-fs-v1` が保存されています。

---

### Step 2：新しいコマンドを追加する（システムコールを理解する）

`src/shell/commands/index.ts` を開いてみましょう。既存コマンドはこのファイルに集約されています。

```typescript
// cat コマンドの実装（抜粋）
commands.set('cat', async (args, sys) => {
  const fd = await sys.call(SYS.OPEN, args[0], OpenFlag.READ) as number;
  const text = await sys.call(SYS.READ, fd) as string;
  await sys.call(SYS.CLOSE, fd);
  return text;
});
```

`sys.call(SYS.XXX, ...)` がシステムコールです。ユーザー空間（コマンド）からカーネルへの**唯一の入口**です。  
実 OS で言えば `syscall` 命令に相当します。

**なぜ Syscall を経由しなければいけないのか？**  
コマンドがメモリや他のプロセスのファイルを直接触れてしまうと、悪意あるプログラムが他のプロセスを破壊できてしまいます。カーネルが門番（Syscall）として立ち、許可された操作だけを代行することで、プロセス間の安全性と隔離を保証しています。これが OS における**ユーザー空間 / カーネル空間の分離**の本質です。

#### 課題：`date` コマンドを追加する

```typescript
// index.ts に追加
commands.set('date', async () => new Date().toLocaleString('ja-JP'));
```

ターミナルで `date` と打ってみてください。  
→ **コマンドの追加に必要なのは 1 ファイルの変更だけ**であることがわかります。

#### 課題：`wc` コマンドを実装する

```typescript
commands.set('wc', async (args, sys) => {
  const fd = await sys.call(SYS.OPEN, args[0], OpenFlag.READ) as number;
  const text = await sys.call(SYS.READ, fd) as string;
  await sys.call(SYS.CLOSE, fd);
  const lines = text.split('\n').length;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const bytes = new TextEncoder().encode(text).length;
  return `${lines} ${words} ${bytes} ${args[0]}`;
});
```

```bash
$ echo "hello world" > test.txt
$ wc test.txt
1 2 12 test.txt
```

---

### Step 3：ファイルシステムの内部を見る（inode を理解する）

`src/kernel/FileSystem.ts` を開いてみましょう。

Linux の ext4 などでも使われる inode の考え方を、学習用にかなり小さく単純化して実装しています。

```
ディレクトリエントリ  →  inode  →  データ
"memo.txt"   → inode#3 → "hello OS"
```

ファイル名と実体（inode）を**分離**することで、ハードリンクが実現できます。

#### inode の構造

```typescript
interface Inode {
  id: number;       // inode 番号（1〜1000）
  type: 'file' | 'dir';
  size: number;     // バイト数
  nlink: number;    // ハードリンク数
  created: number;  // Unix ms
  modified: number;
  data: string;
}
```

#### 課題：`istat` コマンドを実装して inode を覗く

`SYS.STAT` syscall 経由で inode 情報を取得できます。

```typescript
commands.set('istat', async (args, sys) => {
  const stat = await sys.call(SYS.STAT, args[0]) as any;
  return [
    `inode:    ${stat.id}`,
    `type:     ${stat.type}`,
    `size:     ${stat.size}`,
    `links:    ${stat.nlink}`,
    `modified: ${new Date(stat.modified).toLocaleString('ja-JP')}`,
  ].join('\n');
});
```

```bash
$ touch a.txt
$ istat a.txt
inode:    3
type:     file
size:     0
links:    1
modified: 2026/6/6 10:00:00
$ rm a.txt
$ istat a.txt
istat: a.txt: No such file or directory
```

`rm` 後に inode が解放されるタイミングを `FileSystem.ts` の `unlink()` で確認してみてください。

---

### Step 4：プロセスを観察する（PCB・状態遷移を理解する）

`ps` コマンドで現在のプロセス一覧を確認しましょう。

```bash
$ ps
PID  PPID  STATE    NAME
1    0     running  init
2    1     ready    shell
```

各プロセスは **PCB（Process Control Block）** で管理されています。

```typescript
interface PCB {
  pid: number;
  ppid: number;
  name: string;
  state: 'running' | 'ready' | 'waiting' | 'zombie';
  priority: number;   // 0(高)〜19(低)
  startTime: number;
  cpuTime: number;
  cwd: number;        // カレントディレクトリの inode ID
}
```

**プロセスの状態遷移：**

```
  fork()
    ↓
  ready ──→ running ──→ zombie（exit 呼び出し）
    ↑           │
    └─── waiting ←── I/O 待ち
```

#### プロセスの並行実行の仕組み

small OS では各プロセスを **Web Worker** で実装しています。

```
Worker → postMessage({ type: "yield" })   // タイムスライス消費
       ← postMessage({ type: "resume" })  // 次のターンが来た
```

Web Worker はブラウザ上で真に並行動作するスレッドですが、small OS ではあえてその上に**協調的マルチタスク**を実装しています。各 Worker が処理の区切りで `yield` を送り、Scheduler が `resume` を返すことでコンテキストスイッチを模擬します。

実 OS でのタイマー割り込みによる**強制的なプリエンプション**をブラウザ上で厳密に再現するのは難しいため、この「割り切り」を採用しています。`InterruptController`（50ms タイマー）はその拡張用の骨組みとして用意されています（Step 6 参照）。

#### 課題：シェルプロセスを kill して何が起きるか確認する

```bash
$ ps          # PID=2 が shell
$ kill 2      # シェルを kill！
```

しばらくして次の入力をすると、Shell が自動的に新しいシェルプロセスを fork して再起動します。  
`Shell.ts` で zombie 検出ロジックを探してみてください。

---

### Step 5：メモリを枯渇させる（ページングを理解する）

```bash
$ free
              total   used   free
Mem:            64K     8K    56K
```

物理メモリ全体を **64KB / 4KB ページ × 16 枚**に分割して管理します。  
スワップはありません。メモリが足りなくなると `ENOMEM` エラーになります。

#### メモリ管理の実装

```typescript
// MemoryManager.ts の概念
class MemoryManager {
  private pool = new ArrayBuffer(64 * 1024);       // 64KB の共有メモリプール
  private pageTable = new Uint8Array(16);          // pageTable[i] = PID（0=空き）
}
```

> **Note:** これはプロセスごとに独立したアドレス空間を持つ「仮想メモリ」ではなく、物理ページを PID に割り当てる**固定長ページアロケーション**です。プロセス間のメモリ分離は Web Worker のスレッド分離に依存しています。

#### 課題：`memmap` コマンドを実装してページマップを表示する

`Syscall.ts` に `SYS.MEMMAP` を追加し、`MemoryManager` に `getPageMap()` を実装します。

```bash
$ memmap
Page map (16 pages, 4KB each):
[1][2][.][.][.][.][.][.][.][.][.][.][.][.][.][.]
 ^PID1  ^PID2  . = 空き
```

`pageTable` をコマンドから直接参照せず、必ず Syscall 経由にすることがポイントです。

---

### Step 6：割り込みを止めてみる（割り込み駆動処理を理解する）

`src/kernel/index.ts` を開いて `irq.start()` をコメントアウトしてみましょう。

```typescript
// this.irq.start();  // ← コメントアウト
```

現時点では TIMER ハンドラーは空（`() => {}`）なので、`irq.start()` を止めてもコマンド実行や協調スケジューリングへの影響はありません。

これは「割り込みコントローラーを拡張する入口」として設計されています。次の課題でハンドラーを実装してみましょう。

**考察のポイント：**
- ポーリング方式（`while(true)` でチェック）と割り込み方式の違いは？
- タイマーハンドラーを実装するとどんな機能が作れるか？

**発展課題：** タイマーごとにプロセスの `cpuTime` をインクリメントし、一定時間を超えたら強制的に別プロセスへ切り替える（**プリエンプティブ・スケジューリング**）を実装してみてください。現在の協調方式との挙動の違いが体感できます。

---

## ソースコード構成

```
src/
├── main.ts                    # エントリーポイント
├── kernel/
│   ├── index.ts               # Kernel クラス・起動シーケンス
│   ├── Syscall.ts             # システムコール層（ユーザー/カーネル境界）
│   ├── Scheduler.ts           # Web Worker 協調スケジューラー
│   ├── MemoryManager.ts       # ページベース仮想メモリ管理
│   ├── FileSystem.ts          # inode ベース VFS（localStorage 永続化）
│   ├── InterruptController.ts # タイマー割り込み制御
│   └── KernelError.ts         # Linux ライク errno 定義
├── shell/
│   ├── Shell.ts               # メインシェル
│   ├── Pipeline.ts            # パイプ・リダイレクト実行エンジン
│   └── commands/index.ts      # 全コマンド実装
├── terminal/
│   └── Terminal.ts            # DOM 端末エミュレーター
└── workers/
    └── process.worker.ts      # プロセス実行用 Web Worker
```

## 学習ロードマップ

| モジュール | テーマ | 学べる概念 |
|---|---|---|
| Module 0 | 環境確認・全体把握 | 起動シーケンス |
| Module 1 | コマンドを追加する | Syscall・ユーザー空間/カーネル空間 |
| Module 2 | ファイルシステムを深掘り | inode・ディレクトリ・ハードリンク |
| Module 3 | プロセス管理を観察 | PCB・状態遷移・スケジューリング |
| Module 4 | メモリを枯渇させる | ページング・断片化・OOM |
| Module 5 | 割り込みを止めてみる | 割り込み駆動・タイマー割り込み |

詳細は [docs//learning-plan.md](https://github.com/rex0220/small-os/blob/main/docs/learning-plan.md) を参照してください。

## おわりに

small OS は「OS の概念を体験的に学ぶ」ことを目的に作りました。

実際の Linux カーネルは数百万行のコードですが、small OS は **TypeScript 約 1,200 行**のコンパクトなコードベースで同じ概念を体験できます。使い慣れた TypeScript で読める・変えられる・壊せる設計になっています。

コードは GitHub で公開しています。Issue や PR も歓迎です。

https://github.com/rex0220/small-os

## 参考

- [xv6: a simple, Unix-like teaching operating system](https://pdos.csail.mit.edu/6.828/2023/xv6.html) — MIT の教育用 OS
- [The Linux Kernel documentation](https://www.kernel.org/doc/html/latest/) — Linux カーネルドキュメント
- [Web Workers API - MDN](https://developer.mozilla.org/ja/docs/Web/API/Web_Workers_API) — プロセス並行に使用
