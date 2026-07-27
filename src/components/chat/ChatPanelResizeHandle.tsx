import { PanelResizeHandle } from 'react-resizable-panels';
import { ChevronsRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

type ChatPanelResizeHandleProps = {
  isCollapsed: boolean;
  onCollapse: () => void;
  onExpand: () => void;
};

/**
 * The divider between a chat panel and its preview pane: a drag handle that
 * reveals a collapse button on hover, and — once collapsed — the vertical
 * "Chat" tab that brings the panel back. Shared by the creative and agent
 * editors so the two splits stay visually identical.
 */
export function ChatPanelResizeHandle({
  isCollapsed,
  onCollapse,
  onExpand,
}: ChatPanelResizeHandleProps) {
  return (
    <PanelResizeHandle className="resize-handle group relative">
      {isCollapsed ? (
        <div className="absolute left-0 top-1/2 z-50 -translate-y-1/2">
          <Button
            aria-label="Expand chat panel"
            onClick={onExpand}
            className="flex h-[100px] w-9 flex-col items-center rounded-l-none rounded-r-lg bg-adam-bg-secondary-dark px-1.5 py-2 text-adam-text-primary"
          >
            <ChevronsRight className="h-5 w-5 text-white" />
            <div className="flex flex-1 items-center justify-center">
              <span className="rotate-90 transform text-center text-base font-semibold text-white">
                Chat
              </span>
            </div>
          </Button>
        </div>
      ) : (
        <div className="absolute left-1 top-1/2 z-50 -translate-y-1/2 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                aria-label="Collapse chat panel"
                className="rounded-l-none rounded-r-lg border-b border-r border-t border-gray-200/20 bg-adam-bg-secondary-dark p-2 text-adam-text-primary transition-colors hover:bg-black hover:text-adam-neutral-0 dark:border-gray-800"
                onClick={onCollapse}
              >
                <ChevronsRight className="h-5 w-5 rotate-180" />
              </Button>
            </TooltipTrigger>
            <TooltipContent
              side="right"
              className="border-adam-neutral-700 bg-adam-background-2 text-adam-text-primary"
            >
              <p>Collapse chat panel</p>
            </TooltipContent>
          </Tooltip>
        </div>
      )}
    </PanelResizeHandle>
  );
}
