// VSCode 내장 git 확장(vscode.git)이 공개하는 API 중 이 확장에서 쓰는 부분만 옮겨 둔 타입.
// 원본: https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts

import { Event, Uri } from 'vscode'

export const enum RefType {
  Head = 0,
  RemoteHead = 1,
  Tag = 2,
}

export interface Ref {
  readonly type: RefType
  readonly name?: string
  readonly commit?: string
  readonly remote?: string
}

export interface Branch extends Ref {
  readonly upstream?: { name: string; remote: string }
  readonly ahead?: number
  readonly behind?: number
}

export const enum Status {
  INDEX_MODIFIED = 0,
  INDEX_ADDED = 1,
  INDEX_DELETED = 2,
  INDEX_RENAMED = 3,
  INDEX_COPIED = 4,
  MODIFIED = 5,
  DELETED = 6,
  UNTRACKED = 7,
  IGNORED = 8,
  INTENT_TO_ADD = 9,
  INTENT_TO_RENAME = 10,
  TYPE_CHANGED = 11,
  ADDED_BY_US = 12,
  ADDED_BY_THEM = 13,
  DELETED_BY_US = 14,
  DELETED_BY_THEM = 15,
  BOTH_ADDED = 16,
  BOTH_DELETED = 17,
  BOTH_MODIFIED = 18,
}

export interface Change {
  readonly uri: Uri
  readonly originalUri: Uri
  readonly renameUri: Uri | undefined
  readonly status: Status
}

export interface Commit {
  readonly hash: string
  readonly message: string
  readonly parents: string[]
  readonly authorDate?: Date
  readonly authorName?: string
  readonly authorEmail?: string
  readonly commitDate?: Date
}

export interface LogOptions {
  readonly maxEntries?: number
  readonly path?: string
  // 'a..b' 같은 git 리비전 범위
  readonly range?: string
}

export interface RepositoryState {
  readonly HEAD: Branch | undefined
  readonly mergeChanges: Change[]
  readonly indexChanges: Change[]
  readonly workingTreeChanges: Change[]
  readonly onDidChange: Event<void>
}

export interface BranchQuery {
  readonly remote?: boolean
  readonly sort?: 'alphabetically' | 'committerdate'
}

export interface Repository {
  readonly rootUri: Uri
  readonly state: RepositoryState
  getBranches(query: BranchQuery): Promise<Ref[]>
  getMergeBase(ref1: string, ref2: string): Promise<string | undefined>
  diffBetween(ref1: string, ref2: string): Promise<Change[]>
  log(options?: LogOptions): Promise<Commit[]>
  checkout(treeish: string): Promise<void>
  merge(ref: string): Promise<void>
  status(): Promise<void>
}

export interface API {
  readonly git: { readonly path: string }
  readonly repositories: Repository[]
  readonly onDidOpenRepository: Event<Repository>
  readonly onDidCloseRepository: Event<Repository>
  toGitUri(uri: Uri, ref: string): Uri
}

export interface GitExtension {
  getAPI(version: 1): API
}
