import { Fragment, lazy, Suspense, useMemo, useState } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { ChevronDown, ChevronRight, Download, FileCode2, Folder, FolderOpen, RefreshCw } from 'lucide-react'
import type { WorkspaceFile } from '../../../shared/pi-contract'

const HighlightedFile = lazy(() => import('./highlighted-code').then((module) => ({ default: module.HighlightedFile })))

function formatBytes(bytes: number) {
  if (bytes < 1_000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

/* ---------------------------------------------------------------------------
   Tree model. The workspace files arrive as a flat list of absolute paths.
   For a large repo that list can hold thousands of entries, and rendering
   them all as buttons wrecks the DOM. We fold them into a directory tree
   and render only the nodes whose ancestors are expanded — by default
   nothing is expanded, so a freshly-cloned repo costs only the handful of
   top-level entries in the DOM, however many files live below them.
   --------------------------------------------------------------------------- */
type TreeNode = {
  name: string
  path: string
  isDir: boolean
  size: number
  children: Map<string, TreeNode>
}

function buildTree(files: WorkspaceFile[]): TreeNode {
  const root: TreeNode = { name: '', path: '', isDir: true, size: 0, children: new Map() }
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean)
    let node = root
    let cur = ''
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!
      cur = cur ? `${cur}/${part}` : `/${part}`
      const isLeaf = i === parts.length - 1
      if (isLeaf) {
        node.children.set(part, { name: part, path: file.path, isDir: false, size: file.size, children: new Map() })
      } else {
        let child = node.children.get(part)
        if (!child) {
          child = { name: part, path: cur, isDir: true, size: 0, children: new Map() }
          node.children.set(part, child)
        }
        node = child
      }
    }
  }
  return root
}

/** Directories first, then files, each alphabetical. */
function sortedChildren(node: TreeNode): TreeNode[] {
  return [...node.children.values()].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

type WorkspaceBrowserProps = {
  canDownload: boolean
  fileContent: string
  fileError: string
  files: WorkspaceFile[]
  filesError: string
  filesLoading: boolean
  hidden: boolean
  onDownload: () => void
  onRefresh: () => void
  onSelectPath: (path: string) => void
  selectedPath: string
}

export function WorkspaceBrowser(props: WorkspaceBrowserProps) {
  const { canDownload, fileContent, fileError, files, filesError, filesLoading, hidden, onDownload, onRefresh, onSelectPath, selectedPath } = props
  const root = useMemo(() => buildTree(files), [files])
  // Expanded directory paths. Empty by default → only top-level entries render.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const toggle = (path: string) => setExpanded((prev) => {
    const next = new Set(prev)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })

  return (
    <section
      id="files-panel"
      className={`workspace-panel ${hidden ? 'panel-hidden' : ''}`}
      role="tabpanel"
      aria-label="FILES"
      aria-busy={filesLoading}
    >
      <header className="workspace-header">
        <div>
          <span className="panel-kicker">{files.length} FILES</span>
          <strong>Workspace</strong>
        </div>
        <Button
          className="icon-button"
          shape="square"
          size="sm"
          variant="outline"
          onClick={onRefresh}
          disabled={filesLoading}
          title="Refresh files"
          aria-label="Refresh files"
          icon={<RefreshCw size={15} className={filesLoading ? 'spinning' : ''} />}
        />
      </header>

      <div className="file-list" aria-label="Workspace files" role="tree">
        {filesLoading && files.length === 0 && <p className="file-state">Scanning workspace…</p>}
        {filesError && <p className="file-error" role="alert">{filesError}</p>}
        {!filesLoading && files.length === 0 && (
          <div className="file-empty">
            <Folder size={26} strokeWidth={1.5} />
            <strong>No files yet</strong>
            <span>Ask Pi to create one.</span>
          </div>
        )}
        {files.length > 0 && <TreeRows depth={0} expanded={expanded} node={root} onSelectPath={onSelectPath} selectedPath={selectedPath} toggle={toggle} />}
      </div>

      <div className="file-preview">
        {selectedPath ? (
          <>
            <header className="file-preview-header">
              <div>
                <strong>{selectedPath.split('/').pop()}</strong>
                <span>{selectedPath}</span>
              </div>
              <Button
                className="icon-button"
                shape="square"
                size="sm"
                variant="outline"
                onClick={onDownload}
                disabled={!canDownload}
                title="Download file"
                aria-label="Download file"
                icon={<Download size={15} />}
              />
            </header>
            {fileError ? <p className="file-error" role="alert">{fileError}</p> : (
              <Suspense fallback={<pre className="code-viewer"><code>{fileContent}</code></pre>}>
                <HighlightedFile content={fileContent} path={selectedPath} />
              </Suspense>
            )}
          </>
        ) : (
          <div className="preview-placeholder">Select a file to inspect</div>
        )}
      </div>
    </section>
  )
}

function TreeRows({ node, depth, expanded, selectedPath, onSelectPath, toggle }: {
  node: TreeNode
  depth: number
  expanded: Set<string>
  selectedPath: string
  onSelectPath: (path: string) => void
  toggle: (path: string) => void
}) {
  const indent = depth * 14 + 8
  return sortedChildren(node).map((child) => {
    if (child.isDir) {
      const open = expanded.has(child.path)
      return (
        <Fragment key={child.path}>
          <button
            className="tree-row tree-row-dir"
            style={{ paddingLeft: indent }}
            onClick={() => toggle(child.path)}
            aria-expanded={open}
            role="treeitem"
          >
            <span className="tree-chevron">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
            <span className="tree-fileicon">{open ? <FolderOpen size={14} /> : <Folder size={14} />}</span>
            <span className="tree-label">{child.name}</span>
            <span className="tree-count">{child.children.size}</span>
          </button>
          {open && (
            <TreeRows depth={depth + 1} expanded={expanded} node={child} onSelectPath={onSelectPath} selectedPath={selectedPath} toggle={toggle} />
          )}
        </Fragment>
      )
    }
    return (
      <button
        key={child.path}
        className={`tree-row tree-row-file ${selectedPath === child.path ? 'selected' : ''}`}
        style={{ paddingLeft: indent }}
        onClick={() => onSelectPath(child.path)}
        aria-selected={selectedPath === child.path}
        role="treeitem"
      >
        <span className="tree-chevron" />
        <span className="tree-fileicon"><FileCode2 size={14} /></span>
        <span className="tree-label">{child.name}</span>
        <span className="tree-size">{formatBytes(child.size)}</span>
      </button>
    )
  })
}
