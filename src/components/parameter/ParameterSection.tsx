import {
  RefreshCcw,
  Download,
  ChevronUp,
  ChevronDown,
  Loader2,
} from 'lucide-react';
import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Message, Parameter } from '@shared/types';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { ParameterInput } from '@/components/parameter/ParameterInput';
import {
  validateParameterValue,
  isColorParameter,
} from '@/utils/parameterUtils';
import { useCurrentMessage } from '@/contexts/CurrentMessageContext';
import {
  downloadSTLFile,
  downloadOpenSCADFile,
  downloadDXFFile,
  downloadSTEPFile,
  downloadOBJFile,
  DxfExporter,
} from '@/utils/downloadUtils';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import parseDesignTree from '@shared/parseDesignTree';
import { DesignTreeViewer } from '@/components/design-tree/DesignTreeViewer';

interface ParameterSectionProps {
  parameters: Parameter[];
  onSubmit: (message: Message | null, parameters: Parameter[]) => void;
  currentOutput?: Blob;
  dxfExporter?: DxfExporter | null;
  // Code of the selected artifact version for the .scad export. Falls back to
  // the live artifact's code when omitted.
  artifactCode?: string;
  // True when an older version is selected: parameter editing is disabled (a
  // revision would branch off the latest, not the version being viewed) while
  // downloads stay available.
  editingDisabled?: boolean;
  // Selected version label (e.g. 'V1') shown in the read-only hint.
  versionLabel?: string;
}

type DownloadFormat = 'stl' | 'scad' | 'dxf' | 'step' | 'obj';

type ParameterGroup = { name: string; parameters: Parameter[] };

function groupParameters(parameters: Parameter[]): ParameterGroup[] {
  const groups = new Map<string, Parameter[]>();
  for (const parameter of parameters) {
    const name =
      parameter.group?.trim() ||
      (isColorParameter(parameter) ? 'Colors' : 'Dimensions');
    const group = groups.get(name);
    if (group) group.push(parameter);
    else groups.set(name, [parameter]);
  }
  return Array.from(groups, ([name, groupedParameters]) => ({
    name,
    parameters: groupedParameters,
  }));
}

