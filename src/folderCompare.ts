import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import type { BranchCompareProvider } from './extension'
import { EMPTY_SCHEME, errorMessage } from './extension'
import { runGit } from './directDiff'
import { confirmAndApply, notifyApplied } from './workingTreeSync'
import { Repository } from './git'

// 한쪽 브랜치에서 본 파일 정보. blob 해시가 같으면 내용이 같다.
interface SideFile {
  blob: string
  size: number
}

interface Entry {
  path: string
  left?: SideFile
  right?: SideFile
}

type Side = 'left' | 'right'

// 웹뷰 → 확장으로 오는 메시지
type IncomingMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'swap' }
  | { type: 'openDiff'; path: string }
  | { type: 'import'; from: Side; paths: string[] }
  | { type: 'remove'; from: Side; paths: string[] }
  | { type: 'mirror'; from: Side; importPaths: string[]; removePaths: string[] }
  | { type: 'copyPath'; path: string }


// 'git ls-tree -r -l -z' 출력: "<mode> <type> <object> <size>\t<path>\0"
function parseLsTree(output: string): Map<string, SideFile> {
  const files = new Map<string, SideFile>()
  for (const record of output.split('\0')) {
    if (!record) continue
    const tab = record.indexOf('\t')
    if (tab < 0) continue
    const [, type, blob, size] = record.slice(0, tab).split(/\s+/)
    if (type !== 'blob') continue
    files.set(record.slice(tab + 1), { blob, size: Number(size) || 0 })
  }
  return files
}

// 두 브랜치의 파일 트리를 좌우로 맞춰 보여주는 편집기 영역 패널(폴더 비교).
export class FolderComparePanel {
  private static current: FolderComparePanel | undefined

  private entries: Entry[] = []
  // 이번 세션에서 작업 트리로 가져온 파일. 브랜치 끝 기준 비교라 목록에서는 계속 "다름"으로 보이므로 따로 표시한다.
  private readonly imported = new Set<string>()
  // 이번 세션에서 작업 트리에서 지운 파일(받는 쪽에만 있던 파일)
  private readonly removed = new Set<string>()
  private readonly disposables: vscode.Disposable[] = []

