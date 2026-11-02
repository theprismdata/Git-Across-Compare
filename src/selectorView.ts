import * as vscode from 'vscode'
import * as path from 'path'
import type { BranchCompareProvider, CompareMode } from './extension'
import type { CommitHistoryProvider } from './historyView'
import { listBranches } from './extension'

// 웹뷰 → 확장으로 오는 메시지
type IncomingMessage =
  | { type: 'ready' }
  | { type: 'repository'; root: string }
  | { type: 'select'; side: 'base' | 'compare'; name: string }
  | { type: 'swap' }
  | { type: 'mode'; mode: CompareMode }
  | { type: 'refresh' }
  | { type: 'openAll' }
  | { type: 'merge' }
  | { type: 'folderCompare' }

// 왼쪽(기준)·오른쪽(비교) 브랜치를 나란히 고르는 패널. 아래 트리 뷰와 같은 상태(workspaceState)를 쓴다.
export class BranchSelectorView implements vscode.WebviewViewProvider {
  static readonly viewId = 'branchCompare.selector'
  private view: vscode.WebviewView | undefined

  constructor(
    private readonly provider: BranchCompareProvider,
    private readonly history: CommitHistoryProvider,
  ) {
    provider.onDidRefresh(() => this.postState())
    // 커밋 수는 히스토리 계산이 끝난 뒤에 알 수 있다.
    history.onDidChangeTreeData(() => this.postState())
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view
    view.webview.options = { enableScripts: true }
    view.webview.html = this.html()
    view.webview.onDidReceiveMessage((message: IncomingMessage) => this.handle(message))
    view.onDidChangeVisibility(() => {
      if (view.visible) this.postState()
    })
  }

  private async handle(message: IncomingMessage) {
    switch (message.type) {
      case 'ready':
        await this.postState()
        return
      case 'repository':
        await this.provider.setRepository(message.root)
        return
      case 'select':
        if (message.side === 'base') await this.provider.setBranches(message.name || undefined, this.provider.compare)
        else await this.provider.setBranches(this.provider.base, message.name || undefined)
        return
      case 'mode':
        await this.provider.setMode(message.mode)
        return
      case 'swap':
        await this.provider.setBranches(this.provider.compare, this.provider.base)
        return
      case 'refresh':
        await this.provider.refresh()
        return
      case 'openAll':
        await vscode.commands.executeCommand('branchCompare.openAll')
        return
      case 'folderCompare':
        await vscode.commands.executeCommand('branchCompare.openFolderCompare')
        return
      case 'merge':
        await vscode.commands.executeCommand('branchCompare.merge')
        return
    }
  }

  private async postState() {
    if (!this.view) return
    const repository = await this.provider.getRepository(false)
    let branches: Awaited<ReturnType<typeof listBranches>> = []
    if (repository) {
      try {
        branches = await listBranches(repository)
      } catch {
        branches = []
      }
    }
    await this.view.webview.postMessage({
      type: 'state',
      repositories: this.provider.repositories.map((candidate) => ({
        root: candidate.rootUri.fsPath,
        label: path.basename(candidate.rootUri.fsPath),
      })),
      selectedRoot: repository?.rootUri.fsPath,
      branches,
      base: this.provider.base,
      compare: this.provider.compare,
      changeCount: this.provider.changes.length,
      conflictCount: repository?.state.mergeChanges.length ?? 0,
      commitCounts: this.history.counts,
      mode: this.provider.mode,
    })
  }

