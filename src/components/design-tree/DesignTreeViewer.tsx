import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Box,
  ChevronDown,
  Folder,
  SlidersHorizontal,
  Wrench,
} from 'lucide-react';
import type { DesignTreeNode, DesignTreeParseWarning } from '@shared/types';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

interface DesignTreeViewerProps {
  nodes: DesignTreeNode[];
  warnings: DesignTreeParseWarning[];
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
}

type TreeNode = DesignTreeNode & { children: TreeNode[] };

export function DesignTreeViewer({
  nodes,
  warnings,
  selectedNodeId,
  onSelectNode,
}: DesignTreeViewerProps) {
  const roots = useMemo(() => buildTree(nodes), [nodes]);
  if (nodes.length === 0 && warnings.length === 0) return null;

  return (
    <section
      aria-label="Design tree"
      className="mb-4 flex flex-col gap-2 border-b border-adam-neutral-700/70 pb-4"
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold text-adam-text-primary">
            Design tree
          </h3>
          <p className="text-[10px] text-adam-neutral-400">
            Select a part to filter its controls
          </p>
        </div>
        {selectedNodeId ? (
          <Button
            type="button"
            variant="ghost"
            className="h-7 px-2 text-[11px] text-adam-neutral-300"
            onClick={() => onSelectNode(null)}
          >
            Show all
          </Button>
        ) : null}
      </div>

      {warnings.length > 0 ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-400/20 bg-amber-400/5 px-2.5 py-2 text-[10px] leading-snug text-amber-100/90">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            {warnings.length === 1
              ? warnings[0].message
              : `${warnings.length} design tree annotations need attention.`}
          </span>
        </div>
      ) : null}

      {roots.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          {roots.map((node) => (
            <DesignTreeRow
              key={node.id}
              node={node}
              selectedNodeId={selectedNodeId}
              onSelectNode={onSelectNode}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function DesignTreeRow({
  node,
  selectedNodeId,
  onSelectNode,
}: {
  node: TreeNode;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
}) {
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;
  const selected = selectedNodeId === node.id;
  const Icon = iconForKind(node.kind);

  const nodeButton = (
    <Button
      type="button"
      variant="ghost"
      aria-pressed={selected}
      onClick={() => onSelectNode(selected ? null : node.id)}
      className={cn(
        'h-7 min-w-0 flex-1 justify-start gap-2 rounded-md px-2 text-left text-[11px] text-adam-neutral-300 hover:bg-adam-neutral-800 hover:text-adam-text-primary',
        selected && 'bg-adam-neutral-800 text-adam-text-primary',
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate">{node.name}</span>
      <span className="ml-auto shrink-0 text-[9px] capitalize text-adam-neutral-500">
        {node.kind}
      </span>
    </Button>
  );

  if (!hasChildren) {
    return <div className="flex items-center gap-1 pl-7">{nodeButton}</div>;
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex items-center gap-1">
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`}
            className="h-7 w-6 shrink-0 rounded-md p-0 text-adam-neutral-400 hover:bg-adam-neutral-800 hover:text-adam-text-primary"
          >
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 transition-transform',
                !open && '-rotate-90',
              )}
            />
          </Button>
        </CollapsibleTrigger>
        {nodeButton}
      </div>
      <CollapsibleContent>
        <div className="ml-3 border-l border-adam-neutral-700 pl-2">
          {node.children.map((child) => (
            <DesignTreeRow
              key={child.id}
              node={child}
              selectedNodeId={selectedNodeId}
              onSelectNode={onSelectNode}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function buildTree(nodes: DesignTreeNode[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  for (const node of nodes) byId.set(node.id, { ...node, children: [] });

  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent && !wouldCreateCycle(node, parent, byId)) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function wouldCreateCycle(
  node: TreeNode,
  parent: TreeNode,
  byId: Map<string, TreeNode>,
) {
  const seen = new Set<string>();
  let current: TreeNode | undefined = parent;
  while (current) {
    if (current.id === node.id) return true;
    if (!current.parentId || seen.has(current.id)) return false;
    seen.add(current.id);
    current = byId.get(current.parentId);
  }
  return false;
}

function iconForKind(kind: DesignTreeNode['kind']) {
  switch (kind) {
    case 'group':
      return Folder;
    case 'operation':
      return Wrench;
    case 'parameter':
      return SlidersHorizontal;
    case 'part':
    default:
      return Box;
  }
}
