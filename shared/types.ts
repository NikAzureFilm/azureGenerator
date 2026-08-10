import type { Database } from './database.ts';
import type { ImageGenerationModel } from './imageGeneration.ts';
export type Model = string;
export type CreativeModel = 'quality' | 'fast' | 'ultra' | 'multiview';
export const DEFAULT_CREATIVE_MODEL: CreativeModel = 'ultra';

export function normalizeCreativeModel(model: unknown): CreativeModel {
  return model === 'multiview' ? 'multiview' : DEFAULT_CREATIVE_MODEL;
}

export type MultiviewSlot = 'front' | 'back' | 'left' | 'right';

export type MultiviewImages = Partial<Record<MultiviewSlot, string>>;

export type SemanticMaterialClass = {
  id: number;
  name: string;
  color: string;
};

export type SemanticMaterialMap = {
  classes: SemanticMaterialClass[];
  triangleMaterialIds?: number[];
};

export type Prompt = {
  text?: string;
  images?: string[];
  mesh?: string;
  model?: Model;
  multiviewImages?: MultiviewImages;
  semanticMaterialMap?: SemanticMaterialMap;
  // The generation was asked for a flat underside. Recorded on the mesh row so
  // the viewer/exports know to apply the planar bottom cut, and so re-runs and
  // upscales inherit the choice.
  flatBottom?: boolean;
};

export type Message = Omit<
  Database['public']['Tables']['messages']['Row'],
  'content' | 'role'
> & {
  role: 'user' | 'assistant';
  content: Content;
};

export type CoreMessage = Pick<Message, 'id' | 'role' | 'content'>;

export type MeshFileType = Database['public']['Enums']['mesh_file_type'];

export type Mesh = {
  id: string;
  fileType: MeshFileType;
};

export type CadBackend = 'openscad' | 'text-to-cad';

// Generation pipelines the design agent can hand a conversation off to.
export type AgentPipeline = 'cad' | 'mesh' | 'multiview';

export const AGENT_PIPELINES: AgentPipeline[] = ['cad', 'mesh', 'multiview'];

export function normalizeAgentPipeline(value: unknown): AgentPipeline | null {
  return AGENT_PIPELINES.includes(value as AgentPipeline)
    ? (value as AgentPipeline)
    : null;
}

// Written by the agent-chat recommend_pipeline tool onto assistant messages.
// The client shows a Generate panel for the latest recommendation and uses
// generationPrompt (plus the last concept image) to seed the handoff.
export type AgentRecommendation = {
  pipeline: AgentPipeline;
  reason?: string;
  generationPrompt?: string;
};

// Written by the agent-chat ask_user tool. The client renders the options as
// tap-able buttons on the latest assistant message; a tap sends the option
// text as a regular user message, and the composer stays available for a
// custom ("other") answer.
export type AgentQuestion = {
  text: string;
  options: string[];
};

export type CadJobArtifact = {
  stepPath?: string;
  glbPath?: string;
  stlPath?: string;
  threeMfPath?: string;
  sourcePath?: string;
};

export type CadJob = {
  id: string;
  status: GenerationStatus;
  backend: 'text-to-cad';
  artifacts?: CadJobArtifact;
  error?: string;
};

export type MeshData = Omit<
  Database['public']['Tables']['meshes']['Row'],
  'prompt'
> & {
  prompt: Prompt;
};

export type ToolCall = {
  name: string;
  status: 'pending' | 'error';
  id?: string;
  result?: { id: string; fileType?: MeshFileType };
};

export type Content = {
  text?: string;
  model?: Model;
  // When the user sends an error, its related to the fix with AI function
  // When the assistant sends an error, its related to any error that occurred during generation
  error?: string;
  artifact?: ParametricArtifact;
  // Prior artifact versions kept when the self-inspection loop revises code, so
  // the user can view/download the pre-revision models. Oldest first; the live
  // `artifact` is the latest. Absent on old messages and single-version rows.
  artifactHistory?: ParametricArtifact[];
  index?: number;
  images?: string[];
  mesh?: Mesh;
  // Parametric mode: bounding box dimensions from STL parsing
  meshBoundingBox?: { x: number; y: number; z: number };
  // Parametric mode: original filename for import() in OpenSCAD
  meshFilename?: string;
  suggestions?: string[];
  // For streaming support - shows in-progress tool calls
  toolCalls?: ToolCall[];
  // Mesh topology preference (quads vs polys) for quality model
  meshTopology?: 'quads' | 'polys';
  // Polygon count preference for quality model
  polygonCount?: number;
  // File format preference for quad topology models
  preferredFormat?: 'glb' | 'fbx';
  // 4-slot labeled images for the 'multiview' model (front/back/left/right)
  multiviewImages?: MultiviewImages;
  // Optional semantic material classes/triangle ids used by 3MF export.
  semanticMaterialMap?: SemanticMaterialMap;
  // Image provider used when creating seed/reference images for mesh generation.
  imageGenerationModel?: ImageGenerationModel;
  // "Flat bottom" option: the model must rest on a single flat planar
  // underside. Drives both the generation prompt and the planar bottom cut
  // applied to the resulting geometry.
  flatBottom?: boolean;
  // Parametric CAD backend. Omitted or "openscad" keeps the existing flow.
  cadBackend?: CadBackend;
  // STEP-first CAD jobs generated by the optional text-to-CAD worker.
  cadJob?: CadJob;
  // Agentic generation loop state. Present only on parametric assistant
  // messages produced by the auto-repair / visual-inspection loop. Absent on
  // all historical messages, which are therefore treated as final.
  loop?: LoopState;
  // Design-agent pipeline recommendation (agent mode only).
  recommendation?: AgentRecommendation;
  // Design-agent clarifying question with tap-able options (agent mode only).
  question?: AgentQuestion;
};

