# small OS — コード解説

## はじめに

このドキュメントは small OS の各コンポーネントがどう動くかを解説します。
コードを読む際の道案内として使ってください。

---

## 起動の流れ

```
src/main.ts
  └─ kernel.boot()          カーネルを初期化
       ├─ memory.init()     ページテーブルをゼロクリア
       ├─ fs.init()         localStorageを読む or ルート / を作成
       ├─ sched.setMemory() Scheduler に MemoryManager を注入
       ├─ sched.connect()   syscall/stdout/exitのハンドラーを登録
       ├─ irq.start()       タイマー割り込みを開始
       ├─ spawnInit()       PID=1（init）のWorkerを生成
       └─ fork("shell")     shell プロセス PID を生成して返す
  └─ new Shell(..., pid)     shell PID に束縛した SysHelper を作る
  └─ shell.attach()         プロンプトを表示してキー入力を待つ
```

main.ts はたった数行です。カーネルを起動してシェルをつなぐだけ。
OS の本体はすべて `kernel/` の中にあります。Shell は DOM 上の UI ですが、
通常のコマンド実行は shell PID に束縛された `SysHelper` 経由で行います。

---

## ユーザー空間とカーネル空間

small OS の最重要な設計は **2つの空間の分離** です。

```
ユーザー空間                 カーネル空間
─────────────────────        ──────────────────────────
Shell / コマンド群           Scheduler
Terminal UI           ──→   MemoryManager
                    Syscall  FileSystem
                      ↑      InterruptController
                   境界線
```

コマンドと Pipeline は `FileSystem` や `Scheduler` を直接呼びません。
必ず `SysHelper` の `sys.call(SYS.XXX, ...)` から `Syscall.ts` を経由します。

Shell 本体は DOM 入力を管理する UI オブジェクトでもあるため、shell プロセスの zombie 検出と再起動だけは制御プレーンとして `Scheduler` を直接参照します。
通常のファイル操作、プロセス操作、メモリ情報取得などは `SysHelper` 経由です。

**なぜ分離するのか？**
本物の OS では、ユーザープログラムが誤ってカーネルのメモリを壊さないよう
CPU の特権モード（Ring 0/Ring 3）で隔離します。
small OS ではそれを「Syscall 経由でしかカーネルを呼べない」という
コード上の約束で再現しています。

---

## Syscall.ts の仕組み

```typescript
// コマンドからの呼び出し（ユーザー空間）
const fd = await sys.call(SYS.OPEN, '/home/memo.txt', OpenFlag.READ);
const text = await sys.call(SYS.READ, fd);
await sys.call(SYS.CLOSE, fd);

// Syscall 内部（カーネル空間への入口）
async call(pid, num, args): Promise<SyscallResult> {
  try {
    const value = await this.dispatch(pid, num, args);
    return { ok: true, value };
  } catch (e) {
    return { ok: false, errno: e.errno, message: e.message };
  }
}
```

`call()` は必ず `{ ok, value }` または `{ ok: false, errno }` を返します。
Shell 側の `SysHelper` は失敗時に Error を throw し、Pipeline が受け取って表示します。
エラーが起きてもシステムは止まらず、呼び出し元にエラーが返るだけです。
これがカーネルパニック時でも「エラー表示して継続」できる理由です。

---

## FileSystem.ts の仕組み

### inode とは何か

ファイルの「実体」です。ファイル名は持ちません。

```
inode テーブル              ディレクトリエントリ
┌────────────────────┐     ┌──────────────────────┐
│ id: 2              │ ←── │ name: "memo.txt"      │
│ type: "file"       │     │ inode: 2              │
│ size: 11           │     └──────────────────────┘
│ data: "hello world"│
└────────────────────┘
```

`rm memo.txt` はディレクトリエントリを削除するだけで、
inode の `nlink`（参照カウント）が 0 になって初めて inode も消えます。
これがハードリンクの仕組みです。

### パス解決

`/home/takashi/memo.txt` を解決する手順：

```
1. inode=1（ルート/）のディレクトリエントリから "home" を探す
2. "home" の inode からさらに "takashi" を探す
3. "takashi" の inode から "memo.txt" を探す
4. 見つかった inode を返す
```

