import { capabilityLoadText, isCapabilityId, type CapabilityId } from "./capabilities.js";
import { classifyAction, type PolicyDecision, type RiskTier } from "./policy.js";
import { redact } from "./redact.js";
import type { ToolOutcome } from "./tools.js";

export interface ToolCall {
  name: string;
  args: unknown;
}

export interface ApprovalRequest {
  tool: string;
  args: unknown;
  tier: RiskTier;
  reason: string;
}

export interface CoordinateInput {
  call: ToolCall;
  workspaceRoot: string | null;
  loaded: readonly CapabilityId[];
  approve: (request: ApprovalRequest) => Promise<boolean>;
  execute: (call: ToolCall) => Promise<ToolOutcome>;
  recordAudit: (event: {
    action: string;
    decision: "allow" | "deny" | "approve" | "reject";
    payload: unknown;
  }) => void;
}

export interface CoordinateResult extends ToolOutcome {
  loadedCapability?: CapabilityId;
}

function copyArgs(call: ToolCall): Record<string, unknown> | null {
  if (!call.args || typeof call.args !== "object" || Array.isArray(call.args)) return null;
  return { ...(call.args as Record<string, unknown>) };
}

/** Shown to the person approving. Long writes are truncated, not omitted. */
function previewArgs(call: ToolCall): unknown {
  const record = copyArgs(call);
  if (!record) return redact(call.args);
  if (typeof record.content === "string" && record.content.length > 500) {
    record.content = `${record.content.slice(0, 500)}…`;
  }
  if (typeof record.command === "string" && record.command.length > 500) {
    record.command = `${record.command.slice(0, 500)}…`;
  }
  return redact(record);
}

/** Stored in the hash chain. File bodies stay out of the log. */
function summarizeArgs(call: ToolCall): unknown {
  const record = copyArgs(call);
  if (!record) return redact(call.args);
  if (typeof record.content === "string") {
    record.content = { bytes: Buffer.byteLength(record.content) };
  }
  if (typeof record.command === "string" && record.command.length > 500) {
    record.command = `${record.command.slice(0, 500)}…`;
  }
  return redact(record);
}

function auditPayload(call: ToolCall, decision: PolicyDecision, extra?: Record<string, unknown>): unknown {
  return {
    tool: call.name,
    args: summarizeArgs(call),
    reason: decision.kind === "deny" ? decision.reason : decision.reason,
    tier: decision.kind === "deny" ? undefined : decision.tier,
    ...extra,
  };
}

/**
 * Main-process gate. The model may ask; only this function allows, asks the
 * user, or denies. The tool worker is reached only after allow or approve.
 */
export async function coordinateToolCall(input: CoordinateInput): Promise<CoordinateResult> {
  const decision = classifyAction({
    tool: input.call.name,
    args: input.call.args,
    workspaceRoot: input.workspaceRoot,
    loaded: input.loaded,
  });

  if (decision.kind === "deny") {
    input.recordAudit({
      action: input.call.name,
      decision: "deny",
      payload: auditPayload(input.call, decision),
    });
    return { ok: false, text: decision.reason };
  }

  if (decision.kind === "require_approval") {
    input.recordAudit({
      action: input.call.name,
      decision: "allow",
      payload: auditPayload(input.call, decision, { pending: true }),
    });
    const approved = await input.approve({
      tool: input.call.name,
      args: previewArgs(input.call),
      tier: decision.tier,
      reason: decision.reason,
    });
    if (!approved) {
      input.recordAudit({
        action: input.call.name,
        decision: "reject",
        payload: auditPayload(input.call, decision),
      });
      return { ok: false, text: "用户拒绝了该操作" };
    }
    input.recordAudit({
      action: input.call.name,
      decision: "approve",
      payload: auditPayload(input.call, decision),
    });
  } else {
    input.recordAudit({
      action: input.call.name,
      decision: "allow",
      payload: auditPayload(input.call, decision),
    });
  }

  if (input.call.name === "capability_load") {
    const args = input.call.args as { capability?: unknown };
    if (!isCapabilityId(args?.capability)) return { ok: false, text: "能力名称无效" };
    return { ok: true, text: capabilityLoadText(args.capability), loadedCapability: args.capability };
  }

  return input.execute(input.call);
}
