import * as vscode from 'vscode'
import * as path from 'path'
import type { BranchCompareProvider } from './extension'
import { EMPTY_SCHEME, errorMessage, statusLetter } from './extension'
import { Change, Commit } from './git'

// 한 번에 가져올 커밋 수. 오래 갈라진 브랜치에서 트리가 지나치게 길어지지 않도록 자른다.
const MAX_COMMITS = 200

type HistoryNode = SideNode | CommitNode | CommitFileNode | MessageNode

// "오른쪽에만 있는 커밋" / "왼쪽에만 있는 커밋" 묶음
class SideNode {
  constructor(
    readonly label: string,
    readonly range: string,
    readonly commits: Commit[],
    readonly expanded: boolean,
  ) {}
}

class CommitNode {
  constructor(readonly commit: Commit) {}
}

class CommitFileNode {
  constructor(
    readonly commit: Commit,
    readonly change: Change,
  ) {}
}

class MessageNode {
  constructor(readonly message: string) {}
}

function shortHash(hash: string): string {
  return hash.slice(0, 7)
}

function relativeDate(date: Date | undefined): string {
  if (!date) return ''
  const minutes = Math.round((Date.now() - date.getTime()) / 60000)
  if (minutes < 1) return '방금'
  if (minutes < 60) return `${minutes}분 전`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}시간 전`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}일 전`
  return date.toLocaleDateString('ko-KR')
}

// 두 브랜치 사이에서 한쪽에만 있는 커밋을 보여준다. 커밋을 펼치면 그 커밋이 바꾼 파일이 나온다.
export class CommitHistoryProvider implements vscode.TreeDataProvider<HistoryNode> {
  private readonly changeEmitter = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.changeEmitter.event

  sides: SideNode[] = []

  // 오른쪽에만 있는 커밋 수, 왼쪽에만 있는 커밋 수. 아직 계산 전이면 undefined.
  get counts(): { incoming: number; outgoing: number } | undefined {
    if (this.sides.length !== 2) return undefined
    return { incoming: this.sides[0].commits.length, outgoing: this.sides[1].commits.length }
  }
  error: string | undefined

  constructor(private readonly provider: BranchCompareProvider) {
    provider.onDidRefresh(() => this.reload())
  }

  async reload() {
    const repository = await this.provider.getRepository(false)
    const base = this.provider.base
    const compare = this.provider.compare
    this.sides = []
    this.error = undefined

    if (repository && base && compare) {
      try {
        const [incoming, outgoing] = await Promise.all([
          repository.log({ range: `${base}..${compare}`, maxEntries: MAX_COMMITS }),
          repository.log({ range: `${compare}..${base}`, maxEntries: MAX_COMMITS }),
        ])
        this.sides = [
          new SideNode(`오른쪽(${compare})에만 있는 커밋 · 병합하면 들어옴`, `${base}..${compare}`, incoming, true),
          new SideNode(`왼쪽(${base})에만 있는 커밋`, `${compare}..${base}`, outgoing, outgoing.length <= 20),
        ]
      } catch (error) {
        this.error = `히스토리를 불러오지 못했습니다: ${errorMessage(error)}`
      }
    }
    this.changeEmitter.fire()
  }

  getTreeItem(node: HistoryNode): vscode.TreeItem {
    if (node instanceof MessageNode) {
      return new vscode.TreeItem(node.message, vscode.TreeItemCollapsibleState.None)
    }

    if (node instanceof SideNode) {
      const count = node.commits.length >= MAX_COMMITS ? `${MAX_COMMITS}+` : String(node.commits.length)
      const state =
        node.commits.length === 0
          ? vscode.TreeItemCollapsibleState.None
          : node.expanded
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed
      const item = new vscode.TreeItem(node.label, state)
      item.description = `${count}개`
      item.tooltip = `git log ${node.range}`
      item.iconPath = new vscode.ThemeIcon('git-branch')
      return item
    }

    if (node instanceof CommitNode) {
      const commit = node.commit
      const [subject] = commit.message.split('\n')
      const item = new vscode.TreeItem(subject, vscode.TreeItemCollapsibleState.Collapsed)
      item.description = [shortHash(commit.hash), commit.authorName, relativeDate(commit.authorDate ?? commit.commitDate)]
        .filter(Boolean)
        .join(' · ')
      const tooltip = new vscode.MarkdownString()
      tooltip.appendCodeblock(commit.message.trim(), 'text')
      tooltip.appendMarkdown(
        `\n\`${commit.hash}\`  \n${commit.authorName ?? ''} ${commit.authorEmail ? `<${commit.authorEmail}>` : ''}  \n${commit.authorDate?.toLocaleString('ko-KR') ?? ''}`,
      )
      item.tooltip = tooltip
      item.iconPath = new vscode.ThemeIcon(commit.parents.length > 1 ? 'git-merge' : 'git-commit')
      return item
    }

    const uri = node.change.uri
    const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None)
    const repository = this.provider.repositories.find((candidate) => uri.fsPath.startsWith(candidate.rootUri.fsPath))
    const relativeDirectory = repository ? path.relative(repository.rootUri.fsPath, path.dirname(uri.fsPath)) : ''
    const letter = statusLetter(node.change.status)
    item.description = relativeDirectory ? `${letter} · ${relativeDirectory}` : letter
    item.command = { command: 'branchCompare.openCommitDiff', title: '커밋 diff 열기', arguments: [node] }
    return item
  }

  async getChildren(node?: HistoryNode): Promise<HistoryNode[]> {
    if (!node) {
      if (this.error) return [new MessageNode(this.error)]
      return this.sides
    }
    if (node instanceof SideNode) return node.commits.map((commit) => new CommitNode(commit))
    if (node instanceof CommitNode) return this.commitFiles(node.commit)
    return []
  }

  private async commitFiles(commit: Commit): Promise<HistoryNode[]> {
    const repository = await this.provider.getRepository(false)
    if (!repository) return []
    if (commit.parents.length === 0) return [new MessageNode('최초 커밋은 변경 파일 목록을 지원하지 않습니다.')]
    try {
      // 병합 커밋은 첫 번째 부모 기준으로 보여준다(병합으로 들어온 변경 전체).
      const changes = await repository.diffBetween(commit.parents[0], commit.hash)
      if (changes.length === 0) return [new MessageNode('변경 파일 없음')]
      return changes.map((change) => new CommitFileNode(commit, change))
    } catch (error) {
      return [new MessageNode(`변경 파일을 불러오지 못했습니다: ${errorMessage(error)}`)]
    }
  }

  diffUris(node: CommitFileNode): [vscode.Uri, vscode.Uri] {
    const letter = statusLetter(node.change.status)
    const emptyUri = vscode.Uri.from({ scheme: EMPTY_SCHEME, path: node.change.uri.path })
    const parent = node.commit.parents[0]
    const left = letter === 'A' ? emptyUri : this.provider.git.toGitUri(node.change.originalUri, parent)
    const right = letter === 'D' ? emptyUri : this.provider.git.toGitUri(node.change.uri, node.commit.hash)
    return [left, right]
  }

  async openDiff(node: CommitFileNode) {
    const [left, right] = this.diffUris(node)
    const name = path.basename(node.change.uri.fsPath)
    await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (${shortHash(node.commit.hash)})`)
  }
}
