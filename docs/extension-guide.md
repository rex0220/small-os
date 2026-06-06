# small OS — 拡張ガイド

## このガイドの使い方

small OS に新しい機能を追加する際の手順書です。
「コマンド追加」「Syscall 追加」「FS 機能拡張」の3パターンを説明します。

---

## 重要：SysHelper 経由のアクセス

コマンドはカーネルに直接アクセスせず、必ず `SysHelper`（`sys`）経由で `SYS.XXX` を呼びます。
これがユーザー空間とカーネル空間の境界です。

```typescript
// NG: カーネルを直接呼ぶ（仕様違反）
const fd = await kernel.fs.open(path, OpenFlag.READ, cwd);

// OK: SysHelper 経由（正しい使い方）
const fd = await sys.call(SYS.OPEN, path, OpenFlag.READ) as number;
```

`sys.call()` は失敗時に `KernelError` を throw するので、コマンド側で try/catch は不要です。
エラーは Pipeline が受け取ってターミナルに表示します。

---

## パターン A：コマンドを追加する

`src/shell/commands/index.ts` に追加するだけ。

### CmdFn の型

```typescript
type CmdFn = (
  args:  string[],   // コマンドライン引数
  stdin: string,     // パイプで渡された前段の出力
  sys:   SysHelper,  // Syscall 経由のカーネルアクセス
  term:  Terminal,   // 端末（clear 等の直接操作用）
) => Promise<string>;  // stdout として返す
```

### テンプレート集

#### ファイルを読むコマンド

```typescript
commands.set('mycat', async (args, _stdin, sys) => {
  if (!args[0]) throw new Error('mycat: missing operand');
  const fd   = await sys.call(SYS.OPEN, args[0], OpenFlag.READ) as number;
  const data = await sys.call(SYS.READ, fd) as string;
  await sys.call(SYS.CLOSE, fd);
  return data;
});
```

#### ファイルを書くコマンド

```typescript
commands.set('mywrite', async (args, stdin, sys) => {
  if (!args[0]) throw new Error('mywrite: missing operand');
  const fd = await sys.call(SYS.OPEN, args[0], OpenFlag.WRITE) as number;
  await sys.call(SYS.WRITE, fd, stdin);
  await sys.call(SYS.CLOSE, fd);
  return '';
});
```

#### ディレクトリ一覧を使うコマンド

```typescript
commands.set('myls', async (args, _stdin, sys) => {
  const path    = args[0] ?? '.';
  const entries = await sys.call(SYS.READDIR, path) as DirEntry[];
  return entries
    .filter(e => e.name !== '.' && e.name !== '..')
    .map(e => e.name)
    .join('\n');
});
```

#### プロセス一覧を使うコマンド

```typescript
commands.set('myps', async (_args, _stdin, sys) => {
  type PsRow = { pid: number; name: string; state: string };
  const list = await sys.call(SYS.PS) as PsRow[];
  return list.map(p => p.pid + '\t' + p.name + '\t' + p.state).join('\n');
});
```

#### メモリ情報を使うコマンド

```typescript
commands.set('mymem', async (_args, _stdin, sys) => {
  const info = await sys.call(SYS.MEMINFO) as { used: number; total: number };
  return 'used: ' + info.used + 'B / total: ' + info.total + 'B';
});
```

### 必要な import

```typescript
import { SYS }      from '../../kernel/Syscall';
import { OpenFlag } from '../../types';
import type { SysHelper, DirEntry } from '../../types';
```

---

## パターン B：Syscall を追加する

カーネルに新しい機能を公開するときに使います。

### 手順

**1. `src/kernel/Syscall.ts` に番号を追加**

```typescript
export enum SYS {
  // ... 既存 ...
  MY_NEW_CALL = 16,
}
```

**2. `dispatch()` に処理を追加**

```typescript
case SYS.MY_NEW_CALL:
  return await this.fs.myNewMethod(args[0] as string, cwd);
```

**3. カーネル側に実装を追加（例: FileSystem）**

```typescript
// FileSystem.ts に追加
async myNewMethod(arg: string, cwd = 1): Promise<string> {
  // 実装（cwd を受け取る形にする）
  return result;
}
```

**4. コマンドから呼ぶ**

```typescript
const result = await sys.call(SYS.MY_NEW_CALL, arg) as string;
```

---

## パターン C：ファイルシステムを拡張する

`src/kernel/FileSystem.ts` を直接拡張します。

### inode にフィールドを追加する

**1. `src/types/index.ts` の `Inode` に追加**

```typescript
export interface Inode {
  // ... 既存フィールド ...
  permissions: number;  // 追加
}
```

**2. FileSystem の init() で初期値を設定**

