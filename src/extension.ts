import * as vscode from 'vscode'
import * as path from 'path'
import { API, Change, GitExtension, RefType, Repository, Status } from './git'
import { BranchSelectorView } from './selectorView'
import { CommitHistoryProvider } from './historyView'
import { diffDirect } from './directDiff'
import { FolderComparePanel } from './folderCompare'
import { confirmAndApply, notifyApplied } from './workingTreeSync'

// 추가/삭제된 파일의 반대편(존재하지 않는 쪽)을 빈 문서로 보여주기 위한 스킴
export const EMPTY_SCHEME = 'branch-compare-empty'

const STATE_REPOSITORY = 'branchCompare.repository'
const STATE_BASE = 'branchCompare.base'
const STATE_COMPARE = 'branchCompare.compare'
const STATE_MODE = 'branchCompare.mode'

// direct: 두 브랜치 끝을 그대로 비교(git diff 왼쪽 오른쪽)
// mergeBase: 오른쪽을 왼쪽에 병합하면 들어올 변경만(git diff 왼쪽...오른쪽)
export type CompareMode = 'direct' | 'mergeBase'

type TreeNode = FileNode | ConflictGroupNode

class FileNode {
  constructor(
    readonly change: Change,
    readonly kind: 'diff' | 'conflict',
  ) {}
}

class ConflictGroupNode {
  constructor(readonly conflicts: Change[]) {}
}

export function statusLetter(status: Status): string {
  switch (status) {
    case Status.INDEX_ADDED:
    case Status.UNTRACKED:
    case Status.INTENT_TO_ADD:
      return 'A'
    case Status.INDEX_DELETED:
    case Status.DELETED:
      return 'D'
    case Status.INDEX_RENAMED:
    case Status.INTENT_TO_RENAME:
      return 'R'
    case Status.INDEX_COPIED:
      return 'C'
    case Status.TYPE_CHANGED:
      return 'T'
    default:
      return 'M'
  }
}

