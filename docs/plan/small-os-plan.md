# small OS — 実行企画書

## 1. 開発言語

### メイン言語

| 言語 | 用途 | 選定理由 |
|------|------|----------|
| **TypeScript** | コアロジック全般 | 型安全性により OS 内部構造（プロセス管理・ファイルシステム等）を明確にモデル化できる |
| **HTML5** | 端末 UI のマークアップ | ブラウザーネイティブ、追加ライブラリ不要 |
| **CSS3** | 端末スタイリング | ターミナル風 UI の再現（黒背景・等幅フォント等） |

### ビルド・ツールチェーン

| ツール | バージョン | 用途 |
|--------|-----------|------|
| Node.js | 20 LTS | ビルド・開発サーバー実行 |
| Vite | 5.x | バンドラー・HMR 付き開発サーバー（Worker ビルド対応） |
| TypeScript | 5.x | トランスパイル・型チェック |
| Vitest | 1.x | ユニットテスト |

### 設計方針（確定）

| 項目 | 決定内容 |
|------|---------|
| **カーネル構造** | モノリシックカーネル |
| **非同期モデル** | async / await（システムコールはすべて非同期） |
| **プロセス並行** | Web Worker — 各プロセスを独立 Worker で実行（協調方式：Worker が yield を通知） |
| **仮想メモリ** | 64 KB、ページサイズ 4 KB（16 ページ）、スワップなし |
| **ファイルシステム** | inode 上限 1,000、localStorage で永続化 |
| **シェル** | パイプ（`\|`）・リダイレクト（`>`）を初版からサポート |
| **エラー処理** | Linux ライクなメッセージ、カーネルパニック時もエラー表示して継続 |

---

## 2. 開発環境

### 必要ソフトウェア

```
Node.js 20 LTS 以上
npm 10 以上（Node.js に同梱）
VS Code（推奨エディター）
Git
```

### VS Code 推奨拡張機能

- **ESLint** — コード品質チェック
- **Prettier** — コードフォーマット
- **TypeScript Vue Plugin** または **volar**（将来的に UI を切り出す場合）
- **vitest** — テストランナー統合

### プロジェクト初期セットアップ

```bash
# リポジトリ作成
mkdir small-os && cd small-os
git init

# Vite + TypeScript プロジェクト初期化
npm create vite@latest . -- --template vanilla-ts

# 依存関係インストール
npm install

# テストフレームワーク追加
npm install -D vitest

# 開発サーバー起動確認
npm run dev
# → http://localhost:5173 で動作確認
```

### ディレクトリ構成

```
small-os/
├── index.html              # エントリーポイント
├── src/
│   ├── main.ts             # アプリ起動・カーネル boot
│   ├── terminal/
│   │   ├── Terminal.ts     # 端末 UI 制御
│   │   └── terminal.css    # ターミナルスタイル
│   ├── shell/
│   │   ├── Shell.ts        # コマンドパーサー・パイプ・リダイレクト処理
│   │   ├── Pipeline.ts     # パイプライン実行エンジン
│   │   └── commands/       # コマンド実装（1コマンド1ファイル）
│   │       ├── ls.ts
│   │       ├── cd.ts
│   │       ├── mkdir.ts
│   │       └── ...
│   ├── kernel/
│   │   ├── index.ts        # Kernel クラス・boot シーケンス
│   │   ├── Syscall.ts      # システムコール層（非同期）
│   │   ├── Scheduler.ts    # プロセス管理・Worker ベーススケジューラー
│   │   ├── MemoryManager.ts# 64KB / 4KB ページ管理
│   │   ├── FileSystem.ts   # inode ベース VFS（localStorage 永続化）
│   │   ├── InterruptController.ts
│   │   └── KernelError.ts  # エラー定義・パニックハンドラー
│   ├── workers/
│   │   └── process.worker.ts  # プロセス実行用 Web Worker
│   └── types/
│       └── index.ts        # 共通型定義
├── tests/
│   ├── shell.test.ts
│   ├── pipeline.test.ts
│   ├── filesystem.test.ts
│   └── scheduler.test.ts
├── package.json
├── tsconfig.json
└── vite.config.ts          # Worker プラグイン設定込み
```

---

## 3. 開発手順

### フェーズ 1：ターミナル UI の構築（1〜2日）

**目標**: キーボード入力を受け取り、テキストを表示できるターミナル画面を作る

1. `index.html` に `<div id="terminal">` を配置
2. CSS でターミナル風スタイルを適用（黒背景・緑文字・等幅フォント）
3. `Terminal.ts` を実装
   - 入力フィールドの制御（Enter で確定、↑↓ でヒストリー参照）
   - 出力行の追加・スクロール