function ParameterGroupControls({
  name,
  parameters,
  separated,
  handleCommit,
}: {
  name: string;
  parameters: Parameter[];
  separated: boolean;
  handleCommit: (param: Parameter, value: Parameter['value']) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        separated && 'mt-3 border-t border-adam-neutral-700/60 pt-3',
      )}
    >
      <CollapsibleTrigger
        aria-label={`${open ? 'Collapse' : 'Expand'} ${name} parameters`}
        className="group flex w-full items-center justify-between gap-2 rounded-md py-1 text-xs font-semibold text-adam-text-primary transition-colors focus:outline-none"
      >
        <span className="flex items-center gap-2">
          {name}
          <span className="text-[10px] text-adam-neutral-400">
            {parameters.length}
          </span>
        </span>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 text-adam-neutral-400 transition-all duration-200 group-hover:text-adam-text-primary',
            open && 'rotate-180',
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0">
        <div className="mt-3 flex flex-col gap-3">
          {parameters.map((param) => (
            <ParameterInput
              key={param.name}
              param={param}
              handleCommit={handleCommit}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ParameterSection({
  parameters,
  onSubmit,
  currentOutput,
  dxfExporter,
  artifactCode,
  editingDisabled = false,
  versionLabel,
}: ParameterSectionProps) {
  const { currentMessage } = useCurrentMessage();
  const { toast } = useToast();
  const [selectedFormat, setSelectedFormat] = useState<DownloadFormat>('stl');
  const [isExporting, setIsExporting] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const sourceCode =
    artifactCode ?? currentMessage?.content.artifact?.code ?? '';
  const designTree = useMemo(() => parseDesignTree(sourceCode), [sourceCode]);
  const selectedNode = designTree.nodes.find(
    (node) => node.id === selectedNodeId,
  );
  const visibleParameters = useMemo(() => {
    if (!selectedNode?.params?.length) return parameters;
    const names = new Set(selectedNode.params);
    return parameters.filter((parameter) => names.has(parameter.name));
  }, [parameters, selectedNode]);
  const parameterGroups = useMemo(
    () => groupParameters(visibleParameters),
    [visibleParameters],
  );

  // Debounce timer for compilation
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingParametersRef = useRef<Parameter[] | null>(null);
  const onSubmitRef = useRef(onSubmit);
  const currentMessageRef = useRef<Message | null>(currentMessage);

  onSubmitRef.current = onSubmit;
  currentMessageRef.current = currentMessage;

  // Flush pending debounced edits on unmount instead of dropping the last
  // slider/input change when the panel closes or the route changes quickly.
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      if (pendingParametersRef.current) {
        onSubmitRef.current(
          currentMessageRef.current,
          pendingParametersRef.current,
        );
        pendingParametersRef.current = null;
      }
    };
  }, []);

  // Debounced submit function
  const debouncedSubmit = useCallback(
    (params: Parameter[]) => {
      // Store the parameters to submit
      pendingParametersRef.current = params;

      // Clear existing timer
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      // Set new debounced timer (200ms delay)
      debounceTimerRef.current = setTimeout(() => {
        if (pendingParametersRef.current) {
          onSubmit(currentMessage, pendingParametersRef.current);
          pendingParametersRef.current = null;
        }
      }, 200);
    },
    [onSubmit, currentMessage],
  );

  const handleCommit = (param: Parameter, value: Parameter['value']) => {
    // Older versions are view-only; ignore any stray commit (the controls are
    // also made non-interactive below).
    if (editingDisabled) return;
    const validatedValue = validateParameterValue(param, value);

    const updatedParam = { ...param, value: validatedValue };
    const updatedParameters = parameters.map((p) =>
      p.name === param.name ? updatedParam : p,
    );

    debouncedSubmit(updatedParameters);
  };

  const handleDownloadSTL = () => {
    if (!currentOutput) return;
    downloadSTLFile(currentOutput, currentMessage);
  };

  const handleDownloadOpenSCAD = () => {
    const scadCode = artifactCode ?? currentMessage?.content.artifact?.code;
    if (!scadCode) return;
    downloadOpenSCADFile(scadCode, currentMessage);
  };

  const handleDownloadDXF = async () => {
    if (!dxfExporter) return;

    // DXF is async, generated on click via a fresh OpenSCAD compile, it can reject.
    try {
      setIsExporting(true);
      const dxfOutput = await dxfExporter();
      downloadDXFFile(dxfOutput, currentMessage);
    } catch (error) {
      console.error('[OpenSCAD] Failed to export DXF:', error);
      // Optional user-facing feedback to surface the failure
      toast({
        title: 'DXF export failed',
        description:
          error instanceof Error
            ? error.message
            : 'Adam could not export this model as DXF.',
        variant: 'destructive',
      });
    } finally {
      setIsExporting(false);
    }
  };

  const handleDownloadSTEP = async () => {
    if (!currentOutput) return;

    try {
      setIsExporting(true);
      await downloadSTEPFile(currentOutput, currentMessage);
    } catch (error) {
      console.error('[OpenSCAD] Failed to export STEP:', error);
      toast({
        title: 'STEP export failed',
        description:
          error instanceof Error
            ? error.message
            : 'Adam could not export this model as STEP.',
        variant: 'destructive',
      });
    } finally {
      setIsExporting(false);
    }
  };

  const handleDownloadOBJ = async () => {
    if (!currentOutput) return;

    try {
      setIsExporting(true);
      await downloadOBJFile(currentOutput, currentMessage);
    } catch (error) {
      console.error('[OpenSCAD] Failed to export OBJ:', error);
      toast({
        title: 'OBJ export failed',
        description:
          error instanceof Error
            ? error.message
            : 'Adam could not export this model as OBJ.',
        variant: 'destructive',
      });
    } finally {
      setIsExporting(false);
    }
  };

  // Per-format dispatch tables — each supported format is a single line in each map.
  const downloadHandlers: Record<DownloadFormat, () => void | Promise<void>> = {
    stl: handleDownloadSTL,
    scad: handleDownloadOpenSCAD,
    dxf: handleDownloadDXF,
    step: handleDownloadSTEP,
    obj: handleDownloadOBJ,
  };
  const formatAvailable: Record<DownloadFormat, boolean> = {
    stl: !!currentOutput,
    scad: !!(artifactCode ?? currentMessage?.content.artifact?.code),
    dxf: !!dxfExporter && !isExporting,
    step: !!currentOutput && !isExporting,
    obj: !!currentOutput && !isExporting,
  };

  const handleDownload = async () => {
    await downloadHandlers[selectedFormat]();
  };
  const isDownloadDisabled = !formatAvailable[selectedFormat];
  // Keep the format menu available when any download format has content.
  const isAnyFormatAvailable = Object.values(formatAvailable).some(Boolean);

  return (
    <div className="h-full w-full max-w-full border-l border-gray-200/20 bg-adam-bg-secondary-dark dark:border-gray-800">
      <div className="flex h-14 items-center justify-between border-b border-adam-neutral-700 bg-gradient-to-r from-adam-bg-secondary-dark to-adam-bg-secondary-dark/95 px-6 py-6">
        <div className="flex items-center gap-2">
          <span className="text-lg font-semibold tracking-tight text-adam-text-primary">
            Parameters
          </span>
        </div>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                className="h-8 w-8 rounded-full p-0 text-adam-text-primary transition-colors [@media(hover:hover)]:hover:bg-adam-neutral-950 [@media(hover:hover)]:hover:text-adam-neutral-10"
                disabled={parameters.length === 0 || editingDisabled}
                onClick={() => {
                  const newParameters = parameters.map((param) => ({
                    ...param,
                    value: param.defaultValue,
                  }));
                  onSubmit(currentMessage, newParameters);
                }}
              >
                <RefreshCcw className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Reset all parameters</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="flex h-[calc(100%-3.5rem)] flex-col justify-between overflow-hidden">
        <ScrollArea className="flex-1 px-6 py-6">
          {editingDisabled && (
            <div className="mb-4 rounded-md border border-adam-neutral-700 bg-adam-neutral-900/60 px-3 py-2 text-[11px] leading-snug text-adam-neutral-300">
              Viewing {versionLabel ?? 'an older version'} — switch to the
              latest version to edit parameters.
            </div>
          )}
          <DesignTreeViewer
            nodes={designTree.nodes}
            warnings={designTree.warnings}
            selectedNodeId={selectedNode?.id ?? null}
            onSelectNode={setSelectedNodeId}
          />
          <div
            className={cn(
              'flex flex-col gap-3',
              editingDisabled && 'pointer-events-none opacity-60',
            )}
          >
            {parameterGroups.map((group, index) => (
              <ParameterGroupControls
                key={group.name}
                name={group.name}
                parameters={group.parameters}
                separated={index > 0}
                handleCommit={handleCommit}
              />
            ))}
            {selectedNode?.params?.length && visibleParameters.length === 0 ? (
              <p className="rounded-md bg-adam-neutral-900/60 px-3 py-2 text-[11px] text-adam-neutral-400">
                This tree item has no editable controls.
              </p>
            ) : null}
          </div>
        </ScrollArea>
        <div className="flex flex-col gap-4 border-t border-adam-neutral-700 px-6 py-6">
          <div className="flex">
            <Button
              onClick={handleDownload}
              disabled={isDownloadDisabled}
              aria-label={`download ${selectedFormat.toUpperCase()} file`}
              className="h-12 flex-1 rounded-r-none bg-adam-neutral-50 text-adam-neutral-800 hover:bg-adam-neutral-100 hover:text-adam-neutral-900"
            >
              {isExporting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-2 h-4 w-4" />
              )}
              {selectedFormat.toUpperCase()}
            </Button>
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <DropdownMenuTrigger asChild>
                      <Button
                        disabled={!isAnyFormatAvailable}
                        aria-label="select download format"
                        className="h-12 w-12 rounded-l-none border-l border-adam-neutral-300 bg-adam-neutral-50 p-0 text-adam-neutral-800 hover:bg-adam-neutral-100 hover:text-adam-neutral-900"
                      >
                        <ChevronUp className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Select download format</p>
                </TooltipContent>
              </Tooltip>
              <DropdownMenuContent
                align="end"
                className="w-64 border-none bg-adam-neutral-800 shadow-md"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedFormat('stl')}
                  disabled={!formatAvailable.stl}
                  className="cursor-pointer text-adam-text-primary"
                >
                  <span className="text-sm">.STL</span>
                  <span className="ml-3 text-xs text-adam-text-primary/60">
                    3D Printing
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setSelectedFormat('scad')}
                  disabled={!formatAvailable.scad}
                  className="cursor-pointer text-adam-text-primary"
                >
                  <span className="text-sm">.SCAD</span>
                  <span className="ml-3 text-xs text-adam-text-primary/60">
                    OpenSCAD Code
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setSelectedFormat('dxf')}
                  disabled={!formatAvailable.dxf}
                  className="cursor-pointer text-adam-text-primary"
                >
                  <span className="text-sm">.DXF</span>
                  <span className="ml-3 text-xs text-adam-text-primary/60">
                    2D Projection to the (x,y) plane
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setSelectedFormat('step')}
                  disabled={!formatAvailable.step}
                  className="cursor-pointer text-adam-text-primary"
                >
                  <span className="text-sm">.STEP</span>
                  <span className="ml-3 text-xs text-adam-text-primary/60">
                    CAD Exchange
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setSelectedFormat('obj')}
                  disabled={!formatAvailable.obj}
                  className="cursor-pointer text-adam-text-primary"
                >
                  <span className="text-sm">.OBJ</span>
                  <span className="ml-3 text-xs text-adam-text-primary/60">
                    3D Mesh
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    </div>
  );
}