export class BranchCompareProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.changeEmitter.event
  // 브랜치 선택 패널이 최신 상태(브랜치·변경 개수)를 다시 그리도록 알린다.
  private readonly refreshEmitter = new vscode.EventEmitter<void>()
  readonly onDidRefresh = this.refreshEmitter.event

  view: vscode.TreeView<TreeNode> | undefined
  // diff 왼쪽에 쓸 리비전. direct 모드면 왼쪽 브랜치, mergeBase 모드면 merge-base 커밋이다.
  leftRef: string | undefined
  changes: Change[] = []
  // 마지막으로 비교한 저장소. 트리 항목의 우클릭 메뉴(가져오기·삭제 가능 여부)를 정할 때 쓴다.
  repository: Repository | undefined

  constructor(
    readonly git: API,
    private readonly context: vscode.ExtensionContext,
  ) {}

  get base(): string | undefined {
    return this.context.workspaceState.get<string>(STATE_BASE)
  }

  get compare(): string | undefined {
    return this.context.workspaceState.get<string>(STATE_COMPARE)
  }

  get mode(): CompareMode {
    return this.context.workspaceState.get<CompareMode>(STATE_MODE) ?? 'direct'
  }

  async setMode(mode: CompareMode) {
    await this.context.workspaceState.update(STATE_MODE, mode)
    await this.refresh()
  }

  async setBranches(base: string | undefined, compare: string | undefined) {
    await this.context.workspaceState.update(STATE_BASE, base)
    await this.context.workspaceState.update(STATE_COMPARE, compare)
    await this.refresh()
  }

  get repositories(): Repository[] {
    return this.git.repositories
  }

  // 저장소가 바뀌면 이전 저장소의 브랜치 선택은 의미가 없으므로 비운다.
  async setRepository(root: string) {
    await this.context.workspaceState.update(STATE_REPOSITORY, root)
    await this.setBranches(undefined, undefined)
  }

  // 저장해 둔 저장소가 없거나 사라졌으면 다시 고른다. 저장소가 하나뿐이면 묻지 않는다.
  async getRepository(askIfAmbiguous: boolean): Promise<Repository | undefined> {
    const repositories = this.git.repositories
    if (repositories.length === 0) return undefined
    if (repositories.length === 1) return repositories[0]

    const savedRoot = this.context.workspaceState.get<string>(STATE_REPOSITORY)
    const saved = repositories.find((repository) => repository.rootUri.fsPath === savedRoot)
    if (saved) return saved
    if (!askIfAmbiguous) return undefined

    const picked = await vscode.window.showQuickPick(
      repositories.map((repository) => ({
        label: path.basename(repository.rootUri.fsPath),
        description: repository.rootUri.fsPath,
        repository,
      })),
      { placeHolder: '비교할 저장소를 선택하세요' },
    )
    if (!picked) return undefined
    await this.setRepository(picked.repository.rootUri.fsPath)
    return picked.repository
  }

  async refresh() {
    const repository = await this.getRepository(false)
    this.repository = repository
    const base = this.base
    const compare = this.compare
    this.changes = []
    this.leftRef = undefined
    const mode = this.mode

    if (this.view) {
      const arrow = mode === 'direct' ? '↔' : '←'
      this.view.description = base && compare ? `${base} ${arrow} ${compare}` : undefined
      this.view.message = undefined
    }

    if (!repository) {
      this.setMessage('git 저장소를 찾지 못했습니다. 저장소가 여러 개면 위 패널에서 저장소를 먼저 고르세요.')
    } else if (!base || !compare) {
      this.setMessage('위 패널에서 왼쪽(기준)과 오른쪽(비교) 브랜치를 선택하세요.')
    } else {
      try {
        if (mode === 'direct') {
          this.leftRef = base
          this.changes = await diffDirect(this.git.git.path, repository.rootUri.fsPath, base, compare)
        } else {
          this.leftRef = await repository.getMergeBase(base, compare)
          this.changes = await repository.diffBetween(base, compare)
        }
        if (this.changes.length === 0 && repository.state.mergeChanges.length === 0) {
          this.setMessage(
            mode === 'direct'
              ? `${base}와 ${compare}의 파일 내용이 같습니다.`
              : `${compare}(오른쪽)의 변경은 이미 ${base}(왼쪽)에 모두 들어 있습니다. 비교 방식을 '직접 비교'로 바꾸면 두 브랜치의 차이를 볼 수 있습니다.`,
          )
        }
      } catch (error) {
        this.setMessage(`비교에 실패했습니다: ${errorMessage(error)}`)
      }
    }
    this.changeEmitter.fire()
    this.refreshEmitter.fire()
  }

  private setMessage(message: string) {
    if (this.view) this.view.message = message
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node instanceof ConflictGroupNode) {
      const item = new vscode.TreeItem(`병합 충돌 (${node.conflicts.length})`, vscode.TreeItemCollapsibleState.Expanded)
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
      item.tooltip = '충돌을 해결하고 저장한 뒤 소스 제어 패널에서 스테이징·커밋하면 병합이 끝납니다.'
      return item
    }

    const uri = node.change.uri
    const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None)
    const repository = this.git.repositories.find((candidate) => uri.fsPath.startsWith(candidate.rootUri.fsPath))
    const relativeDirectory = repository ? path.relative(repository.rootUri.fsPath, path.dirname(uri.fsPath)) : ''

    if (node.kind === 'conflict') {
      item.description = relativeDirectory
      item.command = { command: 'branchCompare.openConflict', title: '병합 편집기로 열기', arguments: [node] }
      return item
    }

    const letter = statusLetter(node.change.status)
    item.description = relativeDirectory ? `${letter} · ${relativeDirectory}` : letter
    if (node.change.status === Status.INDEX_RENAMED) {
      item.tooltip = `${node.change.originalUri.fsPath} → ${uri.fsPath}`
    }
    item.command = { command: 'branchCompare.openDiff', title: 'diff 열기', arguments: [node] }
    // 우클릭 메뉴 표시 조건(package.json의 viewItem)에 쓴다. 예: 'diff:import', 'diff:remove'
    const plan = this.syncPlan(node.change)
    item.contextValue = 'diff' + (plan?.imports.length ? ':import' : '') + (plan?.removals.length ? ':remove' : '')
    return item
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (node instanceof ConflictGroupNode) {
      return node.conflicts.map((change) => new FileNode(change, 'conflict'))
    }
    if (node) return []

    const repository = await this.getRepository(false)
    const roots: TreeNode[] = []
    const conflicts = repository?.state.mergeChanges ?? []
    if (conflicts.length > 0) roots.push(new ConflictGroupNode(conflicts))
    for (const change of this.changes) roots.push(new FileNode(change, 'diff'))
    return roots
  }

  // 체크아웃된 쪽(받는 쪽)의 작업 트리를 반대편에 맞추려면 이 파일에 무엇을 해야 하는지.
  // 좌우 어느 쪽도 체크아웃돼 있지 않으면 작업 트리를 바꿀 수 없으므로 undefined.
  syncPlan(change: Change): { sourceRef: string; imports: string[]; removals: string[] } | undefined {
    const repository = this.repository
    const base = this.base
    const compare = this.compare
    if (!repository || !base || !compare) return undefined
    const headName = repository.state.HEAD?.name
    if (headName !== base && headName !== compare) return undefined

    const root = repository.rootUri.fsPath
    const newPath = path.relative(root, change.uri.fsPath)
    const oldPath = path.relative(root, change.originalUri.fsPath)
    const letter = statusLetter(change.status)
    if (headName === base) {
      // 왼쪽이 작업 트리: 오른쪽(compare)에 있는 것은 가져오고, 오른쪽에 없는 것은 지운다.
      if (letter === 'D') return { sourceRef: compare, imports: [], removals: [newPath] }
      if (letter === 'R') return { sourceRef: compare, imports: [newPath], removals: [oldPath] }
      return { sourceRef: compare, imports: [newPath], removals: [] }
    }
    // 오른쪽이 작업 트리: 왼쪽(base)에 있는 것은 가져오고, 왼쪽에 없는 것은 지운다.
    if (letter === 'A' || letter === 'C') return { sourceRef: base, imports: [], removals: [newPath] }
    if (letter === 'R') return { sourceRef: base, imports: [oldPath], removals: [newPath] }
    return { sourceRef: base, imports: [newPath], removals: [] }
  }

  // 선택한 트리 항목들을 가져오거나 지운다. kind로 가져오기만/삭제만 골라 실행한다.
  async syncNodes(nodes: FileNode[], kind: 'import' | 'remove') {
    const repository = this.repository
    if (!repository) return
    const imports = new Set<string>()
    const removals = new Set<string>()
    let sourceRef: string | undefined
    for (const node of nodes) {
      if (node.kind !== 'diff') continue
      const plan = this.syncPlan(node.change)
      if (!plan) continue
      sourceRef = plan.sourceRef
      if (kind === 'import') plan.imports.forEach((filePath) => imports.add(filePath))
      else plan.removals.forEach((filePath) => removals.add(filePath))
    }
    if (!sourceRef || imports.size + removals.size === 0) {
      vscode.window.showInformationMessage(
        kind === 'import' ? '선택한 항목 중 가져올 파일이 없습니다.' : '선택한 항목 중 지울 파일이 없습니다.',
      )
      return
    }
    const applied = await confirmAndApply({
      repository,
      gitPath: this.git.git.path,
      sourceRef,
      imports: [...imports],
      removals: [...removals],
    })
    if (applied) notifyApplied(sourceRef, imports.size, removals.size)
  }

  // diff 편집기에 넘길 [왼쪽, 오른쪽] URI. 존재하지 않는 쪽은 빈 문서로 대체한다.
  diffUris(change: Change): [vscode.Uri, vscode.Uri] {
    const letter = statusLetter(change.status)
    const emptyUri = vscode.Uri.from({ scheme: EMPTY_SCHEME, path: change.uri.path })
    const left = letter === 'A' || !this.leftRef ? emptyUri : this.git.toGitUri(change.originalUri, this.leftRef)
    const right = letter === 'D' ? emptyUri : this.git.toGitUri(change.uri, this.compare!)
    return [left, right]
  }
}

