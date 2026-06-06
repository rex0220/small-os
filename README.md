# small OS

ブラウザで動く OS シミュレーター。TypeScript + Vite 実装。

プロセス管理・ファイルシステム・メモリ管理・システムコールなど OS の基本概念をインストール不要で体験できます。

## 起動方法

```bash
git clone https://github.com/rex0220/small-os.git
cd small-os
npm install
npm run dev
```

`http://localhost:5173` をブラウザで開くとターミナルが表示されます。

## 使えるコマンド

| コマンド | 説明 |
|---|---|
| `help` | コマンド一覧 |
| `ls [path]` | ディレクトリ一覧 |
| `cd <path>` | ディレクトリ移動 |
| `mkdir <path>` | ディレクトリ作成 |
| `touch <file>` | ファイル作成 |
| `cat <file>` | ファイル内容を表示 |
| `echo <text>` | テキスト出力 |
| `rm <file>` | ファイル削除 |
| `ps` | プロセス一覧 |
| `kill <pid>` | プロセス終了 |
| `free` | メモリ使用状況 |
| `clear` | 画面クリア |

パイプ・リダイレクトにも対応しています。

```bash
echo "hello" > memo.txt
cat memo.txt | echo
echo "world" >> memo.txt
```

ページリロード後もファイルシステムは localStorage に保持されます。

## アーキテクチャ

```
┌──────────────────────────────────────────┐
│             ユーザー空間                  │
│  Terminal UI  ←→  Shell / コマンド群     │
├──────────────────┬───────────────────────┤
│   カーネル空間    │                       │
│     Syscall.ts  ← ユーザー/カーネル境界   │
│  Scheduler  │  MemoryManager  │  FileSystem │
│  InterruptController (setInterval 10ms)   │
├───────────────────────────────────────────┤
│  setTimeout / setInterval / localStorage  │
└───────────────────────────────────────────┘
```

| 実 OS の概念 | small OS での実装 |
|---|---|
| CPU 特権モード | Syscall.ts による境界 |
| プロセス | Web Worker + PCB |
| コンテキストスイッチ | yield / resume メッセージ |
| ページング | ArrayBuffer 64KB ÷ 4KB ページ |
| ファイルシステム | inode + localStorage |
| タイマー割り込み | setInterval 10ms |

## 技術スタック

- TypeScript 5.5
- Vite 5.4
- Web Workers API（プロセス並行実行）
- localStorage（ファイルシステム永続化）

## ドキュメント

- [仕様書](docs/spec.md)
- [学習プラン](docs/learning-plan.md)
- [チュートリアル（Qiita 記事用）](docs/qiita-tutorial.md)

## ライセンス

MIT
