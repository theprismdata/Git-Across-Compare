import * as vscode from 'vscode'
import * as path from 'path'
import { execFile } from 'child_process'
import { Change, Status } from './git'

// git을 직접 실행하고 stdout을 돌려준다. 실패하면 stderr를 붙여 reject한다.
export function runGit(gitPath: string, cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(gitPath, args, { cwd, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stderr }))
        return
      }
      resolve(stdout)
    })
  })
}

// 내장 git API의 diffBetween은 'a...b'(merge-base 기준)만 지원한다.
// 두 브랜치 끝을 그대로 비교('git diff a b')하려면 git을 직접 실행해야 한다.
export async function diffDirect(gitPath: string, repositoryRoot: string, left: string, right: string): Promise<Change[]> {
  const output = await runGit(gitPath, repositoryRoot, ['diff', '--name-status', '-z', '-M', left, right, '--'])
  return parseNameStatus(repositoryRoot, output)
}

// -z 출력은 "상태\0경로\0" 또는 이름변경·복사일 때 "R100\0이전경로\0새경로\0" 형태다.
function parseNameStatus(repositoryRoot: string, output: string): Change[] {
  const fields = output.split('\0')
  const changes: Change[] = []
  let index = 0
  while (index < fields.length) {
    const code = fields[index++]
    if (!code) continue
    const toUri = (relativePath: string) => vscode.Uri.file(path.join(repositoryRoot, relativePath))

    if (code[0] === 'R' || code[0] === 'C') {
      const originalUri = toUri(fields[index++])
      const uri = toUri(fields[index++])
      changes.push({
        uri,
        originalUri,
        renameUri: uri,
        status: code[0] === 'R' ? Status.INDEX_RENAMED : Status.INDEX_COPIED,
      })
      continue
    }

    const uri = toUri(fields[index++])
    let status = Status.MODIFIED
    if (code[0] === 'A') status = Status.INDEX_ADDED
    else if (code[0] === 'D') status = Status.DELETED
    else if (code[0] === 'T') status = Status.TYPE_CHANGED
    changes.push({ uri, originalUri: uri, renameUri: undefined, status })
  }
  return changes
}