// Tier that drives which loop rounds are available: premium (Fable) gets the
// visual inspection loop; lite (Gemini Flash) only gets compile auto-repair.
export type LoopTier = 'premium' | 'lite';

// `awaiting_client` / `reviewing` are transient in-loop states; `final` and
// `failed` are terminal. A persisted loop must never remain non-terminal once
// the loop stops driving (see the parametric-chat continuation handler).
export type LoopStatus =
  | 'generating'
  | 'awaiting_client'
  | 'reviewing'
  | 'final'
  | 'failed';

export type LoopState = {
  // Completed generation rounds. Round 0 is the initial generation; each
  // accepted visual revision increments it.
  round: number;
  // Max inspection rounds. 6 for premium, 0 for lite (no inspection).
  maxRounds: number;
  // Compile-error repair rounds used so far (shared cap across tiers).
  repairs: number;
  status: LoopStatus;
  tier: LoopTier;
};

export type ParametricArtifact = {
  title: string;
  version: string;
  code: string;
  parameters: Parameter[];
  suggestions?: string[];
};

// Label is optional for bare OpenSCAD customizer options like
// `[Assembled, Exploded]`; the UI falls back to the value.
export type ParameterOption = { value: string | number; label?: string };

export type ParameterRange = { min?: number; max?: number; step?: number };

export type ParameterType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'string[]'
  | 'number[]'
  | 'boolean[]';

export type Parameter = {
  name: string;
  displayName: string;
  value: string | boolean | number | string[] | number[] | boolean[];
  defaultValue: string | boolean | number | string[] | number[] | boolean[];
  // Type should always exist, but old messages don't have it.
  type?: ParameterType;
  description?: string;
  group?: string;
  unit?: string;
  range?: ParameterRange;
  options?: ParameterOption[];
  maxLength?: number;
};

// Optional model-authored presentation metadata. The OpenSCAD variable remains
// the source of truth for the parameter's existence, type, and current value;
// these fields make the generated controls predictable and human-friendly.
export type ParameterSpec = {
  name: string;
  label?: string;
  type?: 'number' | 'string' | 'boolean';
  description?: string;
  group?: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: ParameterOption[];
};

export type DesignTreeNodeKind = 'part' | 'operation' | 'group' | 'parameter';

export type DesignTreeNode = {
  id: string;
  kind: DesignTreeNodeKind;
  name: string;
  parentId?: string;
  params?: string[];
  moduleName?: string;
};

export type DesignTreeParseWarning = {
  code:
    | 'invalid-json'
    | 'missing-id'
    | 'missing-kind'
    | 'duplicate-id'
    | 'unknown-kind'
    | 'invalid-param-entry'
    | 'missing-parent'
    | 'circular-parent';
  message: string;
  line: number;
  raw: string;
  id?: string;
  kind?: string;
  parentId?: string;
};

export type DesignTreeParseResult = {
  nodes: DesignTreeNode[];
  warnings: DesignTreeParseWarning[];
};

export type Conversation = Omit<
  Database['public']['Tables']['conversations']['Row'],
  'settings'
> & {
  settings: ConversationSettings;
};

export type GenerationStatus = Database['public']['Enums']['generation-status'];

export type ConversationSettings = {
  model?: Model;
  imageGenerationModel?: ImageGenerationModel;
  // Draft multiview slot→image mapping, persisted as views are generated or
  // uploaded so a reload before submit rehydrates them.
  multiviewImages?: MultiviewImages;
  // Design-agent print options, persisted on the conversation so they survive
  // history replay, retries and the handoff to a generation pipeline.
  // `threeDPrint` asks the agent to keep designs FDM-printable; `flatBottom`
  // additionally requires a single flat planar underside.
  threeDPrint?: boolean;
  flatBottom?: boolean;
  // 'agent' while the conversation is in the design-agent ideation phase.
  // Removed when the user clicks Generate and the conversation graduates to
  // a normal creative/parametric conversation. The conversations.type column
  // stays 'creative' during the agent phase (no enum migration needed).
  mode?: 'agent';
} | null;

export type Profile = Database['public']['Tables']['profiles']['Row'];