`FileSystem.ts` の `resolveFull()` メソッドがこの処理を担います。
カレントディレクトリは FileSystem のグローバル状態ではなく、各 `PCB.cwd` に inode ID として保存されます。
そのため、別プロセスの `cd` は他プロセスの CWD に影響しません。

### FD（ファイルディスクリプター）の所有者

FD はプロセスごとに管理します。

```
PID=2(shell)  → FD 3, FD 4
PID=5(worker) → FD 5
```

`OPEN` は `FileSystem.open(path, flags, cwd, pid)` を呼び、FD を PID に紐づけます。
`READ` / `WRITE` / `CLOSE` は呼び出し PID と FD 所有者が一致するか検証し、
一致しない場合や存在しない FD の場合は `EBADF` を返します。
プロセス終了時には `closeAllForPid(pid)` で開きっぱなしの FD を回収します。

### localStorage への保存

書き込みが発生するたびに `persist()` が呼ばれます。

```typescript
private persist(): void {
  const snap = {
    inodes: Array.from(this.inodes.entries()),
    dirs:   Array.from(this.dirs.entries()),
    seq:    this.seq,
  };
  localStorage.setItem('small-os-fs-v1', JSON.stringify(snap));
}
```

`init()` では逆にこの JSON を読み込んで Map を復元します。
これによりページリロード後もファイルが残ります。

---

## Scheduler.ts と Web Worker の仕組み

### なぜ Web Worker を使うのか

JavaScript はシングルスレッドです。
`setTimeout` で「並行っぽく見せる」方法もありますが、
small OS では各プロセスを独立した **Web Worker** として実行することで
本物のスレッド並行を実現しています。

```
メインスレッド（スケジューラー）
  │
  ├─ Worker(PID=1: init)    ← 別スレッドで動く
  ├─ Worker(PID=2: shell)   ← shell 用 PCB / Worker
  └─ Worker(PID=3: ...)     ← 別スレッドで動く
```

注意: 現在の Shell UI 自体は DOM メインスレッド上で動きます。
ただし、Shell は PID=2 の PCB を持ち、すべてのカーネル操作をその PID の syscall として発行します。
`kill 2` で shell PCB が zombie になると、Shell は UI 管理処理として `Scheduler` を確認し、次の入力時に新しい shell プロセスを fork して再起動します。

### 協調スケジューリングの仕組み

プロセス（Worker）は自分から「次に譲る」と宣言します。

```
プロセス側（process.worker.ts）        スケジューラー側（Scheduler.ts）
─────────────────────────────         ──────────────────────────────────
// 処理を実行...                        worker.onmessage = (e) => {
postMessage({ type: 'yield' })  →→→     if (e.data.type === 'yield') {
                                           // ready キューに戻す
await waitForResume()           ←←←       this.scheduleNext(); // 次のWorkerにresume
                                         }
// 続きを実行...                         };
```

`waitForResume()` は `resume` メッセージが来るまで非同期で待機します。
プロセスを強制停止する必要がないため COOP/COEP ヘッダーも不要です。

### PCB（プロセス制御ブロック）

プロセスの「戸籍」です。OS は PCB の集合体でプロセスを管理します。

```typescript
interface PCB {
  pid:       number;       // プロセス ID
  ppid:      number;       // 親プロセスの ID
  name:      string;       // "shell", "init" など
  state:     ProcessState; // running / ready / waiting / zombie
  worker:    Worker;       // 対応する Web Worker
  memory:    MemorySegment;// 割り当てメモリ領域
  openFiles: number[];     // 学習用フィールド（FD 実体は FileSystem が PID 別管理）
  startTime: number;       // 起動時刻
  cpuTime:   number;       // 累積 CPU 時間
  cwd:       number;       // カレントディレクトリ inode
}
```

`ps` コマンドはこの PCB テーブルをそのまま表示しています。

---

## MemoryManager.ts の仕組み

### ページングとは

64KB のメモリを 4KB のページ 16 枚に分割して管理します。

```
物理メモリ（64KB）
┌────┬────┬────┬────┬────┬────┬────┬────┐
│ P0 │ P1 │ P2 │ P3 │ P4 │ P5 │ P6 │ P7 │  ... 16ページ
└────┴────┴────┴────┴────┴────┴────┴────┘
  ↑     ↑
PID=1 PID=2   ← pageTable[i] にどのプロセスが使っているか記録

pageTable = [1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
             ^PID1  ^PID2  ^空き
```