4. `$ ` プロンプトを表示し、入力した文字列をそのまま出力できることを確認

```
$ hello world
hello world
$
```

---

### フェーズ 2：シェルとコマンドパーサーの実装（3〜4日）

**目標**: コマンド名と引数を解析し、パイプ・リダイレクトを含む処理を実行する

1. `Shell.ts` に入力文字列のパース処理を実装
   - `"ls -la /home"` → `{ cmd: "ls", args: ["-la", "/home"] }`
2. コマンドレジストリ（Map）を作成し、コマンド名 → 関数をマッピング
3. 基本コマンドを実装：`help`, `echo`, `clear`
4. `Pipeline.ts` でパイプ（`|`）・リダイレクト（`>`）を実装
   - `"ls | grep txt"` → ls の stdout を grep の stdin に接続
   - `"echo hello > out.txt"` → stdout をファイルに書き込み
5. 不明コマンドのエラーハンドリング（Linux ライク）

```
$ echo Hello, OS!
Hello, OS!
$ unknown
small-os: unknown: command not found
$ ls | grep .txt
readme.txt
$ echo hello > out.txt
$ cat out.txt
hello
```

---

### フェーズ 3：仮想ファイルシステムの実装（3〜4日）

**目標**: inode ベースの VFS をメモリ上に構築し、localStorage で永続化する

仕様：inode 上限 1,000、ページリロード後もデータが残る

1. `FileSystem.ts` に inode 型を定義

```typescript
interface Inode {
  id:       number;   // 1〜1000
  type:     "file" | "dir";
  size:     number;
  created:  number;
  modified: number;
  data:     string;
}
```

2. ルート inode（id=1）を初期化し、カレントパスを管理
3. ファイルシステムコマンドを実装：`ls`, `cd`, `mkdir`, `touch`, `cat`, `rm`
4. パス解決（絶対パス・相対パス・`..` の処理）
5. `localStorage` への自動保存と起動時の復元

```
$ mkdir home
$ cd home
$ touch memo.txt
$ ls
memo.txt
$ cat memo.txt
(空)
# → ページリロード後も memo.txt が残っている
```

---

### フェーズ 4：プロセス管理と Web Worker 並行実行（3〜4日）

**目標**: 各プロセスを独立した Web Worker で動かし、本物の並行実行を実現する

1. `process.worker.ts` を実装
   - Worker 内でプロセスのコードを実行
   - メインスレッドとは `postMessage` / `onmessage` で通信
2. `Scheduler.ts` で PCB と Worker インスタンスを対応付けて管理
3. タイムスライス（100ms）超過時に Worker を suspend / resume
4. `ps`, `kill` コマンドを実装

```typescript
interface PCB {
  pid:     number;
  ppid:    number;
  name:    string;
  state:   "running" | "ready" | "waiting" | "zombie";
  worker:  Worker;        // 実 Worker インスタンス
  memory:  MemorySegment;
  cpuTime: number;
}
```

```
$ ps
PID  NAME    STATUS   CPU    STARTED
1    init    running  0.0%   10:00:00
2    shell   running  0.1%   10:00:00
$ kill 1
kill: (1) - Operation not permitted
```

---

### フェーズ 5：統合・品質向上（2〜3日）

**目標**: 全モジュールを繋ぎ、エラー処理・テスト・UX を整える

1. `KernelError.ts` でエラー体系を整備

```typescript
// Linux ライクなエラーメッセージ書式
// <command>: <target>: <message>
// 例:
//   rm: /home/foo.txt: No such file or directory
//   mkdir: /home: File exists
//   kill: (99) - No such process
```

2. カーネルパニック時はエラーを表示して継続（プロセスを zombie にして復帰）
3. 全コマンドの結合テストを Vitest で作成（パイプ・リダイレクト含む）
4. コマンド補完（Tab キー）の実装（オプション）
5. README / 概要ドキュメントの整備

---

### 開発スケジュール（目安）

```
Week 1:  フェーズ1（UI） + フェーズ2（シェル・パイプ）
Week 2:  フェーズ3（ファイルシステム・永続化）
Week 3:  フェーズ4（Worker ベースプロセス管理）
Week 4:  フェーズ5（統合・エラー処理・テスト）
```

---

### 主要コマンド一覧

```bash
npm run dev       # 開発サーバー起動（ホットリロード付き）
npm run build     # 本番ビルド（dist/ に出力）
npm run test      # ユニットテスト実行
npm run typecheck # 型チェックのみ実行
npm run preview   # ビルド結果をローカルでプレビュー
```
