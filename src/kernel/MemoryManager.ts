// ============================================================
// MemoryManager — 64KB / 4KB ページ / スワップなし
// ============================================================
import { ENOMEM, KernelError } from './KernelError';
import type { MemorySegment } from '../types';

const MEMORY_SIZE = 64 * 1024;           // 64 KB
const PAGE_SIZE   = 4  * 1024;           // 4 KB
const TOTAL_PAGES = MEMORY_SIZE / PAGE_SIZE; // 16 ページ

export class MemoryManager {
  private readonly pool      = new ArrayBuffer(MEMORY_SIZE);
  private readonly pageTable = new Uint8Array(TOTAL_PAGES); // 0=free, pid=used

  init(): void {
    this.pageTable.fill(0);
  }

  async alloc(pid: number, size: number): Promise<MemorySegment> {
    const needed = Math.ceil(size / PAGE_SIZE);
    const start  = this.findContiguous(needed);
    if (start === -1) {
      throw new KernelError(ENOMEM);
    }
    for (let i = start; i < start + needed; i++) this.pageTable[i] = pid;
    return {
      base:  start * PAGE_SIZE,
      size,
      pages: Array.from({ length: needed }, (_, i) => start + i),
    };
  }

  async free(segment: MemorySegment): Promise<void> {
    for (const p of segment.pages) this.pageTable[p] = 0;
  }

  getUsage(): { used: number; free: number; total: number } {
    const usedPages = Array.from(this.pageTable).filter(p => p !== 0).length;
    return {
      used:  usedPages * PAGE_SIZE,
      free:  (TOTAL_PAGES - usedPages) * PAGE_SIZE,
      total: MEMORY_SIZE,
    };
  }

  getView(): Uint8Array {
    return new Uint8Array(this.pool);
  }

  private findContiguous(needed: number): number {
    let count = 0;
    let start = -1;
    for (let i = 0; i < TOTAL_PAGES; i++) {
      if (this.pageTable[i] === 0) {
        if (count === 0) start = i;
        count++;
        if (count === needed) return start;
      } else {
        count = 0;
        start = -1;
      }
    }
    return -1;
  }
}
