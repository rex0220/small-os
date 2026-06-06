# small OS — カーネル設計

## 設計方針（確定）

| 項目 | 決定内容 |
|------|---------|
| カーネル構造 | モノリシックカーネル |
| 非同期モデル | async / await（システムコールはすべて非同期） |
| プロセス並行 | Web Worker — 各プロセスを独立 Worker で実行（協調方式：Worker が yield を通知） |
| 仮想メモリ | 64 KB、ページサイズ 4 KB（16 ページ）、スワップなし |
| ファイルシステム | inode 上限 1,000、localStorage で永続化 |
| シェル | パイプ（`\|`）・リダイレクト（`>`）を初版からサポート |
| エラー処理 | Linux ライクなメッセージ、カーネルパニック時もエラー表示して継続 |

---

## カーネルの全体構造

```
┌──────────────────────────────────────────────────┐
│                  ユーザー空間                      │
│   Shell / コマンド群  ←→  Terminal UI             │
├──────────────────────────────────────────────────┤
│               システムコール層                     │
│         Syscall.ts  (API ゲートウェイ)             │
├────────────┬─────────────┬───────────────────────┤
│  プロセス  │  メモリ     │  ファイルシステム       │
│  管理      │  管理       │  (VFS)                │
│ Scheduler  │  MemoryMgr  │  FileSystem           │
├────────────┴─────────────┴───────────────────────┤
│               割り込みコントローラー               │
│              InterruptController.ts               │
├──────────────────────────────────────────────────┤
│         ハードウェア抽象層（ブラウザー API）        │
│   setTimeout / setInterval / localStorage 等      │
└──────────────────────────────────────────────────┘
```

---

## 各コンポーネントの設計

### 1. システムコール層 `Syscall.ts`

ユーザー空間（シェル・コマンド）とカーネルを分離する唯一の窓口。  
コマンドは直接カーネル内部を呼ばず、必ず Syscall 経由で操作する。

```typescript
// システムコール番号の定義
export const enum SYS {
  READ    = 0,
  WRITE   = 1,
  OPEN    = 2,
  CLOSE   = 3,
  FORK    = 4,
  EXIT    = 5,
  GETPID  = 6,
  KILL    = 7,
  MKDIR   = 8,
  UNLINK  = 9,
}

// システムコール実行（非同期）
export async function syscall(num: SYS, ...args: unknown[]): Promise<SyscallResult> {
  switch (num) {
    case SYS.WRITE:  return await kernel.fs.write(args[0] as string, args[1] as string);
    case SYS.FORK:   return await kernel.scheduler.fork();
    case SYS.GETPID: return kernel.scheduler.currentPid();
    // ...
  }
}
```

---

### 2. プロセス管理 + スケジューラー `Scheduler.ts`

各プロセスは独立した **Web Worker** として動作する。  
**協調方式**：Worker 側が処理の区切りで `{ type: "yield" }` を postMessage し、スケジューラーが次の実行プロセスを選んで `{ type: "resume" }` を返す。外部から強制停止はしない。

```typescript
type ProcessState = "running" | "ready" | "waiting" | "zombie";

interface PCB {               // Process Control Block
  pid:       number;
  ppid:      number;          // 親プロセス PID
  name:      string;
  state:     ProcessState;
  priority:  number;          // 0（高）〜 19（低）
  worker:    Worker;          // 対応する Web Worker インスタンス
  memory:    MemorySegment;   // 割り当てメモリ
  openFiles: FileDescriptor[];
  startTime: number;
  cpuTime:   number;          // 累積 CPU 時間（ms）
}
```

**Web Worker 協調スケジューリング（ラウンドロビン）**