export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const gitError = error as { stderr?: string; message?: string }
    if (gitError.stderr) return gitError.stderr.trim()
    if (gitError.message) return gitError.message
  }
  return String(error)
}

export interface BranchInfo {
  name: string
  remote: boolean
  current: boolean
}

export async function listBranches(repository: Repository): Promise<BranchInfo[]> {
  const refs = await repository.getBranches({ remote: true, sort: 'committerdate' })
  const headName = repository.state.HEAD?.name
  return refs
    .filter((ref) => ref.name && !ref.name.endsWith('/HEAD'))
    .map((ref) => ({ name: ref.name!, remote: ref.type === RefType.RemoteHead, current: ref.name === headName }))
}

async function pickBranch(repository: Repository, placeHolder: string): Promise<string | undefined> {
  const items = (await listBranches(repository)).map((branch) => ({
    label: branch.name,
    description: [branch.remote ? '원격' : '로컬', branch.current ? '현재 브랜치' : ''].filter(Boolean).join(' · '),
  }))
  const picked = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true })
  return picked?.label
}

async function openConflict(uri: vscode.Uri) {
  try {
    await vscode.commands.executeCommand('git.openMergeEditor', uri)
  } catch {
    await vscode.commands.executeCommand('vscode.open', uri)
  }
}