  static show(provider: BranchCompareProvider, extensionUri: vscode.Uri) {
    if (FolderComparePanel.current) {
      FolderComparePanel.current.panel.reveal()
      FolderComparePanel.current.reload()
      return
    }
    const panel = vscode.window.createWebviewPanel('branchCompare.folder', '폴더 비교', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    })
    FolderComparePanel.current = new FolderComparePanel(panel, provider, extensionUri)
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly provider: BranchCompareProvider,
    private readonly extensionUri: vscode.Uri,
  ) {
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'branch-compare.svg')
    panel.webview.html = this.html()
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: IncomingMessage) => this.handle(message)),
      // 사이드바에서 브랜치나 저장소를 바꾸면 따라간다.
      provider.onDidRefresh(() => this.reload()),
    )
    panel.onDidDispose(() => this.dispose(), null, this.disposables)
  }

  private dispose() {
    FolderComparePanel.current = undefined
    for (const disposable of this.disposables) disposable.dispose()
  }

  private async handle(message: IncomingMessage) {
    switch (message.type) {
      case 'ready':
      case 'refresh':
        await this.reload()
        return
      case 'swap':
        await this.provider.setBranches(this.provider.compare, this.provider.base)
        return
      case 'openDiff':
        await this.openDiff(message.path)
        return
      case 'import':
        await this.applyChanges(message.from, message.paths, [])
        return
      case 'remove':
        await this.applyChanges(message.from, [], message.paths)
        return
      case 'mirror':
        await this.applyChanges(message.from, message.importPaths, message.removePaths)
        return
      case 'copyPath':
        await vscode.env.clipboard.writeText(message.path)
        return
    }
  }

  private async reload() {
    const repository = await this.provider.getRepository(false)
    const left = this.provider.base
    const right = this.provider.compare
    if (!repository || !left || !right) {
      this.panel.title = '폴더 비교'
      await this.panel.webview.postMessage({ type: 'empty', message: '사이드바의 브랜치 선택 패널에서 저장소와 좌우 브랜치를 먼저 고르세요.' })
      return
    }

    this.panel.title = `폴더 비교: ${left} ↔ ${right}`
    await this.panel.webview.postMessage({ type: 'loading' })
    try {
      const gitPath = this.provider.git.git.path
      const root = repository.rootUri.fsPath
      const [leftOutput, rightOutput] = await Promise.all([
        runGit(gitPath, root, ['ls-tree', '-r', '-l', '-z', left]),
        runGit(gitPath, root, ['ls-tree', '-r', '-l', '-z', right]),
      ])
      const leftFiles = parseLsTree(leftOutput)
      const rightFiles = parseLsTree(rightOutput)
      const paths = new Set([...leftFiles.keys(), ...rightFiles.keys()])
      this.entries = [...paths].map((filePath) => ({
        path: filePath,
        left: leftFiles.get(filePath),
        right: rightFiles.get(filePath),
      }))
      await this.postData(repository, left, right)
    } catch (error) {
      await this.panel.webview.postMessage({ type: 'empty', message: `파일 목록을 읽지 못했습니다: ${errorMessage(error)}` })
    }
  }

  private async postData(repository: Repository, left: string, right: string) {
    const headName = repository.state.HEAD?.name
    await this.panel.webview.postMessage({
      type: 'data',
      repositoryName: path.basename(repository.rootUri.fsPath),
      left: { name: left, isHead: left === headName },
      right: { name: right, isHead: right === headName },
      entries: this.entries,
      imported: [...this.imported],
      removed: [...this.removed],
    })
  }

  private async openDiff(filePath: string) {
    const repository = await this.provider.getRepository(false)
    const entry = this.entries.find((candidate) => candidate.path === filePath)
    const left = this.provider.base
    const right = this.provider.compare
    if (!repository || !entry || !left || !right) return

    const fileUri = vscode.Uri.file(path.join(repository.rootUri.fsPath, filePath))
    const emptyUri = vscode.Uri.from({ scheme: EMPTY_SCHEME, path: fileUri.path })
    const leftUri = entry.left ? this.provider.git.toGitUri(fileUri, left) : emptyUri
    const rightUri = entry.right ? this.provider.git.toGitUri(fileUri, right) : emptyUri
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `${path.basename(filePath)} (${left} ↔ ${right})`)
  }

  // 받는 쪽(체크아웃된 브랜치)의 작업 트리를 원본 쪽에 맞춘다.
  // - importPaths: 원본 쪽 버전으로 덮어쓰기(git checkout <원본> -- <경로>)
  // - removePaths: 원본 쪽에 없는 파일 지우기(git rm)
  // 작업 트리는 체크아웃된 브랜치의 것이므로, 받는 쪽이 현재 브랜치일 때만 허용한다.
  private async applyChanges(from: Side, requestedImports: string[], requestedRemovals: string[]) {
    const repository = await this.provider.getRepository(false)
    const left = this.provider.base
    const right = this.provider.compare
    if (!repository || !left || !right) return

    const sourceRef = from === 'left' ? left : right
    const targetRef = from === 'left' ? right : left
    if (repository.state.HEAD?.name !== targetRef) {
      vscode.window.showWarningMessage(
        `가져오기·삭제는 체크아웃된 브랜치 쪽으로만 할 수 있습니다. 먼저 ${targetRef} 브랜치를 체크아웃하세요.`,
      )
      return
    }

    const entriesByPath = new Map(this.entries.map((entry) => [entry.path, entry]))
    const sideFiles = (filePath: string) => {
      const entry = entriesByPath.get(filePath)
      return { source: from === 'left' ? entry?.left : entry?.right, target: from === 'left' ? entry?.right : entry?.left }
    }
    // 원본 쪽에 있고 내용이 다른 파일만 가져오고, 받는 쪽에만 있는 파일만 지운다.
    const root = repository.rootUri.fsPath
    let imports = requestedImports.filter((filePath) => {
      const { source, target } = sideFiles(filePath)
      return source && source.blob !== target?.blob
    })
    // 이미 지운 파일은 다시 지우지 않는다.
    const removals = requestedRemovals.filter((filePath) => {
      const { source, target } = sideFiles(filePath)
      return target && !source && !(this.removed.has(filePath) && !fs.existsSync(path.join(root, filePath)))
    })
    // 이미 가져와서 작업 트리 내용이 원본과 같은 파일은 건너뛴다(가져온 뒤 고친 파일은 남긴다).
    const alreadyImported = imports.filter((filePath) => this.imported.has(filePath) && fs.existsSync(path.join(root, filePath)))
    if (alreadyImported.length > 0) {
      const hashes = (await runGit(this.provider.git.git.path, root, ['hash-object', '--', ...alreadyImported])).trim().split('\n')
      const inSync = new Set(alreadyImported.filter((filePath, index) => hashes[index] === sideFiles(filePath).source?.blob))
      imports = imports.filter((filePath) => !inSync.has(filePath))
    }
    if (imports.length === 0 && removals.length === 0) {
      vscode.window.showInformationMessage('바꿀 파일이 없습니다. (이미 원본과 같습니다)')
      return
    }

    const applied = await confirmAndApply({
      repository,
      gitPath: this.provider.git.git.path,
      sourceRef,
      imports,
      removals,
    })
    if (!applied) return

    for (const filePath of imports) {
      this.imported.add(filePath)
      this.removed.delete(filePath)
    }
    for (const filePath of removals) {
      this.removed.add(filePath)
      this.imported.delete(filePath)
    }
    await this.postData(repository, left, right)
    notifyApplied(sourceRef, imports.length, removals.length)
  }

  private html(): string {
    const webview = this.panel.webview
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('')
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'folderCompare.js'))
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'folderCompare.css'))
    return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div class="toolbar">
    <div class="segmented" id="filters">
      <button data-filter="all">전체</button>
      <button data-filter="diff" class="active">다른 것만</button>
      <button data-filter="same">같은 것</button>
      <button data-filter="orphan">한쪽에만</button>
    </div>
    <input id="search" type="search" placeholder="경로 검색" spellcheck="false">
    <div class="spacer"></div>
    <div class="sync-actions">
      <button id="actImport" disabled><span>가져오기</span></button>
      <button id="actRemove" class="danger" disabled><span>✕ 삭제</span></button>
      <button id="actMirror" disabled><span>⇆ 동기화</span></button>
    </div>
    <div class="divider"></div>
    <button class="icon" id="expandAll" title="모두 펼치기"></button>
    <button class="icon" id="collapseAll" title="모두 접기"></button>
    <button class="icon" id="swap" title="좌우 바꾸기"></button>
    <button class="icon" id="refresh" title="새로고침"></button>
  </div>
  <div class="header">
    <div class="side left" id="leftHeader"></div>
    <div class="gutter"></div>
    <div class="side right" id="rightHeader"></div>
  </div>
  <div class="rows" id="rows" tabindex="0"></div>
  <div class="statusbar" id="statusbar"></div>
  <div class="menu hidden" id="menu"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }
}
