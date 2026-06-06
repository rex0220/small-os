# small OS — 学習プラン

## 学習スタイル

**動く OS を触りながら理解する（トップダウン）**

ゼロから OS を実装するのではなく、すでに動作している small OS のコードを読み、変更し、壊して直す過程で、Web エンジニアが OS の基本概念を体験的に理解する。
MIT の xv6 と同じく「動く教材を読みながら学ぶ」アプローチだが、題材はブラウザーと TypeScript に寄せている。

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
try {
  const text = await sys.call(SYS.READ, fd) as string;
} finally {
  await sys.call(SYS.CLOSE, fd);
}
```

`FileSystem` / `Scheduler` / `MemoryManager` の private フィールドを直接読む課題は、原則として「カーネル内部を拡張する課題」に置き換えます。
内部構造を観察したい場合も、public メソッドまたは新しい `SYS` 番号を追加して、境界を保ったままシェルから呼び出します。
コマンドの入力エラーは `throw new Error(...)` に寄せ、`Pipeline` 側で表示されるシェルエラーとして扱います。

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

この Module では、まず small OS を起動してターミナル操作に慣れる。
次にリロード後もファイルが残ることを確認し、localStorage 永続化を観察する。
最後に `main.ts` から起動シーケンスを追い、全体像をつかむ。

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

この Module では、既存のコマンド実装を読み、新しいコマンドを追加する。
`sys.call(SYS.XXX, ...)` を使って、ユーザー空間からカーネル機能を呼び出す流れを確認する。
最後に `wc` を実装し、FD を開く・読む・閉じる一連の操作を体験する。

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

#### 実装例

`src/shell/commands/index.ts`:

```typescript
commands.set('echo', async (args) => {
  if (args[0] === '-n') return args.slice(1).join(' ');
  return args.join(' ');
});
```

### 課題 1-C：`wc` コマンドを実装する（行数・文字数カウント）

```
$ echo "hello world" > test.txt
$ wc test.txt
1 2 11 test.txt
```

`cat` コマンドの実装を参考に `sys.call(SYS.OPEN)` → `sys.call(SYS.READ)` → `sys.call(SYS.CLOSE)` の流れを理解する。

#### 実装例

`src/shell/commands/index.ts`:

```typescript
commands.set('wc', async (args, _stdin, sys) => {
  if (!args[0]) throw new Error('wc: missing operand');

  const fd = await sys.call(SYS.OPEN, args[0], OpenFlag.READ) as number;
  try {
    const text = await sys.call(SYS.READ, fd) as string;
    const lines = text.split('\n').length;
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const bytes = new TextEncoder().encode(text).length;
    return `${lines} ${words} ${bytes} ${args[0]}`;
  } finally {
    await sys.call(SYS.CLOSE, fd);
  }
});
```

> **注意**: `CmdFn` の型は `(args, stdin, sys, term)` の順。`sys` を2番目に書くと `stdin`（文字列）が渡り `sys.call is not a function` エラーになる。

### 確認ポイント

- コマンド追加に必要なのは何ファイルの変更か？
- Syscall を経由しないとカーネルの何にアクセスできないか？

---

## Module 2：ファイルシステムを深掘りする

**目標**: inode の構造とパス解決の仕組みを理解する

**学ぶ概念**: inode、ディレクトリエントリ、ハードリンク、パス解決

この Module では、ファイル名と inode が分かれていることを確認する。
まず `istat` コマンドで inode を表示し、次に `rm` 後の挙動を観察する。
最後にディレクトリの上限を追加して、ファイルシステムの制約を体験する。

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

#### 実装例

`src/shell/commands/index.ts`:

```typescript
commands.set('istat', async (args, _stdin, sys) => {
  if (!args[0]) throw new Error('istat: missing operand');

  const inode = await sys.call(SYS.STAT, args[0]) as Inode;
  const fmt = (ts: number) => new Date(ts).toLocaleString('ja-JP');
  return [
    'inode:    ' + inode.id,
    'type:     ' + inode.type,
    'size:     ' + inode.size,
    'links:    ' + inode.nlink,
    'created:  ' + fmt(inode.created),
    'modified: ' + fmt(inode.modified),
  ].join('\n');
});
```

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

#### 実装例

`src/kernel/KernelError.ts` に EMLINK を追加:

```typescript
export const EMLINK  = 31;  // Too many links
// errnoMessages にも追加:
[EMLINK]: 'Too many links',
```

`src/kernel/FileSystem.ts` の import に `EMLINK` を追加し、`mkdir()` と `open()` に制限チェックを追加:

```typescript
import { ENOENT, EEXIST, ENOTDIR, EISDIR, ENOSPC, EBADF, EMLINK, KernelError } from './KernelError';

