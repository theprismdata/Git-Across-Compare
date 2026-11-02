// 폴더 비교 웹뷰. 확장이 보내는 파일 목록(entries)으로 좌우 정렬 트리를 그린다.
;(function () {
  const vscode = acquireVsCodeApi()
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id))
  const rowsElement = $('rows')
  const menuElement = $('menu')

  const ICONS = {
    expandAll:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/><path d="M4 2.5l4 4 4-4" opacity=".5"/></svg>',
    collapseAll:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10l4-4 4 4"/><path d="M4 13.5l4-4 4 4" opacity=".5"/></svg>',
    swap: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5.5h10M10 3l2.5 2.5L10 8"/><path d="M13.5 10.5h-10M6 8l-2.5 2.5L6 13"/></svg>',
    refresh:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5v3h-3"/></svg>',
    folder:
      '<svg class="node-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.5A1 1 0 0 1 2.5 2.5h3.6l1.5 1.5h5.9a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" opacity=".85"/></svg>',
    file: '<svg class="node-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M4 1.5h5l3 3v10H4z"/><path d="M9 1.5v3h3"/></svg>',
    chevron:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>',
  }
  for (const id of ['expandAll', 'collapseAll', 'swap', 'refresh']) $(id).innerHTML = ICONS[id]

  const GUTTER = { diff: '≠', same: '=', leftOnly: '◀', rightOnly: '▶' }

  /** 상태 */
  let data = null
  let root = null
  let filter = 'diff'
  let search = ''
  let selectedPath = null
  /** @type {Set<string>} */
  let expanded = new Set()
  let firstLoad = true
  /** 현재 화면에 그려진 행(키보드 이동용) */
  let visibleRows = []
  /** @type {Map<string, any>} */
  let nodesByPath = new Map()

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KB'
    return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  }

  function statusOf(entry) {
    if (entry.left && entry.right) return entry.left.blob === entry.right.blob ? 'same' : 'diff'
    return entry.left ? 'leftOnly' : 'rightOnly'
  }

  function matchesFilter(status) {
    if (filter === 'all') return true
    if (filter === 'diff') return status !== 'same'
    if (filter === 'same') return status === 'same'
    return status === 'leftOnly' || status === 'rightOnly'
  }

  // 경로 목록을 폴더 트리로 만든다. 폴더에는 양쪽 존재 여부와 하위 차이 여부를 미리 모아 둔다.
  function buildTree(entries) {
    const top = { type: 'dir', name: '', path: '', children: new Map(), hasLeft: true, hasRight: true, status: 'same' }
    nodesByPath = new Map()
    for (const entry of entries) {
      const parts = entry.path.split('/')
      let node = top
      for (let index = 0; index < parts.length - 1; index++) {
        const dirPath = parts.slice(0, index + 1).join('/')
        let child = node.children.get(parts[index])
        if (!child) {
          child = { type: 'dir', name: parts[index], path: dirPath, children: new Map(), hasLeft: false, hasRight: false, hasDiff: false }
          node.children.set(parts[index], child)
          nodesByPath.set(dirPath, child)
        }
        node = child
      }
      const file = { type: 'file', name: parts[parts.length - 1], path: entry.path, entry, status: statusOf(entry) }
      node.children.set(file.name, file)
      nodesByPath.set(entry.path, file)
    }
    summarize(top)
    return top
  }

  function summarize(node) {
    if (node.type === 'file') return
    let hasLeft = false
    let hasRight = false
    let hasDiff = false
    for (const child of node.children.values()) {
      summarize(child)
      const childLeft = child.type === 'file' ? Boolean(child.entry.left) : child.hasLeft
      const childRight = child.type === 'file' ? Boolean(child.entry.right) : child.hasRight
      hasLeft = hasLeft || childLeft
      hasRight = hasRight || childRight
      hasDiff = hasDiff || (child.type === 'file' ? child.status !== 'same' : child.status !== 'same')
    }
    node.hasLeft = hasLeft
    node.hasRight = hasRight
    if (!hasRight) node.status = 'leftOnly'
    else if (!hasLeft) node.status = 'rightOnly'
    else node.status = hasDiff ? 'diff' : 'same'
  }

  function sortedChildren(node) {
    return [...node.children.values()].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }

  // 필터·검색을 통과하는 파일 수를 폴더마다 센다(접힌 폴더도 보일지 판단해야 하므로).
  function countMatches(node, counts) {
    if (node.type === 'file') {
      const ok = matchesFilter(node.status) && (!search || node.path.toLowerCase().includes(search))
      return ok ? 1 : 0
    }
    let total = 0
    for (const child of node.children.values()) total += countMatches(child, counts)
    counts.set(node.path, total)
    return total
  }

  function filesUnder(node) {
    if (node.type === 'file') return [node]
    const files = []
    for (const child of node.children.values()) files.push(...filesUnder(child))
    return files
  }

  function render() {
    if (!root) return
    const counts = new Map()
    countMatches(root, counts)
    visibleRows = []
    const html = []

    const walk = (node, depth) => {
      for (const child of sortedChildren(node)) {
        if (child.type === 'dir') {
          if (!counts.get(child.path)) continue
          const open = search ? true : expanded.has(child.path)
          visibleRows.push(child)
          html.push(rowHtml(child, depth, open))
          if (open) walk(child, depth + 1)
        } else if (matchesFilter(child.status) && (!search || child.path.toLowerCase().includes(search))) {
          visibleRows.push(child)
          html.push(rowHtml(child, depth, false))
        }
      }
    }
    walk(root, 0)

    if (html.length === 0) {
      rowsElement.innerHTML = '<div class="placeholder">' + (search ? '검색 결과가 없습니다.' : '이 필터에 해당하는 파일이 없습니다.') + '</div>'
    } else {
      rowsElement.innerHTML = html.join('')
    }
    renderStatusbar()
    updateToolbar()
  }

  function rowHtml(node, depth, open) {
    const isDir = node.type === 'dir'
    const onLeft = isDir ? node.hasLeft : Boolean(node.entry.left)
    const onRight = isDir ? node.hasRight : Boolean(node.entry.right)
    const imported = !isDir && data.imported.includes(node.path)
    const removed = !isDir && data.removed.includes(node.path)
    const classes = ['row', 's-' + node.status, isDir ? 'dir' : 'file']
    if (node.path === selectedPath) classes.push('selected')
    if (imported) classes.push('imported')
    if (removed) classes.push('removed')

    const cell = (present, side) => {
      if (!present) return '<div class="cell ' + side + ' empty"></div>'
      const indent = '<span class="indent" style="width:' + depth * 16 + 'px"></span>'
      const twisty = isDir
        ? '<span class="twisty' + (open ? ' open' : '') + '">' + ICONS.chevron + '</span>'
        : '<span class="twisty"></span>'
      const icon = isDir ? ICONS.folder : ICONS.file
      const sideFile = isDir ? null : node.entry[side]
      const meta = sideFile ? '<span class="meta">' + formatSize(sideFile.size) + '</span>' : ''
      const headSide = data[side].isHead
      let badge = ''
      if (headSide && imported) badge = '<span class="badge">가져옴</span>'
      if (headSide && removed) badge = '<span class="badge removed">삭제함</span>'
      return (
        '<div class="cell ' + side + '">' + indent + twisty + icon +
        '<span class="name">' + escapeHtml(node.name) + '</span>' + badge + meta + '</div>'
      )
    }

    return (
      '<div class="' + classes.join(' ') + '" data-path="' + escapeHtml(node.path) + '">' +
      cell(onLeft, 'left') +
      '<div class="gutter">' + GUTTER[node.status] + '</div>' +
      cell(onRight, 'right') +
      '</div>'
    )
  }

  function renderStatusbar() {
    const totals = { diff: 0, same: 0, leftOnly: 0, rightOnly: 0 }
    for (const entry of data.entries) totals[statusOf(entry)]++
    const parts = [
      '<span class="s-diff">다름 ' + totals.diff + '</span>',
      '<span class="s-leftOnly">왼쪽에만 ' + totals.leftOnly + '</span>',
      '<span class="s-rightOnly">오른쪽에만 ' + totals.rightOnly + '</span>',
      '<span class="s-same">같음 ' + totals.same + '</span>',
    ]
    if (data.imported.length) parts.push('<span class="badge">가져옴 ' + data.imported.length + '</span>')
    if (data.removed.length) parts.push('<span class="badge removed">삭제함 ' + data.removed.length + '</span>')
    $('statusbar').innerHTML = parts.join('<span class="dot">·</span>')
  }

  function renderHeaders() {
    for (const side of ['left', 'right']) {
      const info = data[side]
      const label = side === 'left' ? '왼쪽' : '오른쪽'
      const head = info.isHead ? '<span class="head-badge" title="작업 트리가 이 브랜치입니다. 이쪽으로 파일을 가져올 수 있습니다.">체크아웃됨</span>' : ''
      $(side + 'Header').innerHTML =
        '<span class="label">' + label + '</span><span class="branch">' + escapeHtml(info.name) + '</span>' + head
    }
  }

  function select(path, scroll) {
    selectedPath = path
    for (const element of rowsElement.querySelectorAll('.row.selected')) element.classList.remove('selected')
    const element = rowsElement.querySelector('.row[data-path="' + CSS.escape(path) + '"]')
    if (element) {
      element.classList.add('selected')
      if (scroll) element.scrollIntoView({ block: 'nearest' })
    }
    updateToolbar()
  }

  function toggle(path, force) {
    const open = force === undefined ? !expanded.has(path) : force
    if (open) expanded.add(path)
    else expanded.delete(path)
    render()
  }

  function activate(node) {
    if (node.type === 'dir') toggle(node.path)
    else vscode.postMessage({ type: 'openDiff', path: node.path })
  }

  // ── 우클릭 메뉴 ─────────────────────────────────────────────
  function importablePaths(node, from) {
    return filesUnder(node)
      .filter((file) => {
        const source = file.entry[from]
        const target = file.entry[from === 'left' ? 'right' : 'left']
        return source && (!target || source.blob !== target.blob)
      })
      .map((file) => file.path)
  }

  // 받는 쪽(target)에만 있고 원본 쪽에는 없는 파일. 아직 지우지 않은 것만.
  function removablePaths(node, target) {
    const source = target === 'left' ? 'right' : 'left'
    return filesUnder(node)
      .filter((file) => file.entry[target] && !file.entry[source] && !data.removed.includes(file.path))
      .map((file) => file.path)
  }

  // 선택한 항목에 대해 할 수 있는 가져오기·삭제·동기화. 우클릭 메뉴와 툴바 버튼이 함께 쓴다.
  // 작업 트리는 체크아웃된 브랜치의 것이므로 그쪽(target)으로만 바꿀 수 있다.
  function syncActions(node) {
    const target = data.left.isHead ? 'left' : data.right.isHead ? 'right' : null
    if (!target) {
      const reason = '좌우 중 한쪽 브랜치가 체크아웃돼 있어야 그쪽 작업 트리로 파일을 가져오거나 지울 수 있습니다'
      return [
        { kind: 'import', short: '가져오기', label: '가져오기·삭제 불가', disabled: true, title: reason },
        { kind: 'remove', short: '삭제', label: '', disabled: true, title: reason, hiddenInMenu: true },
        { kind: 'mirror', short: '동기화', label: '', disabled: true, title: reason, hiddenInMenu: true },
      ]
    }
    const from = target === 'left' ? 'right' : 'left'
    const arrow = target === 'left' ? '←' : '→'
    const fromName = data[from].name
    const targetLabel = target === 'left' ? '왼쪽' : '오른쪽'
    const imports = importablePaths(node, from)
    const removals = removablePaths(node, target)
    const isDir = node.type === 'dir'
    const count = (n) => (isDir ? ' (' + n + '개)' : '')
    return [
      {
        kind: 'import',
        short: arrow + ' 가져오기' + count(imports.length),
        label: arrow + ' ' + fromName + ' 버전을 ' + targetLabel + '(작업 트리)으로 가져오기' + count(imports.length),
        disabled: imports.length === 0,
        title: imports.length === 0 ? fromName + '에서 가져올 다른 파일이 없습니다' : fromName + ' 버전으로 덮어씁니다',
        hiddenInMenu: !isDir && imports.length === 0,
        action: () => vscode.postMessage({ type: 'import', from, paths: imports }),
      },
      {
        kind: 'remove',
        short: '✕ 삭제' + count(removals.length),
        label: '✕ ' + fromName + '에 없는 파일을 작업 트리에서 삭제' + count(removals.length),
        danger: true,
        disabled: removals.length === 0,
        title: removals.length === 0 ? '지울 파일이 없습니다 (' + fromName + '에도 있는 파일입니다)' : fromName + '에 없는 파일을 지웁니다',
        hiddenInMenu: !isDir && removals.length === 0,
        action: () => vscode.postMessage({ type: 'remove', from, paths: removals }),
      },
      {
        kind: 'mirror',
        short: '⇆ 동기화',
        label: '⇆ ' + fromName + ' 기준으로 동기화 (가져오기 ' + imports.length + ' + 삭제 ' + removals.length + ')',
        disabled: !isDir || imports.length + removals.length === 0,
        title: isDir ? '이 폴더를 ' + fromName + '와 똑같이 맞춥니다 (가져오기 ' + imports.length + ' + 삭제 ' + removals.length + ')' : '폴더를 선택하면 쓸 수 있습니다',
        hiddenInMenu: !isDir,
        action: () => vscode.postMessage({ type: 'mirror', from, importPaths: imports, removePaths: removals }),
      },
    ]
  }

  // 툴바의 가져오기·삭제·동기화 버튼을 선택 항목에 맞춘다.
  function updateToolbar() {
    const node = selectedPath ? nodesByPath.get(selectedPath) : undefined
    const buttons = { import: $('actImport'), remove: $('actRemove'), mirror: $('actMirror') }
    if (!data || !node) {
      for (const [kind, button] of Object.entries(buttons)) {
        button.disabled = true
        button.title = '목록에서 파일이나 폴더를 선택하세요'
        button.querySelector('span').textContent = { import: '가져오기', remove: '✕ 삭제', mirror: '⇆ 동기화' }[kind]
      }
      return
    }
    for (const action of syncActions(node)) {
      const button = buttons[action.kind]
      button.disabled = Boolean(action.disabled)
      button.title = action.title || ''
      button.querySelector('span').textContent = action.short
      button.onclick = action.action || null
    }
  }

  function showMenu(node, x, y) {
    const items = []
    if (node.type === 'file') items.push({ label: '비교 열기', action: () => activate(node) })
    else {
      items.push({ label: expanded.has(node.path) ? '접기' : '펼치기', action: () => toggle(node.path) })
      items.push({
        label: '이 폴더 모두 펼치기',
        action: () => {
          for (const child of filesUnder(node)) {
            const parts = child.path.split('/')
            for (let index = 1; index < parts.length; index++) expanded.add(parts.slice(0, index).join('/'))
          }
          render()
        },
      })
    }
    items.push({ separator: true })

    for (const action of syncActions(node)) items.push(action)
    items.push({ separator: true })
    items.push({ label: '경로 복사', action: () => vscode.postMessage({ type: 'copyPath', path: node.path }) })

    menuElement.innerHTML = ''
    for (const item of items) {
      if (item.hiddenInMenu) continue
      if (item.separator) {
        menuElement.appendChild(Object.assign(document.createElement('div'), { className: 'separator' }))
        continue
      }
      const button = document.createElement('button')
      button.className = 'menu-item' + (item.danger ? ' danger' : '')
      button.textContent = item.label
      button.disabled = Boolean(item.disabled)
      if (item.title) button.title = item.title
      button.addEventListener('click', () => {
        hideMenu()
        if (item.action) item.action()
      })
      menuElement.appendChild(button)
    }
    menuElement.classList.remove('hidden')
    const rect = menuElement.getBoundingClientRect()
    menuElement.style.left = Math.min(x, window.innerWidth - rect.width - 4) + 'px'
    menuElement.style.top = Math.min(y, window.innerHeight - rect.height - 4) + 'px'
  }

  function hideMenu() {
    menuElement.classList.add('hidden')
  }

  // ── 이벤트 ──────────────────────────────────────────────────
  function nodeFromEvent(event) {
    const row = /** @type {HTMLElement} */ (event.target).closest('.row')
    return row ? nodesByPath.get(row.getAttribute('data-path')) : undefined
  }

  rowsElement.addEventListener('click', (event) => {
    const node = nodeFromEvent(event)
    if (!node) return
    select(node.path, false)
    if (node.type === 'dir' && /** @type {HTMLElement} */ (event.target).closest('.twisty')) toggle(node.path)
  })
  rowsElement.addEventListener('dblclick', (event) => {
    const node = nodeFromEvent(event)
    if (node) activate(node)
  })
  rowsElement.addEventListener('contextmenu', (event) => {
    const node = nodeFromEvent(event)
    if (!node) return
    event.preventDefault()
    select(node.path, false)
    showMenu(node, event.clientX, event.clientY)
  })
  // 메뉴 바깥을 누르거나 목록을 스크롤하면 닫는다.
  // (window blur로 닫으면 VSCode가 우클릭 때 포커스를 옮기면서 메뉴가 뜨자마자 닫힐 수 있다)
  document.addEventListener('mousedown', (event) => {
    if (event.button === 0 && !menuElement.contains(/** @type {Node} */ (event.target))) hideMenu()
  })
  rowsElement.addEventListener('scroll', hideMenu)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideMenu()
  })

  rowsElement.addEventListener('keydown', (event) => {
    if (visibleRows.length === 0) return
    const index = visibleRows.findIndex((node) => node.path === selectedPath)
    const current = visibleRows[index]
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const next = visibleRows[Math.max(0, Math.min(visibleRows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]
      select(next.path, true)
    } else if (event.key === 'Enter' && current) {
      activate(current)
    } else if (event.key === 'ArrowRight' && current && current.type === 'dir') {
      toggle(current.path, true)
    } else if (event.key === 'ArrowLeft' && current) {
      if (current.type === 'dir' && expanded.has(current.path)) toggle(current.path, false)
      else {
        const parent = current.path.split('/').slice(0, -1).join('/')
        if (parent) select(parent, true)
      }
    } else if (event.key === 'Escape') {
      hideMenu()
      return
    } else return
    event.preventDefault()
  })

  for (const button of document.querySelectorAll('#filters button')) {
    button.addEventListener('click', () => {
      filter = button.getAttribute('data-filter') || 'diff'
      for (const other of document.querySelectorAll('#filters button')) other.classList.toggle('active', other === button)
      render()
    })
  }
  $('search').addEventListener('input', (event) => {
    search = /** @type {HTMLInputElement} */ (event.target).value.trim().toLowerCase()
    render()
  })
  $('expandAll').addEventListener('click', () => {
    for (const node of nodesByPath.values()) if (node.type === 'dir') expanded.add(node.path)
    render()
  })
  $('collapseAll').addEventListener('click', () => {
    expanded.clear()
    render()
  })
  $('swap').addEventListener('click', () => vscode.postMessage({ type: 'swap' }))
  $('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }))

  window.addEventListener('message', (event) => {
    const message = event.data
    if (message.type === 'loading') {
      if (!root) rowsElement.innerHTML = '<div class="placeholder">파일 목록을 읽는 중…</div>'
      return
    }
    if (message.type === 'empty') {
      data = null
      root = null
      rowsElement.innerHTML = '<div class="placeholder">' + escapeHtml(message.message) + '</div>'
      $('statusbar').innerHTML = ''
      $('leftHeader').innerHTML = ''
      $('rightHeader').innerHTML = ''
      return
    }
    if (message.type !== 'data') return

    const branchesChanged = !data || data.left.name !== message.left.name || data.right.name !== message.right.name
    data = message
    root = buildTree(message.entries)
    // 처음 열거나 브랜치가 바뀌면, 차이가 있는 폴더만 펼친 상태로 시작한다.
    if (firstLoad || branchesChanged) {
      expanded = new Set()
      for (const node of nodesByPath.values()) if (node.type === 'dir' && node.status !== 'same') expanded.add(node.path)
      firstLoad = false
    }
    renderHeaders()
    render()
  })

  vscode.postMessage({ type: 'ready' })
})()