export async function mergeBranches(provider: BranchCompareProvider) {
  const repository = await provider.getRepository(true)
  const base = provider.base
  const compare = provider.compare
  if (!repository || !base || !compare) {
    vscode.window.showWarningMessage('기준 브랜치와 비교 브랜치를 먼저 선택하세요.')
    return
  }
  if (repository.state.mergeChanges.length > 0) {
    vscode.window.showWarningMessage('이미 진행 중인 병합이 있습니다. 충돌을 먼저 해결하세요.')
    return
  }
  if (repository.state.workingTreeChanges.length > 0 || repository.state.indexChanges.length > 0) {
    vscode.window.showWarningMessage('커밋하지 않은 변경이 있습니다. 커밋하거나 stash한 뒤 병합하세요.')
    return
  }

  // 병합은 항상 현재 체크아웃된 브랜치로 들어가므로, 기준 브랜치가 HEAD가 아니면 먼저 체크아웃해야 한다.
  const headName = repository.state.HEAD?.name
  if (headName !== base) {
    const localBranches = await repository.getBranches({ remote: false })
    if (!localBranches.some((ref) => ref.name === base)) {
      vscode.window.showWarningMessage(`기준 브랜치 ${base}는 로컬 브랜치가 아니라서 병합 대상으로 쓸 수 없습니다.`)
      return
    }
    const answer = await vscode.window.showWarningMessage(
      `현재 브랜치는 ${headName ?? '(detached)'}입니다. ${base}로 체크아웃한 뒤 ${compare}를 병합할까요?`,
      { modal: true },
      '체크아웃 후 병합',
    )
    if (!answer) return
    try {
      await repository.checkout(base)
    } catch (error) {
      vscode.window.showErrorMessage(`체크아웃에 실패했습니다: ${errorMessage(error)}`)
      return
    }
  } else {
    const answer = await vscode.window.showInformationMessage(
      `${base}에 ${compare}를 병합할까요?`,
      { modal: true },
      '병합',
    )
    if (!answer) return
  }

  try {
    await repository.merge(compare)
    vscode.window.showInformationMessage(`${compare}를 ${base}에 병합했습니다.`)
  } catch (error) {
    await repository.status()
    const conflicts = repository.state.mergeChanges
    if (conflicts.length > 0) {
      const answer = await vscode.window.showWarningMessage(
        `충돌 파일이 ${conflicts.length}개 있습니다. 해결한 뒤 스테이징·커밋하면 병합이 끝납니다.`,
        '첫 충돌 파일 열기',
      )
      if (answer) await openConflict(conflicts[0].uri)
    } else {
      vscode.window.showErrorMessage(`병합에 실패했습니다: ${errorMessage(error)}`)
    }
  }
  await provider.refresh()
}