const MAX_DIR_ENTRIES = 10;

// mkdir() の parentEntries.push(...) の直前に挿入
const userEntries = parentEntries.filter(e => e.name !== '.' && e.name !== '..');
if (userEntries.length >= MAX_DIR_ENTRIES)
  throw new KernelError(EMLINK, path);

// open() の新規ファイル作成時、parent.push(...) の直前にも同様に挿入
const userEntries2 = parent.filter(e => e.name !== '.' && e.name !== '..');
if (userEntries2.length >= MAX_DIR_ENTRIES)
  throw new KernelError(EMLINK, path);
```

### 確認ポイント

- inode とディレクトリエントリはなぜ分離されているか？
- ファイルを削除しても inode が残る場合があるのはなぜか？（nlink の意味）

---

## Module 3：プロセス管理を観察・操作する

**目標**: PCB・プロセス状態遷移・スケジューリングを理解する

**学ぶ概念**: PCB、running/ready/waiting/zombie、ラウンドロビン

この Module では、`ps` の表示を拡張しながら PCB の中身を読む。
次に `yield` / `resume` のログを見て、協調的スケジューリングの状態遷移を観察する。
最後に優先度の扱いを追加し、スケジューラーの方針を変える練習をする。

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

#### 実装例

`src/kernel/Syscall.ts` の `handlePs()` を修正:

```typescript
private handlePs() {
  const now = Date.now();
  return this.sched.list().map(p => ({
    pid: p.pid, ppid: p.ppid, name: p.name, state: p.state,
    cpu: p.cpuTime, start: p.startTime,
    elapsed: Math.floor((now - p.startTime) / 1000),
  }));
}
```

`src/shell/commands/index.ts` の `ps` コマンドを修正:

```typescript
commands.set('ps', async (_args, _stdin, sys) => {
  type PsRow = { pid: number; ppid: number; name: string; state: string; cpu: number; elapsed: number };
  const list = await sys.call(SYS.PS) as PsRow[];
  const header = 'PID  PPID  STATE    CPU_MS  ELAPSED  NAME';
  const rows = list.map(p =>
    String(p.pid).padEnd(5) +
    String(p.ppid).padEnd(6) +
    p.state.padEnd(9) +
    String(p.cpu).padEnd(8) +
    (p.elapsed + 's').padEnd(9) +
    p.name
  );
  return [header, ...rows].join('\n');
});
```

### 課題 3-B：プロセス状態遷移を観察する

`Scheduler.ts` の `handleYield()` にログを追加して、プロセスがどのタイミングで `running` → `ready` → `running` を繰り返すかをコンソールで確認する。

```typescript
// handleYield に追加
console.log(`[Scheduler] PID ${pid}: running → ready`);
```

`src/kernel/Scheduler.ts` の `handleYield()` に実際に挿入する位置:

```typescript
handleYield(pid: number): void {
  const pcb = this.table.get(pid);
  if (!pcb || pcb.state === 'zombie') return;
  console.log(`[Scheduler] PID ${pid}: running → ready`);  // ← ここに追加
  pcb.state = 'ready';
  this.readyQueue.push(pid);
  this.scheduleNext();
}
```

ブラウザの DevTools → Console で `[Scheduler]` のログを確認する。

### 課題 3-C：優先度付きスケジューリングを実装する

`PCB.priority` フィールドが 0（高）〜19（低）で定義されている。
現在はラウンドロビンだが、priority が低いプロセスは2回に1回だけ resume するよう改造する。

#### 実装例

`src/kernel/Scheduler.ts` に `skipNext` フィールドを追加し、`scheduleNext()` を改造:

```typescript
export class Scheduler {
  // ... 既存フィールド ...
  private skipNext = new Set<number>();  // 追加

