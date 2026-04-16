import type {
  ExecutionMode,
  RunVariant,
  Settings,
  WorkItemStatus,
} from "@superman/shared-types";

export const DEFAULT_SETTINGS: Settings = {
  defaultModel: "gpt-5.4",
  defaultSandboxPolicy: "workspace-write",
  defaultApprovalPolicy: "on-request",
  defaultNetworkEnabled: false,
  defaultParallelRuns: 1,
  trayNotificationStyle: "urgent_only",
  codexEndpoint: "ws://127.0.0.1:4500",
  simulatorFallback: true,
};

export const DEFAULT_WORK_ITEM_STATUS: WorkItemStatus = "running";

export function buildRunPlan(mode: ExecutionMode): Array<{
  label: string;
  variant: RunVariant;
}> {
  switch (mode) {
    case "parallel_compare":
      return [
        { label: "Variant A - implementation-first", variant: "variant_a" },
        { label: "Variant B - test-first", variant: "variant_b" },
      ];
    case "parallel_explore":
      return [
        { label: "Investigator", variant: "investigator" },
        { label: "Primary builder", variant: "primary" },
        { label: "Validator", variant: "validator" },
      ];
    case "single":
    default:
      return [{ label: "Primary run", variant: "primary" }];
  }
}