```typescript
this.inodes.set(1, {
  id: 1, type: 'dir', size: 0,
  created: now, modified: now, data: '', nlink: 2,
  permissions: 0o755,  // 追加
});
```

**3. localStorage のキーをバージョンアップ**

```typescript
const LS_KEY = 'small-os-fs-v2';  // v1 → v2
```

### 新しいファイル操作を追加する（例: rename）

`FileSystem.ts` に追加後、`Syscall.ts` で番号を割り当てます。

```typescript
// FileSystem.ts
async rename(oldPath: string, newPath: string, cwd = 1): Promise<void> {
  const inode = this.resolve(oldPath, cwd);
  if (!inode) throw new KernelError(ENOENT, oldPath);
  if (this.resolve(newPath, cwd)) throw new KernelError(EEXIST, newPath);

  const oldParent = this.parentDir(oldPath, cwd);
  const idx = oldParent.findIndex(e => e.name === basename(oldPath));
  if (idx !== -1) oldParent.splice(idx, 1);

  const newParent = this.parentDir(newPath, cwd);
  newParent.push({ name: basename(newPath), inode: inode.id });

  this.persist();
}
```

---

## よくある拡張例：実装ガイド

### `wc` コマンド（行数・単語数・文字数）

```typescript
commands.set('wc', async (args, stdin, sys) => {
  let text = stdin;
  let filename = '';

  if (args[0]) {
    filename = args[0];
    const fd = await sys.call(SYS.OPEN, filename, OpenFlag.READ) as number;
    text = await sys.call(SYS.READ, fd) as string;
    await sys.call(SYS.CLOSE, fd);
  }

  const lines = text.split('\n').length - 1;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const chars = text.length;
  const label = filename ? ' ' + filename : '';
  return String(lines).padStart(4) + ' ' + String(words).padStart(4) + ' ' + String(chars).padStart(4) + label;
});
```

### `grep` コマンド（文字列検索）

```typescript
commands.set('grep', async (args, stdin, sys) => {
  const pattern = args[0];
  if (!pattern) throw new Error('grep: missing pattern');

  let text = stdin;
  if (args[1]) {
    const fd = await sys.call(SYS.OPEN, args[1], OpenFlag.READ) as number;
    text = await sys.call(SYS.READ, fd) as string;
    await sys.call(SYS.CLOSE, fd);
  }

  return text.split('\n').filter(line => new RegExp(pattern).test(line)).join('\n');
});
```

### `date` コマンド

```typescript
commands.set('date', async () => {
  return new Date().toLocaleString('ja-JP');
});
```

### `uptime` コマンド（SYS.UPTIME を追加する例）

uptime は「カーネルの起動時刻」が必要です。カーネルへのアクセスは必ず Syscall 経由なので、新しい SYS 番号を追加します。

**1. `Syscall.ts` に番号を追加**

```typescript
export enum SYS {
  // ... 既存 ...
  UPTIME = 16,
}
```

**2. `dispatch()` に処理を追加**

```typescript
case SYS.UPTIME: return Date.now() - this.bootTime;
```

`this.bootTime` を参照するため、`Syscall` コンストラクターに `bootTime: number` を追加するか、`Kernel` クラスから `bootTime` を Syscall に渡します。

**3. コマンドから呼ぶ**

```typescript
commands.set('uptime', async (_args, _stdin, sys) => {
  const elapsed = await sys.call(SYS.UPTIME) as number;
  const sec  = Math.floor(elapsed / 1000);
  const min  = Math.floor(sec / 60);
  const hour = Math.floor(min / 60);
  return 'up ' + hour + 'h ' + (min % 60) + 'm ' + (sec % 60) + 's';
});
```

この手順が「Syscall を追加する」パターン B の典型例です。

### `istat` コマンド（inode デバッグ）

```typescript
commands.set('istat', async (args, _stdin, sys) => {
  if (!args[0]) throw new Error('istat: missing operand');
  const inode = await sys.call(SYS.STAT, args[0]) as Inode;
  return [
    'inode:    ' + inode.id,
    'type:     ' + inode.type,
    'size:     ' + inode.size,
    'links:    ' + inode.nlink,
    'created:  ' + new Date(inode.created).toLocaleString(),
    'modified: ' + new Date(inode.modified).toLocaleString(),
  ].join('\n');
});
```

---

## 拡張時のチェックリスト

- [ ] `help` コマンドの一覧に追記したか？
- [ ] カーネルアクセスはすべて `sys.call(SYS.XXX, ...)` 経由か？（直接 `kernel.fs` を呼んでいないか）
- [ ] 新しい Inode フィールドを追加した場合、`LS_KEY` をバージョンアップしたか？
- [ ] パイプ経由で使えるか確認したか？（`stdin` を考慮しているか）
- [ ] `npx tsc --noEmit` で型エラーが出ないことを確認したか？