  scheduleNext(): void {
    const nextPid = this.readyQueue.shift();
    if (nextPid == null) return;
    const pcb = this.table.get(nextPid);
    if (!pcb || pcb.state === 'zombie') { this.scheduleNext(); return; }

    // priority >= 10（低優先度）のプロセスは2回に1回スキップ
    if (pcb.priority >= 10 && this.skipNext.has(nextPid)) {
      this.skipNext.delete(nextPid);
      this.readyQueue.push(nextPid);  // 末尾に戻して次回実行
      this.scheduleNext();
      return;
    }
    if (pcb.priority >= 10) this.skipNext.add(nextPid);

    pcb.state = 'running';
    pcb.worker.postMessage({ type: 'resume' } satisfies WorkerMessage);
  }
}
```

> `fork()` で生成されるプロセスは `priority: 10` なので、init（priority: 0）より低優先度として扱われる。

### 確認ポイント

- PID=1（init）を kill できないのはなぜか？（`Scheduler.ts` の kill を確認）
- `zombie` 状態はいつ発生するか？zombie になったプロセスはどうなるか？

---

## Module 4：メモリを意図的に枯渇させる

**目標**: ページング・断片化・OOM（Out of Memory）を体感する

**学ぶ概念**: ページング、断片化、スワップなしの制約

この Module では、64KB の物理メモリを 4KB ページとして観察する。
`free` と `memmap` で使用ページを可視化し、最後に `stress` で意図的に OOM を起こす。
メモリが有限で、プロセス生成にもコストがあることを体感する。

### 課題 4-A：`free` コマンドの出力を詳細化する

現在の表示にページ単位の情報を追加する。

```
$ free
              total   used   free   pages
Mem:            64K     8K    56K   2/16
```

`MemoryManager.ts` の `getUsage()` を拡張して使用ページ数 / 総ページ数も返すか、コマンド側で `used / 4096` を計算する。
コマンド側からは `sys.call(SYS.MEMINFO)` で取得する。

#### 実装例

`getUsage()` はバイト単位で返すので、コマンド側でページ数を計算することもできる:

`src/shell/commands/index.ts` の `free` コマンドを修正:

```typescript
commands.set('free', async (_args, _stdin, sys) => {
  const info = await sys.call(SYS.MEMINFO) as { used: number; free: number; total: number };
  const PAGE_SIZE = 4096;
  const usedPages  = info.used  / PAGE_SIZE;
  const totalPages = info.total / PAGE_SIZE;
  const kb = (n: number) => String(Math.round(n / 1024)) + 'K';
  return [
    '              total        used        free   pages',
    'Mem:  ' +
      kb(info.total).padStart(12) +
      kb(info.used).padStart(12) +
      kb(info.free).padStart(12) +
      `   ${usedPages}/${totalPages}`,
  ].join('\n');
});
```

### 課題 4-B：メモリ使用量の可視化コマンド `memmap` を実装する

ページテーブルを視覚的に表示するコマンド。

```
$ memmap
Page map (16 pages, 4KB each):
[1][2][.][.][.][.][.][.][.][.][.][.][.][.][.][.]
 1=init  2=shell  .=空き
```

`MemoryManager.ts` に `getPageMap()` のような public メソッドを追加し、`Syscall.ts` に `SYS.MEMMAP` を追加してシェルから呼び出す。
`pageTable` をコマンドから直接参照しない。

#### 実装例

`MemoryManager.ts` に `getPageMap()` を追加:

```typescript
getPageMap(): number[] {
  return Array.from(this.pageTable);
}
```

`src/kernel/Syscall.ts` に `MEMMAP` を追加:

```typescript
export enum SYS {
  // ... 既存 ...
  MEMMAP  = 16,  // 追加
}

