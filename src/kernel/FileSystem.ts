// ============================================================
// FileSystem -- inode-based VFS / max 1000 inodes / localStorage
// CWD per process (PCB.cwd). FD ownership enforced per PID.
// ============================================================
import { ENOENT, EEXIST, ENOTDIR, EISDIR, ENOSPC, EBADF, KernelError } from './KernelError';
import type { Inode, DirEntry, FileDescriptor, OpenFlag } from '../types';

const MAX_INODES = 1000;
const LS_KEY     = 'small-os-fs-v1';

interface FsSnapshot {
  inodes: [number, Inode][];
  dirs:   [number, DirEntry[]][];
  seq:    number;
}

function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

export class FileSystem {
  private inodes  = new Map<number, Inode>();
  private dirs    = new Map<number, DirEntry[]>();
  private seq     = 2;
  private nextFd  = 3;
  private fdTable = new Map<number, FileDescriptor & { pid: number }>();
  private pidFds  = new Map<number, Set<number>>();

  init(): void {
    const saved = localStorage.getItem(LS_KEY);
    if (saved) {
      try {
        const snap: FsSnapshot = JSON.parse(saved);
        this.inodes = new Map(snap.inodes);
        this.dirs   = new Map(snap.dirs);
        this.seq    = snap.seq;
        return;
      } catch { /* fall through */ }
    }
    const now = Date.now();
    this.inodes.set(1, { id: 1, type: 'dir', size: 0, created: now, modified: now, data: '', nlink: 2 });
    this.dirs.set(1, [{ name: '.', inode: 1 }, { name: '..', inode: 1 }]);
    this.persist();
  }

  async open(path: string, flags: OpenFlag, cwd = 1, pid = 0): Promise<number> {
    const inode = this.resolve(path, cwd);
    if (!inode && flags === 0) throw new KernelError(ENOENT, path);
    let id = inode?.id ?? 0;
    if (!inode) {
      id = this.allocInode();
      const now = Date.now();
      this.inodes.set(id, { id, type: 'file', size: 0, created: now, modified: now, data: '', nlink: 1 });
      const parent = this.parentDir(path, cwd);
      parent.push({ name: basename(path), inode: id });
      this.persist();
    }
    const fd = this.nextFd++;
    this.fdTable.set(fd, { fd, inodeId: id, offset: 0, flags, pid });
    if (!this.pidFds.has(pid)) this.pidFds.set(pid, new Set());
    this.pidFds.get(pid)!.add(fd);
    return fd;
  }

  async close(fd: number, pid = 0): Promise<void> {
    const entry = this.fdTable.get(fd);
    if (!entry) throw new KernelError(EBADF);           // Linux: closing unknown FD = EBADF
    if (pid !== 0 && entry.pid !== pid) throw new KernelError(EBADF);
    this.pidFds.get(entry.pid)?.delete(fd);
    this.fdTable.delete(fd);
  }

  closeAllForPid(pid: number): void {
    const fds = this.pidFds.get(pid);
    if (!fds) return;
    for (const fd of fds) this.fdTable.delete(fd);
    this.pidFds.delete(pid);
  }

  openFdCountForPid(pid: number): number {
    return this.pidFds.get(pid)?.size ?? 0;
  }

  async read(fd: number, pid = 0): Promise<string> {
    const desc  = this.getFd(fd, pid);
    const inode = this.getInode(desc.inodeId);
    if (inode.type === 'dir') throw new KernelError(EISDIR);
    return inode.data;
  }

  async write(fd: number, data: string, pid = 0): Promise<void> {
    const desc  = this.getFd(fd, pid);
    const inode = this.getInode(desc.inodeId);
    if (inode.type === 'dir') throw new KernelError(EISDIR);
    inode.data     = data;
    inode.size     = data.length;
    inode.modified = Date.now();
    this.persist();
  }

  async mkdir(path: string, cwd = 1): Promise<void> {
    if (this.resolve(path, cwd)) throw new KernelError(EEXIST, path);
    const isAbsolute  = path.startsWith('/');
    const parts       = splitPath(path);
    const parentParts = parts.slice(0, -1);
    const parentPath  = isAbsolute
      ? ('/' + parentParts.join('/'))
      : (parentParts.join('/') || '.');
    const parentInode = this.resolveFull(parentPath, cwd);
    if (!parentInode) throw new KernelError(ENOENT, parentPath);
    if (parentInode.type !== 'dir') throw new KernelError(ENOTDIR, parentPath);
    const parentEntries = this.dirs.get(parentInode.id);
    if (!parentEntries) throw new KernelError(ENOENT, parentPath);
    const id  = this.allocInode();
    const now = Date.now();
    this.inodes.set(id, { id, type: 'dir', size: 0, created: now, modified: now, data: '', nlink: 2 });
    parentEntries.push({ name: basename(path), inode: id });
    this.dirs.set(id, [{ name: '.', inode: id }, { name: '..', inode: parentInode.id }]);
    this.persist();
  }