export async function activate(context: vscode.ExtensionContext) {
  const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git')
  if (!gitExtension) {
    vscode.window.showErrorMessage('내장 git 확장을 찾지 못해 브랜치 비교를 사용할 수 없습니다.')
    return
  }
  const git = (gitExtension.isActive ? gitExtension.exports : await gitExtension.activate()).getAPI(1)
  const provider = new BranchCompareProvider(git, context)
  const view = vscode.window.createTreeView('branchCompare.changes', { treeDataProvider: provider, canSelectMany: true })
  provider.view = view
  const historyProvider = new CommitHistoryProvider(provider)
  const selectorView = new BranchSelectorView(provider, historyProvider)
  const historyView = vscode.window.createTreeView('branchCompare.history', { treeDataProvider: historyProvider })

  // 저장소 상태(HEAD 이동, 충돌 발생·해결)가 바뀌면 다시 계산한다. 이벤트가 잦아서 묶어서 처리한다.
  let refreshTimer: NodeJS.Timeout | undefined
  const scheduleRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => provider.refresh(), 500)
  }
  const watchRepository = (repository: Repository) => {
    context.subscriptions.push(repository.state.onDidChange(scheduleRefresh))
    scheduleRefresh()
  }
  git.repositories.forEach(watchRepository)

  context.subscriptions.push(
    view,
    vscode.window.registerWebviewViewProvider(BranchSelectorView.viewId, selectorView),
    historyView,
    vscode.commands.registerCommand('branchCompare.openFolderCompare', async () => {
      await provider.getRepository(true)
      FolderComparePanel.show(provider, context.extensionUri)
    }),
    vscode.commands.registerCommand('branchCompare.openCommitDiff', (node) => historyProvider.openDiff(node)),
    git.onDidOpenRepository(watchRepository),
    git.onDidCloseRepository(scheduleRefresh),
    vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, { provideTextDocumentContent: () => '' }),

    vscode.commands.registerCommand('branchCompare.selectBase', async () => {
      const repository = await provider.getRepository(true)
      if (!repository) return
      const base = await pickBranch(repository, '기준 브랜치(병합을 받을 쪽)를 선택하세요')
      if (base) await provider.setBranches(base, provider.compare)
    }),

    vscode.commands.registerCommand('branchCompare.selectCompare', async () => {
      const repository = await provider.getRepository(true)
      if (!repository) return
      const compare = await pickBranch(repository, '비교 브랜치(병합해 올 쪽)를 선택하세요')
      if (compare) await provider.setBranches(provider.base, compare)
    }),

    vscode.commands.registerCommand('branchCompare.swap', () => provider.setBranches(provider.compare, provider.base)),

    vscode.commands.registerCommand('branchCompare.refresh', () => provider.refresh()),

    // 우클릭 메뉴: 여러 개를 선택했으면 두 번째 인자로 선택 목록이 온다.
    vscode.commands.registerCommand('branchCompare.importFile', (node: FileNode, nodes?: FileNode[]) =>
      provider.syncNodes(nodes?.length ? nodes : [node], 'import'),
    ),
    vscode.commands.registerCommand('branchCompare.removeFile', (node: FileNode, nodes?: FileNode[]) =>
      provider.syncNodes(nodes?.length ? nodes : [node], 'remove'),
    ),
    vscode.commands.registerCommand('branchCompare.openWorkingFile', async (node: FileNode) => {
      try {
        await vscode.workspace.fs.stat(node.change.uri)
        await vscode.commands.executeCommand('vscode.open', node.change.uri)
      } catch {
        vscode.window.showInformationMessage('작업 트리에 이 파일이 없습니다.')
      }
    }),
    vscode.commands.registerCommand('branchCompare.copyPath', async (node: FileNode) => {
      const root = provider.repository?.rootUri.fsPath
      await vscode.env.clipboard.writeText(root ? path.relative(root, node.change.uri.fsPath) : node.change.uri.fsPath)
    }),
    vscode.commands.registerCommand('branchCompare.openDiff', async (node: FileNode) => {
      const [left, right] = provider.diffUris(node.change)
      const name = path.basename(node.change.uri.fsPath)
      await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (${provider.base} ↔ ${provider.compare})`)
    }),

    vscode.commands.registerCommand('branchCompare.openAll', async () => {
      if (provider.changes.length === 0) {
        vscode.window.showInformationMessage('비교할 변경 파일이 없습니다.')
        return
      }
      const resources = provider.changes.map((change) => [change.uri, ...provider.diffUris(change)])
      await vscode.commands.executeCommand('vscode.changes', `${provider.base} ↔ ${provider.compare}`, resources)
    }),

    vscode.commands.registerCommand('branchCompare.openConflict', (node: FileNode) => openConflict(node.change.uri)),

    vscode.commands.registerCommand('branchCompare.merge', () => mergeBranches(provider)),
  )

  // 통합 테스트에서 트리 상태를 확인할 수 있도록 노출한다.
  return { provider, historyProvider }
}

export function deactivate() {}