// dispatch() の switch に追加
case SYS.MEMMAP: return this.memory.getPageMap();
```

`src/shell/commands/index.ts` に `memmap` コマンドを追加:

```typescript
commands.set('memmap', async (_args, _stdin, sys) => {
  const pages = await sys.call(SYS.MEMMAP) as number[];
  const cells = pages.map(pid => pid === 0 ? '.' : String(pid)).join('][');
  return [
    `Page map (${pages.length} pages, 4KB each):`,
    '[' + cells + ']',
    ' . = 空き  数字 = 使用中 PID',
  ].join('\n');
});
```

### 課題 4-C：大量プロセスを生成して OOM を発生させる

`stress` コマンドを作り、内部で `sys.call(SYS.FORK, 'stress-worker')` を繰り返してメモリが枯渇したときに何が起きるかを観察する。
`Scheduler.fork()` をコマンドから直接呼び出さない。

#### 実装例

`src/shell/commands/index.ts` に `stress` コマンドを追加:

```typescript
commands.set('stress', async (args, _stdin, sys) => {
  const count = parseInt(args[0] ?? '5');
  if (isNaN(count) || count < 1) throw new Error('stress: invalid count');
  let spawned = 0;
  for (let i = 0; i < count; i++) {
    try {
      await sys.call(SYS.FORK, 'stress-worker');
      spawned++;
    } catch (e) {
      return `Spawned ${spawned}/${count} workers. OOM: ${(e as Error).message}`;
    }
  }
  return `Spawned ${spawned} workers. Run 'free' or 'memmap' to observe.`;
});
```

> 1プロセスあたり 4KB（1ページ）消費。起動時に init と shell で 2 ページ使用済みなので、追加で最大 14 プロセスまで起動できる。`stress 20` で OOM を発生させられる。

### 確認ポイント

- スワップがないと何が起きるか？
- 16ページ（64KB）の制約でどんなプログラムが動かせなくなるか？

---

## Module 5：割り込みを止めてみる

**目標**: 割り込み駆動処理の重要性を逆から理解する

**学ぶ概念**: 割り込み駆動、ポーリング、タイマー割り込み

この Module では、まず `irq.start()` を止めて現状の挙動を確認する。
現在の TIMER ハンドラーは拡張用なので、止めてもコマンド実行や協調スケジューリングには影響しない。
その後 `uptime` を実装し、タイマー割り込みを観察可能な機能へ育てる。

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

#### 実装例

`src/kernel/index.ts` に `tickCount` を追加し、タイマー割り込みでカウントアップ:

```typescript
export class Kernel {
  // ... 既存フィールド ...
  private tickCount = 0;
  getTicks(): number { return this.tickCount; }

  async boot(print: PrintFn): Promise<number> {
    // ... 既存の初期化処理 ...

    // irq.register を修正してカウンターをインクリメント
    this.irq.register(InterruptType.TIMER, () => { this.tickCount++; });
    this.irq.start();
    // ...
  }
}
```

`src/kernel/Syscall.ts` に `UPTIME` syscall を追加:

```typescript
// SYS enum に追加
export enum SYS {
  // ... 既存 ...
  UPTIME  = 17,  // MEMMAP=16 を追加済みの場合。未追加なら次の空き番号を使う。
}

// Syscall のコンストラクターに getTicks を追加
export class Syscall {
  constructor(
    private readonly fs:       FileSystem,
    private readonly sched:    Scheduler,
    private readonly memory:   MemoryManager,
    private readonly getTicks: () => number = () => 0,  // 追加
  ) {}

  // dispatch() の switch 内に追加
  private async dispatch(pid: number, num: SYS, args: unknown[]): Promise<unknown> {
    // ...
    case SYS.UPTIME: return { ticks: this.getTicks(), ms: this.getTicks() * 50 };
    // ...
  }
}
```

`src/kernel/index.ts` で `Syscall` 生成時に `getTicks` を渡す:

```typescript
// constructor() 内
this.syscall = new Syscall(this.fs, this.sched, this.memory, () => this.tickCount);
```

`src/shell/commands/index.ts` に `uptime` コマンドを追加:

```typescript
commands.set('uptime', async (_args, _stdin, sys) => {
  const info = await sys.call(SYS.UPTIME) as { ticks: number; ms: number };
  return `System uptime: ${info.ticks} ticks (${info.ms}ms)`;
});
```

### 確認ポイント

- 現状では TIMER ハンドラーが空なので、`irq.start()` を止めてもスケジューリングには影響しないことを確認する
- タイマーハンドラーを実装すると、どのような機能を作れるか？
- 協調方式とプリエンプティブ方式の違いは？
- ポーリング方式（`while(true)` でチェック）と割り込み方式の違いは？

---

## Module 6：自由課題

**目標**: ここまでの理解を組み合わせて自分のアイデアを実装する

この Module では、小さな成功体験を作る課題から、複数モジュールをまたぐ拡張まで自由に選ぶ。
最初は 1 ファイルで完結するコマンドから始めるとよい。
慣れてきたら FileSystem、Scheduler、Pipeline を組み合わせる課題に進む。

### 推奨テーマ

| テーマ | 難易度 | 関連モジュール |
|--------|--------|--------------|
| `whoami` コマンド | ☆☆☆ | commands/index.ts |
| `uname` コマンド | ☆☆☆ | commands/index.ts |
| `pwd` の表示形式変更 | ☆☆☆ | commands/index.ts |
| `free --json` | ★☆☆ | commands/index.ts |
| `tree` コマンド | ★☆☆ | FileSystem |
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

> **Note:** 通常のユーザープロセスは Web Worker と PCB で管理する。ユーザー入力を扱う Shell UI はブラウザのメインスレッドで動き、PID=2 の shell PCB として `SysHelper` 経由でカーネルへ操作を依頼する。