  async unlink(path: string, cwd = 1): Promise<void> {
    const inode = this.resolve(path, cwd);
    if (!inode) throw new KernelError(ENOENT, path);
    if (inode.type === 'dir') throw new KernelError(EISDIR, path);
    const parent = this.parentDir(path, cwd);
    const name   = basename(path);
    const idx    = parent.findIndex(e => e.name === name);
    if (idx !== -1) parent.splice(idx, 1);
    inode.nlink--;
    if (inode.nlink <= 0) this.inodes.delete(inode.id);
    this.persist();
  }

  async stat(path: string, cwd = 1): Promise<Inode> {
    const inode = this.resolve(path, cwd);
    if (!inode) throw new KernelError(ENOENT, path);
    return { ...inode };
  }

  async readdir(path: string, cwd = 1): Promise<DirEntry[]> {
    const inode = this.resolve(path || '.', cwd);
    if (!inode) throw new KernelError(ENOENT, path);
    if (inode.type !== 'dir') throw new KernelError(ENOTDIR, path);
    return this.dirs.get(inode.id) ?? [];
  }

  async chdir(path: string, cwd = 1): Promise<number> {
    const inode = this.resolveFull(path, cwd);
    if (!inode) throw new KernelError(ENOENT, path);
    if (inode.type !== 'dir') throw new KernelError(ENOTDIR, path);
    return inode.id;
  }

  buildPath(inodeId: number): string {
    if (inodeId === 1) return '/';
    const parts: string[] = [];
    let cur = inodeId;
    for (let i = 0; i < 64; i++) {
      if (cur === 1) break;
      const entries = this.dirs.get(cur) ?? [];
      const upEntry = entries.find(e => e.name === '..');
      const upId    = upEntry ? upEntry.inode : 1;
      const upDirs  = this.dirs.get(upId) ?? [];
      const myEntry = upDirs.find(e => e.inode === cur && e.name !== '.' && e.name !== '..');
      if (myEntry) parts.unshift(myEntry.name);
      cur = upId;
    }
    return '/' + parts.join('/');
  }

  getInodeType(id: number): 'file' | 'dir' | undefined {
    return this.inodes.get(id)?.type;
  }

  private allocInode(): number {
    if (this.inodes.size >= MAX_INODES) throw new KernelError(ENOSPC);
    while (this.inodes.has(this.seq)) this.seq++;
    const id = this.seq++;
    return id;
  }

  private getInode(id: number): Inode {
    const inode = this.inodes.get(id);
    if (!inode) throw new KernelError(ENOENT);
    return inode;
  }

  private getFd(fd: number, pid: number): FileDescriptor & { pid: number } {
    const desc = this.fdTable.get(fd);
    if (!desc) throw new KernelError(EBADF);
    if (pid !== 0 && desc.pid !== pid) throw new KernelError(EBADF);
    return desc;
  }

  private resolve(path: string, cwd: number): Inode | undefined {
    return this.resolveFull(path, cwd) ?? undefined;
  }

  private resolveFull(path: string, cwd: number): Inode | undefined {
    const parts = splitPath(path);
    let cur = path.startsWith('/') ? 1 : cwd;
    for (const part of parts) {
      if (part === '' || part === '.') continue;
      if (part === '..') {
        const entries = this.dirs.get(cur) ?? [];
        const up = entries.find(e => e.name === '..');
        cur = up ? up.inode : cur;
        continue;
      }
      const entries = this.dirs.get(cur) ?? [];
      const entry = entries.find(e => e.name === part);
      if (!entry) return undefined;
      cur = entry.inode;
    }
    return this.inodes.get(cur);
  }

  private parentDir(path: string, cwd: number): DirEntry[] {
    const parts  = splitPath(path);
    const isAbs  = path.startsWith('/');
    const parentParts = parts.slice(0, -1);
    const parentPath = isAbs
      ? ('/' + parentParts.join('/'))
      : (parentParts.join('/') || '.');
    const inode = this.resolveFull(parentPath, cwd);
    if (!inode || inode.type !== 'dir') throw new KernelError(ENOTDIR);
    return this.dirs.get(inode.id) ?? [];
  }

  private persist(): void {
    const snap: FsSnapshot = {
      inodes: Array.from(this.inodes.entries()),
      dirs:   Array.from(this.dirs.entries()),
      seq:    this.seq,
    };
    try { localStorage.setItem(LS_KEY, JSON.stringify(snap)); } catch { /* quota */ }
  }
}
