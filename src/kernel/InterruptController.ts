// ============================================================
// InterruptController — タイマー・割り込み制御
// ============================================================

export enum InterruptType {
  TIMER    = 0,
  KEYBOARD = 1,
  SYSCALL  = 2,
}

type Handler = () => void;

export class InterruptController {
  private handlers = new Map<InterruptType, Handler>();
  private timerId: ReturnType<typeof setInterval> | null = null;
  private readonly TIMER_INTERVAL = 50; // ms

  register(type: InterruptType, handler: Handler): void {
    this.handlers.set(type, handler);
  }

  start(): void {
    this.timerId = setInterval(() => {
      this.fire(InterruptType.TIMER);
    }, this.TIMER_INTERVAL);
  }

  stop(): void {
    if (this.timerId != null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  fire(type: InterruptType): void {
    this.handlers.get(type)?.();
  }
}