```typescript
// --- process.worker.ts（プロセス側）---
// 処理の区切りごとに yield を送り、resume を待ってから続行
async function runProcess() {
  while (true) {
    // ... 処理 ...

    // スケジューラーへ yield を通知
    postMessage({ type: "yield" });
    // resume が届くまで待機
    await waitForResume();
  }
}

function waitForResume(): Promise<void> {
  return new Promise(resolve => {
    self.onmessage = (e) => { if (e.data.type === "resume") resolve(); };
  });
}

// --- Scheduler.ts（スケジューラー側）---
class Scheduler {
  private table = new Map<number, PCB>();
  private queue: number[] = [];   // ready キュー
  private pidCounter = 1;

  async fork(): Promise<number> {
    const pid = this.pidCounter++;
    const worker = new Worker(
      new URL("../workers/process.worker.ts", import.meta.url),
      { type: "module" }
    );
    worker.onmessage = (e) => this.handleYield(pid, e.data);
    this.table.set(pid, { pid, worker, state: "ready", ... });
    this.queue.push(pid);
    return pid;
  }

  private handleYield(pid: number, msg: WorkerMessage) {
    if (msg.type === "yield") {
      // 現プロセスを ready に戻し、次のプロセスを選んで resume
      const pcb = this.table.get(pid)!;
      pcb.state = "ready";
      this.queue.push(pid);
      this.scheduleNext();
    }
    if (msg.type === "syscall") {
      // syscall を処理して結果を返す
      this.handleSyscall(pid, msg);
    }
  }

  private scheduleNext() {
    const nextPid = this.queue.shift();
    if (nextPid == null) return;
    const pcb = this.table.get(nextPid)!;
    pcb.state = "running";
    pcb.worker.postMessage({ type: "resume" });
  }

  async kill(pid: number): Promise<void> {
    const pcb = this.table.get(pid);
    if (!pcb) throw new KernelError(ESRCH, `kill: (${pid}) - No such process`);
    pcb.worker.terminate();
    pcb.state = "zombie";
  }
}
```

---

### 3. メモリ管理 `MemoryManager.ts`

**固定仕様**: 64 KB / ページサイズ 4 KB / 16 ページ / スワップなし

`ArrayBuffer` でメモリ空間を模擬する。スワップなしのため、16 ページを超える割り当てはエラー。

```typescript
const MEMORY_SIZE  = 64 * 1024;              // 64 KB
const PAGE_SIZE    = 4  * 1024;              // 4 KB（固定）
const TOTAL_PAGES  = MEMORY_SIZE / PAGE_SIZE; // 16 ページ

class MemoryManager {
  private pool      = new ArrayBuffer(MEMORY_SIZE);
  private pageTable = new Uint8Array(TOTAL_PAGES);  // 0=空き, PID=使用中

  async alloc(pid: number, size: number): Promise<MemorySegment> {
    const pages = Math.ceil(size / PAGE_SIZE);
    const start = this.findFreePages(pages);
    if (start === -1) {
      // スワップなし → OOM エラー（表示して継続）
      throw new KernelError(ENOMEM, `Cannot allocate memory`);
    }
    for (let i = start; i < start + pages; i++) this.pageTable[i] = pid;
    return { base: start * PAGE_SIZE, size, pages: range(start, pages) };
  }

  async free(segment: MemorySegment): Promise<void> {
    segment.pages.forEach(p => (this.pageTable[p] = 0));
  }

  getUsage(): { used: number; free: number; total: number } {
    const used = this.pageTable.filter(p => p !== 0).length * PAGE_SIZE;
    return { used, free: MEMORY_SIZE - used, total: MEMORY_SIZE };
  }
}
```

---

### 4. 仮想ファイルシステム `FileSystem.ts`

**inode ベース**で実装する（ファイル名とデータを分離）。  
**固定仕様**: inode 上限 1,000、localStorage で自動永続化

```typescript
const MAX_INODES = 1000;
const LS_KEY     = "small-os-fs";   // localStorage キー

interface Inode {
  id:       number;   // 1〜1000
  type:     "file" | "dir";
  size:     number;
  created:  number;
  modified: number;
  data:     string;
}

class FileSystem {
  private inodes   = new Map<number, Inode>();
  private dirs     = new Map<number, DirEntry[]>();
  private inodeSeq = 2;   // 1 はルート予約
  private cwd      = 1;

  init() {
    // localStorage から復元、なければ初期化
    const saved = localStorage.getItem(LS_KEY);
    if (saved) {
      this.restore(JSON.parse(saved));
    } else {
      this.inodes.set(1, { id:1, type:"dir", size:0, created: Date.now(), modified: Date.now(), data:"" });
      this.dirs.set(1, [{ name:".", inode:1 }, { name:"..", inode:1 }]);
    }
  }

  private persist() {
    localStorage.setItem(LS_KEY, JSON.stringify(this.snapshot()));
  }

  async allocInode(): Promise<number> {
    if (this.inodes.size >= MAX_INODES)
      throw new KernelError(ENOSPC, "No space left on device");
    return this.inodeSeq++;
  }

  async write(fd: FileDescriptor, data: string): Promise<void> {
    // ... 書き込み後に persist() を呼ぶ
    this.persist();
  }
}
```

