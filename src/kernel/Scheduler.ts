// ============================================================
// Scheduler — Web Worker 協調スケジューラー
// ============================================================
import { ESRCH, EPERM, KernelError } from './KernelError';
import type { PCB, MemorySegment, WorkerMessage, SyscallResult } from '../types';
import type { MemoryManager } from './MemoryManager';

type SyscallHandler = (pid: number, num: number, args: unknown[]) => Promise<SyscallResult>;
type StdoutHandler  = (pid: number, text: string) => void;
type ExitHandler    = (pid: number, code: number) => void;

export class Scheduler {
  private table      = new Map<number, PCB>();
  private readyQueue: number[] = [];
  private pidCounter = 1;
  private memory!:   MemoryManager;
  private skipNext   = new Set<number>();

  private onSyscall: SyscallHandler = async () => ({ ok: false, errno: 22, message: 'not connected' });
  private onStdout:  StdoutHandler  = () => {};
  private onExit:    ExitHandler    = () => {};

  setMemory(mem: MemoryManager): void {
    this.memory = mem;
  }

  connect(handlers: { syscall: SyscallHandler; stdout: StdoutHandler; exit: ExitHandler }): void {
    this.onSyscall = handlers.syscall;
    this.onStdout  = handlers.stdout;
    this.onExit    = handlers.exit;
  }

  spawnInit(memory: MemorySegment): void {
    const pid    = this.pidCounter++;  // = 1
    const worker = this.createWorker(pid);
    const pcb: PCB = {
      pid, ppid: 0, name: 'init', state: 'running',
      priority: 0, worker, memory, openFiles: [],
      startTime: Date.now(), cpuTime: 0, cwd: 1,
    };
    this.table.set(pid, pcb);
  }

  async fork(ppid: number, name: string): Promise<number> {
    const pid    = this.pidCounter++;
    const memory = await this.memory.alloc(pid, 4096);
    const worker = this.createWorker(pid);
    const pcb: PCB = {
      pid, ppid, name, state: 'ready',
      priority: 10, worker, memory, openFiles: [],
      startTime: Date.now(), cpuTime: 0, cwd: 1,
    };
    this.table.set(pid, pcb);
    this.readyQueue.push(pid);
    return pid;
  }

  /**
   * プロセス終了の共通処理。
   * code=0 は正常終了（kill コマンドによる強制終了も含む）。
   * code!=0 はクラッシュ扱いでカーネルパニックメッセージが出る。
   * Worker も terminate して確実に停止させる。
   */
  async exit(pid: number, code: number): Promise<void> {
    const pcb = this.table.get(pid);
    if (!pcb || pcb.state === 'zombie') return;
    pcb.worker.terminate();           // Worker を確実に停止
    pcb.state = 'zombie';
    this.readyQueue = this.readyQueue.filter(p => p !== pid);
    await this.memory.free(pcb.memory);
    this.onExit(pid, code);
  }

  /**
   * 外部からのシグナル（kill コマンド）。
   * 管理操作なので code=0 で正常終了扱いにする。
   */
  async kill(pid: number, _fromPid: number): Promise<void> {
    if (pid === 1) throw new KernelError(EPERM, 'kill: (' + pid + ')');
    const pcb = this.table.get(pid);
    if (!pcb) throw new KernelError(ESRCH, 'kill: (' + pid + ')');
    await this.exit(pid, 0);  // kill は正常操作 → code=0
  }

  list(): PCB[] {
    return Array.from(this.table.values());
  }

  get(pid: number): PCB | undefined {
    return this.table.get(pid);
  }

  handleYield(pid: number): void {
    const pcb = this.table.get(pid);
    if (!pcb || pcb.state === 'zombie') return;
    console.log(`[Scheduler] PID ${pid}: running → ready`);
    pcb.state = 'ready';
    this.readyQueue.push(pid);
    this.scheduleNext();
  }

  scheduleNext(): void {
    const nextPid = this.readyQueue.shift();
    if (nextPid == null) return;
    const pcb = this.table.get(nextPid);
    if (!pcb || pcb.state === 'zombie') { this.scheduleNext(); return; }

    if (pcb.priority >= 10 && this.skipNext.has(nextPid)) {
      this.skipNext.delete(nextPid);
      this.readyQueue.push(nextPid);
      this.scheduleNext();
      return;
    }
    if (pcb.priority >= 10) this.skipNext.add(nextPid);

    pcb.state = 'running';
    pcb.worker.postMessage({ type: 'resume' } satisfies WorkerMessage);
  }

  private createWorker(pid: number): Worker {
    const worker = new Worker(
      new URL('../workers/process.worker.ts', import.meta.url),
      { type: 'module' }
    );
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const msg = e.data;
      if (msg.type === 'yield') {
        this.handleYield(pid);
      } else if (msg.type === 'syscall') {
        this.onSyscall(pid, msg.num, msg.args).then(result => {
          worker.postMessage({ type: 'syscall_result', callId: msg.callId, result } satisfies WorkerMessage);
        });
      } else if (msg.type === 'stdout') {
        this.onStdout(pid, msg.text);
      } else if (msg.type === 'exit') {
        this.exit(pid, msg.code);  // Worker からの exit メッセージ
      }
    };
    return worker;
  }
}
