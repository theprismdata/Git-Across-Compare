import * as vscode from 'vscode'
import * as path from 'path'
import { errorMessage } from './extension'
import { runGit } from './directDiff'
import { Repository } from './git'

// git 명령 한 번에 넘길 경로 수. 명령줄 길이 제한을 넘지 않도록 나눠서 실행한다.
const PATH_CHUNK = 100

export interface WorkingTreeChange {
  repository: Repository
  gitPath: string
  // 가져올 파일의 원본 브랜치
  sourceRef: string
  // 원본 버전으로 덮어쓸 파일(저장소 기준 상대 경로)
  imports: string[]
  // 원본에 없어서 지울 파일(저장소 기준 상대 경로)
  removals: string[]
}

// 확인 창을 띄운 뒤 작업 트리를 바꾼다.
// - imports: git checkout <원본> -- <경로>
// - removals: git rm
// 바꿨으면 true, 취소했거나 실패했으면 false를 돌려준다. 결과는 인덱스에 스테이징된다.
export async function confirmAndApply(change: WorkingTreeChange): Promise<boolean> {
  const { repository, gitPath, sourceRef, imports, removals } = change
  const root = repository.rootUri.fsPath
  const locallyChanged = new Set(
    [...repository.state.workingTreeChanges, ...repository.state.indexChanges].map((item) =>
      path.relative(root, item.uri.fsPath),
    ),
  )
  const lost = [...imports, ...removals].filter((filePath) => locallyChanged.has(filePath))

  const describe = (paths: string[]) => (paths.length === 1 ? paths[0] : `${paths.length}개 파일`)
  const lines: string[] = []
  if (imports.length > 0) lines.push(`가져오기: ${describe(imports)}을(를) ${sourceRef} 버전으로 덮어씁니다.`)
  if (removals.length > 0) lines.push(`삭제: ${sourceRef}에 없는 ${describe(removals)}을(를) 작업 트리에서 지웁니다.`)
  if (lost.length > 0) {
    lines.push(
      `\n주의: 이 중 ${lost.length}개는 커밋하지 않은 수정이 있어 사라집니다.\n${lost.slice(0, 5).join('\n')}${lost.length > 5 ? '\n…' : ''}`,
    )
  }
  const confirmLabel = removals.length > 0 && imports.length === 0 ? '삭제' : removals.length > 0 ? '동기화' : '가져오기'
  const answer = await vscode.window.showWarningMessage(lines.join('\n'), { modal: true }, confirmLabel)
  if (!answer) return false

  try {
    for (let start = 0; start < imports.length; start += PATH_CHUNK) {
      await runGit(gitPath, root, ['checkout', sourceRef, '--', ...imports.slice(start, start + PATH_CHUNK)])
    }
    // 사용자가 위에서 로컬 수정 손실을 확인했으므로 -f로 지운다. 이미 없는 파일은 건너뛴다.
    for (let start = 0; start < removals.length; start += PATH_CHUNK) {
      await runGit(gitPath, root, ['rm', '-f', '-q', '--ignore-unmatch', '--', ...removals.slice(start, start + PATH_CHUNK)])
    }
  } catch (error) {
    vscode.window.showErrorMessage(`작업 트리를 바꾸지 못했습니다: ${errorMessage(error)}`)
    await repository.status()
    return false
  }
  await repository.status()
  return true
}

// 완료 알림. 사용자가 닫을 때까지 기다리지 않도록 결과를 await하지 않는다.
export function notifyApplied(sourceRef: string, importCount: number, removalCount: number) {
  const done: string[] = []
  if (importCount > 0) done.push(`${importCount}개 가져옴`)
  if (removalCount > 0) done.push(`${removalCount}개 삭제함`)
  vscode.window
    .showInformationMessage(
      `${done.join(', ')} (${sourceRef} 기준). 변경은 스테이징돼 있습니다. 소스 제어에서 확인한 뒤 커밋하세요.`,
      '소스 제어 열기',
    )
    .then((open) => {
      if (open) vscode.commands.executeCommand('workbench.view.scm')
    })
}