---

### 5. 割り込みコントローラー `InterruptController.ts`

タイマー割り込みを `setInterval` で模擬し、スケジューラーの `tick()` を定期呼び出しする。

```typescript
type InterruptHandler = () => void;

class InterruptController {
  private handlers = new Map<InterruptType, InterruptHandler>();

  register(type: InterruptType, handler: InterruptHandler) {
    this.handlers.set(type, handler);
  }

  start() {
    // タイマー割り込み（10ms ごと）
    setInterval(() => this.fire(InterruptType.TIMER), 10);
  }

  fire(type: InterruptType) {
    this.handlers.get(type)?.();
  }
}

const enum InterruptType {
  TIMER   = 0,   // スケジューラー tick
  KEYBOARD = 1,  // キー入力（Terminal から発火）
  SYSCALL  = 2,  // システムコール
}
```

---

### 6. エラー処理 `KernelError.ts`

**方針**: Linux ライクなエラーメッセージ、カーネルパニック時もエラー表示して継続

```typescript
// errno 定義
export const EPERM  = 1;   // Operation not permitted
export const ENOENT = 2;   // No such file or directory
export const ESRCH  = 3;   // No such process
export const ENOMEM = 12;  // Cannot allocate memory
export const EACCES = 13;  // Permission denied
export const EEXIST = 17;  // File exists
export const ENOSPC = 28;  // No space left on device

export class KernelError extends Error {
  constructor(public errno: number, message: string) {
    super(message);
  }
}

// エラーメッセージ書式（Linux ライク）
// <command>: <target>: <description>
// 例:
//   rm: /home/foo.txt: No such file or directory
//   mkdir: /home: File exists
//   kill: (99) - No such process

// カーネルパニックハンドラー
// → プロセスを zombie に → ターミナルにエラー表示 → シェルに制御を返す
export function kernelPanic(pid: number, err: KernelError) {
  kernel.scheduler.setZombie(pid);
  terminal.printError(`Kernel: process ${pid} terminated: ${err.message}`);
  // システム停止はしない
}
```

---

## カーネルの起動シーケンス

```typescript
// kernel/index.ts
class Kernel {
  readonly memory    = new MemoryManager();
  readonly fs        = new FileSystem();
  readonly scheduler = new Scheduler();
  readonly irq       = new InterruptController();

  boot() {
    // 1. メモリ初期化
    this.memory.init();

    // 2. ファイルシステム初期化（ルートディレクトリ作成）
    this.fs.init();

    // 3. 割り込みハンドラー登録
    this.irq.register(InterruptType.TIMER, () => this.scheduler.tick());

    // 4. init プロセス（PID=1）を生成
    this.scheduler.spawn("init", Priority.HIGH);

    // 5. 割り込みコントローラー開始
    this.irq.start();

    // 6. シェルプロセスを fork して端末に接続
    const shellPid = this.scheduler.fork();
    Shell.attach(shellPid);
  }
}

export const kernel = new Kernel();
kernel.boot();
```

---

## ファイル構成（カーネル部分）

```
src/kernel/
├── index.ts                # Kernel クラス・boot シーケンス
├── Syscall.ts              # システムコール層（非同期 async/await）
├── Scheduler.ts            # プロセス管理・Worker ベーススケジューラー
├── MemoryManager.ts        # 64KB / 4KB ページ管理（スワップなし）
├── FileSystem.ts           # inode ベース VFS（上限 1000・localStorage 永続化）
├── InterruptController.ts  # タイマー・割り込み制御
└── KernelError.ts          # errno 定義・Linux ライクエラー・パニックハンドラー

src/workers/
└── process.worker.ts       # プロセス実行用 Web Worker

tests/kernel/
├── scheduler.test.ts
├── memory.test.ts
├── filesystem.test.ts
└── error.test.ts
```

---

## 学習ポイント対応表

| カーネル機能 | 実装で学べる OS の概念 |
|------------|----------------------|
| Scheduler + PCB | コンテキストスイッチ、プロセス状態遷移 |
| MemoryManager | ページング、断片化、メモリリーク |
| FileSystem (inode) | inode とディレクトリエントリの分離、ハードリンク |
| Syscall | ユーザー空間とカーネル空間の分離、特権モード |
| InterruptController | 割り込み駆動処理、タイマー割り込み |