プロセスが終了すると `free()` で `pageTable[i] = 0` に戻します。
終了処理は `Scheduler.exit()` に集約されており、Worker 停止、zombie 化、ready queue からの除去、メモリ解放、exit ハンドラー通知をまとめて行います。

### スワップなしの意味

small OS はスワップ（ディスクへの退避）を実装していません。
16ページ（64KB）を超える割り当て要求には `ENOMEM` エラーを返します。

```
$ stress    // 大量メモリを確保するコマンドを作ると...
Kernel: Cannot allocate memory
```

実際の OS でスワップがないとどうなるか（OOM Killer など）を
体験的に理解するのがこのモジュールのねらいです。

---

## InterruptController.ts の仕組み

### 割り込みとは

「今やっていることを中断して、優先度の高い処理を先にやる」仕組みです。
キーボード入力があったとき、OS はそれを「割り込み」として受け取ります。

small OS では `setInterval` でタイマー割り込みを模擬します。

```typescript
start(): void {
  this.timerId = setInterval(() => {
    this.fire(InterruptType.TIMER); // 50ms ごとに呼ばれる
  }, 50);
}
```

### 割り込みを止めると何が起きるか

`irq.start()` をコメントアウトするとタイマーが止まります。
現在の実装ではスケジューラーは yield/resume で動くため
タイマーを止めてもスケジューリングは止まりません。

しかし将来的にタイマーでスケジューラーの `tick()` を呼ぶ設計に変えると、
タイマーを止めた瞬間に全プロセスがフリーズします。
これが「割り込み駆動」の本質です。

---

## Shell / Pipeline の仕組み

### コマンド実行の流れ

```
ユーザー入力: "ls | grep txt > out.txt"
      ↓
Pipeline.runLine()
      ↓
1. リダイレクト（>）を先に解析
   → outFile = "out.txt"
   → 残り: "ls | grep txt"

2. パイプ（|）で分割
   → segments = ["ls", "grep txt"]

3. 左から順に実行
   ls の stdout → grep txt の stdin
   grep txt の stdout → out.txt に書き込み
```

### stdin / stdout の渡し方

パイプは単純に「前のコマンドの戻り値（string）を次の stdin に渡す」だけです。

```typescript
let stdin = '';
for (const segment of segments) {
  const stdout = await fn(args, stdin, sys, term);
  stdin = stdout;   // 次のコマンドの stdin になる
}
```

本物の OS では pipe はバイトストリームですが、
small OS では文字列を渡すだけでパイプの概念を再現しています。

---

## エラー処理の設計

Linux と同じ errno 体系を使っています。

```typescript
// エラーを投げる側（FileSystem 内）
throw new KernelError(ENOENT, path);
// → "memo.txt: No such file or directory"

// Syscall が受け取って errno に変換
return { ok: false, errno: 2, message: "memo.txt: No such file or directory" }

// Pipeline がユーザーに表示
term.printError("cat: memo.txt: No such file or directory");
```

エラーが起きても `KernelError` を `catch` して errno を返すだけなので
システム全体が止まることはありません。これが「エラー表示して継続」の実装です。

---

## ファイル間の依存関係

```
main.ts
  └─ kernel/index.ts（Kernel）
       ├─ kernel/MemoryManager.ts
       ├─ kernel/FileSystem.ts
       ├─ kernel/Scheduler.ts
       │    └─ workers/process.worker.ts
       ├─ kernel/InterruptController.ts
       ├─ kernel/Syscall.ts
       │    └─ kernel/KernelError.ts
       └─ types/index.ts
  └─ terminal/Terminal.ts
  └─ shell/Shell.ts
       └─ shell/Pipeline.ts
            └─ shell/commands/index.ts
                 └─ SysHelper → kernel/Syscall.ts
```

コマンド群と Pipeline は `SysHelper` を通じて `Syscall.ts` にアクセスします。
内部の `FileSystem` や `Scheduler` を直接 import することは想定していません。
Shell の zombie 検出・再起動だけは、DOM UI を維持するための制御プレーンとして例外的に `Scheduler` を参照します。