  private html(): string {
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('')
    return /* html */ `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; }
  body { word-break: keep-all; overflow-wrap: anywhere; padding: 10px 12px; font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  label { display: block; font-size: 11px; opacity: 0.75; margin-bottom: 4px; }
  select {
    width: 100%; min-width: 0; height: 26px; padding: 0 6px;
    background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border, transparent); border-radius: 4px;
  }
  select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .repository { margin-bottom: 12px; }
  .mode { margin-top: 10px; }
  .pair { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 6px; align-items: end; }
  .side.base select { border-left: 3px solid var(--vscode-gitDecoration-deletedResourceForeground); }
  .side.compare select { border-left: 3px solid var(--vscode-gitDecoration-addedResourceForeground); }

  button {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    height: 28px; padding: 0 12px; border: 1px solid transparent; border-radius: 4px;
    font-family: inherit; font-size: 12px; font-weight: 500; white-space: nowrap; cursor: pointer;
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    transition: background-color 0.12s ease, opacity 0.12s ease;
  }
  button svg { width: 14px; height: 14px; flex: none; }
  button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  button:disabled { opacity: 0.4; cursor: default; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  /* 아이콘만 있는 버튼: 평소엔 배경 없이, 올리면 툴바처럼 살짝 강조 */
  button.icon { width: 28px; padding: 0; background: transparent; color: var(--vscode-icon-foreground, var(--vscode-foreground)); }
  button.icon:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
  button.icon svg { width: 16px; height: 16px; }
  .swap { height: 26px; width: 26px; }

  .summary { margin: 12px 0 4px; font-size: 12px; }
  .summary .warning { color: var(--vscode-list-warningForeground); }
  .hint { margin: 0 0 4px; font-size: 11px; line-height: 1.45; opacity: 0.8; }
  button.wide { width: 100%; margin-top: 10px; }
  .actions { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 6px; margin-top: 10px; }
  .actions button:not(.icon) { min-width: 0; }
  .actions button span { overflow: hidden; text-overflow: ellipsis; }
  .hidden { display: none; }
</style>
</head>
<body>
  <div class="repository hidden" id="repositoryBox">
    <label for="repository">저장소</label>
    <select id="repository"></select>
  </div>
  <div class="pair">
    <div class="side base">
      <label for="base">왼쪽 · 기준 (받는 쪽)</label>
      <select id="base"></select>
    </div>
    <button class="icon swap" id="swap" title="좌우 바꾸기" aria-label="좌우 바꾸기">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5.5h10M10 3l2.5 2.5L10 8"/><path d="M13.5 10.5h-10M6 8l-2.5 2.5L6 13"/></svg>
    </button>
    <div class="side compare">
      <label for="compare">오른쪽 · 비교 (가져올 쪽)</label>
      <select id="compare"></select>
    </div>
  </div>
  <div class="mode">
    <label for="mode">비교 방식</label>
    <select id="mode">
      <option value="direct">두 브랜치 끝 직접 비교</option>
      <option value="mergeBase">병합하면 들어올 변경만 (merge-base)</option>
    </select>
  </div>
  <div class="summary" id="summary"></div>
  <div class="hint hidden" id="hint"></div>
  <button class="primary wide" id="folderCompare" title="두 브랜치의 파일 트리를 좌우로 나란히 비교">
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M1.5 4a1 1 0 0 1 1-1h2.2l1 1H7v8.5H2.5a1 1 0 0 1-1-1z"/><path d="M9 4a1 1 0 0 1 1-1h2.2l1 1h.3a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H9z"/></svg>
    <span>폴더 비교 열기</span>
  </button>
  <div class="actions">
    <button id="openAll" title="변경 파일 전체를 한 화면에서 비교">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M8 2.5v11M3.8 6h2.4M10 6h2.4M11.2 4.8v2.4M3.8 10h2.4M9.8 10h2.6"/></svg>
      <span>전체 diff</span>
    </button>
    <button id="merge" title="오른쪽 브랜치를 왼쪽 브랜치로 병합 (오른쪽 → 왼쪽)">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="8" r="1.6"/><path d="M4.5 5.1v5.8"/><path d="M4.5 5.1c0 2.4 2 2.9 5.4 2.9"/></svg>
      <span>병합</span>
    </button>
    <button class="icon" id="refresh" title="새로고침" aria-label="새로고침">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5v3h-3"/></svg>
    </button>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi()
  const $ = (id) => document.getElementById(id)

  function fillBranches(select, branches, selected) {
    select.replaceChildren()
    const empty = new Option('— 선택 —', '')
    select.add(empty)
    const groups = [['로컬', branches.filter((b) => !b.remote)], ['원격', branches.filter((b) => b.remote)]]
    for (const [label, items] of groups) {
      if (items.length === 0) continue
      const group = document.createElement('optgroup')
      group.label = label
      for (const branch of items) {
        group.appendChild(new Option(branch.current ? branch.name + ' (현재)' : branch.name, branch.name))
      }
      select.appendChild(group)
    }
    select.value = selected || ''
  }

  window.addEventListener('message', (event) => {
    const state = event.data
    if (state.type !== 'state') return

    const repositoryBox = $('repositoryBox')
    repositoryBox.classList.toggle('hidden', state.repositories.length <= 1)
    const repository = $('repository')
    repository.replaceChildren(new Option('— 저장소 선택 —', ''))
    for (const item of state.repositories) repository.add(new Option(item.label, item.root))
    repository.value = state.selectedRoot || ''

    fillBranches($('base'), state.branches, state.base)
    fillBranches($('compare'), state.branches, state.compare)

    const ready = Boolean(state.base && state.compare)
    $('openAll').disabled = !ready || state.changeCount === 0
    $('mode').value = state.mode
    // 직접 비교에서는 파일 차이가 있어도 병합할 커밋이 없을 수 있으므로 커밋 수로 판단한다.
    $('merge').disabled = !ready || !state.commitCounts || state.commitCounts.incoming === 0
    $('swap').disabled = !ready
    $('folderCompare').disabled = !ready

    const summary = $('summary')
    if (!state.selectedRoot) summary.textContent = '저장소를 선택하세요.'
    else if (!ready) summary.textContent = '좌우 브랜치를 선택하세요.'
    else {
      summary.textContent = '변경 파일 ' + state.changeCount + '개'
      if (state.commitCounts) {
        summary.textContent += ' · 커밋 오른쪽에만 ' + state.commitCounts.incoming + ' / 왼쪽에만 ' + state.commitCounts.outgoing
      }
    }

    const hint = $('hint')
    let hintText = ''
    if (ready && state.commitCounts) {
      const { incoming, outgoing } = state.commitCounts
      if (incoming === 0 && outgoing === 0) hintText = '두 브랜치가 같은 커밋을 가리킵니다.'
      else if (incoming === 0 && state.mode === 'mergeBase') hintText = '오른쪽은 이미 왼쪽에 모두 포함돼 있어 병합할 것이 없습니다. 비교 방식을 「직접 비교」로 바꾸면 두 브랜치의 차이를 볼 수 있습니다.'
      else if (incoming === 0) hintText = '오른쪽 커밋은 모두 왼쪽에 들어 있어 병합할 것은 없습니다. 목록은 두 브랜치 끝의 차이입니다.'
    }
    hint.textContent = hintText
    hint.classList.toggle('hidden', !hintText)
    if (state.conflictCount > 0) {
      const warning = document.createElement('span')
      warning.className = 'warning'
      warning.textContent = ' · 충돌 ' + state.conflictCount + '개'
      summary.appendChild(warning)
    }
  })

  $('repository').addEventListener('change', (e) => vscode.postMessage({ type: 'repository', root: e.target.value }))
  $('base').addEventListener('change', (e) => vscode.postMessage({ type: 'select', side: 'base', name: e.target.value }))
  $('compare').addEventListener('change', (e) => vscode.postMessage({ type: 'select', side: 'compare', name: e.target.value }))
  $('mode').addEventListener('change', (e) => vscode.postMessage({ type: 'mode', mode: e.target.value }))
  $('swap').addEventListener('click', () => vscode.postMessage({ type: 'swap' }))
  $('folderCompare').addEventListener('click', () => vscode.postMessage({ type: 'folderCompare' }))
  $('openAll').addEventListener('click', () => vscode.postMessage({ type: 'openAll' }))
  $('merge').addEventListener('click', () => vscode.postMessage({ type: 'merge' }))
  $('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }))

  vscode.postMessage({ type: 'ready' })
</script>
</body>
</html>`
  }
}
