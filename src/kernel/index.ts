// ============================================================
// Kernel -- boot sequence
// ============================================================
import { MemoryManager }        from './MemoryManager';
import { FileSystem }           from './FileSystem';
import { Scheduler }            from './Scheduler';
import { InterruptController, InterruptType } from './InterruptController';
import { Syscall }              from './Syscall';
import { kernelPanic }          from './KernelError';

export type PrintFn = (text: string) => void;

export class Kernel {
  readonly memory   = new MemoryManager();
  readonly fs       = new FileSystem();
  readonly sched    = new Scheduler();
  readonly irq      = new InterruptController();
  readonly syscall: Syscall;
  readonly bootTime = Date.now();

  private print: PrintFn = () => {};

  constructor() {
    this.syscall = new Syscall(this.fs, this.sched, this.memory);
  }

  async boot(print: PrintFn): Promise<number> {
    this.print = print;

    // 1. memory
    this.memory.init();

    // 2. filesystem
    this.fs.init();

    // 3. inject memory into scheduler
    this.sched.setMemory(this.memory);

    // 4. connect handlers
    this.sched.connect({
      syscall: (pid, num, args) => this.syscall.call(pid, num, args),
      stdout:  (_pid, text) => this.print(text),
      exit: (pid, code) => {
        this.fs.closeAllForPid(pid);
        if (code !== 0) kernelPanic(pid, new Error('exit(' + String(code) + ')'), this.print);
      },
    });

    // 5. interrupts
    this.irq.register(InterruptType.TIMER, () => {});
    this.irq.start();

    // 6. init process (PID=1)
    const initMem = await this.memory.alloc(1, 4096);
    this.sched.spawnInit(initMem);

    // 7. shell process (PID=2)
    const shellPid = await this.sched.fork(1, 'shell');
    return shellPid;
  }
}

export const kernel = new Kernel();
