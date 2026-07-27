/**
 * Design-agent print constraints, shown as checkboxes in the agent composer.
 *
 * Persisted on `conversations.settings` (not on individual messages) so the
 * agent-chat edge function reads them on every turn — including replayed and
 * branched history — and so they survive the handoff to a generation pipeline.
 */

export type AgentPrintOptions = {
  /** Hold the design to FDM-printability rules. */
  threeDPrint: boolean;
  /** Require a single flat planar underside, and cut the model flat there. */
  flatBottom: boolean;
};

export const DEFAULT_AGENT_PRINT_OPTIONS: AgentPrintOptions = {
  // On by default: matches the mesh composer's "3D print" default and the
  // printability rules the agent shipped with.
  threeDPrint: true,
  // Off by default: it removes geometry, so it should be a deliberate choice.
  flatBottom: false,
};

/**
 * Read the options off a conversation's settings. Conversations created before
 * the options existed have neither key, and must keep behaving as they did.
 */
export function readAgentPrintOptions(
  settings: { threeDPrint?: boolean; flatBottom?: boolean } | null | undefined,
): AgentPrintOptions {
  return {
    threeDPrint: settings?.threeDPrint !== false,
    flatBottom: settings?.flatBottom === true,
  };
}
