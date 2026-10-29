import {
  View,
  useMemo,
  useState,
  experimental_useCreateIfAbsentTool,
  type CreateIfAbsentOutcome,
} from "@aotui/sdk";
import type { WorkspaceFileCreator } from "../core/conditional-file-create.js";
export interface WorkspaceCreateViewProps {
  readonly viewId: string;
  readonly workspaceLabel: string;
  readonly creator: WorkspaceFileCreator;
  readonly isCurrent?: () => boolean;
}
function resultText(outcome: CreateIfAbsentOutcome): string {
  const fields = Object.getOwnPropertyDescriptors(outcome);
  const lines = ["status", "code", "message", "effects"].flatMap((key) =>
    typeof fields[key]?.value === "string"
      ? [`${key}: ${fields[key]!.value}`]
      : [],
  );
  const value = fields.value?.value;
  if (value && typeof value === "object") {
    const data = Object.getOwnPropertyDescriptors(value);
    if (typeof data.filePath?.value === "string")
      lines.push(`filePath: ${data.filePath.value}`);
    if (
      typeof data.bytesWritten?.value === "number" &&
      Number.isFinite(data.bytesWritten.value)
    )
      lines.push(`bytesWritten: ${data.bytesWritten.value}`);
  }
  return (
    lines.join("\n") || "Consult the trusted creation receipt for the outcome"
  );
}
const params = {
  relativePath: {
    type: "string",
    required: true,
    desc: "Relative path in this workspace",
  },
  content: {
    type: "string",
    required: true,
    desc: "Exact UTF-8 text to create",
  },
} as const;
function WorkspaceCreateContent({
  workspaceLabel,
  creator,
  isCurrent,
}: Omit<WorkspaceCreateViewProps, "viewId">) {
  const [last, setLast] = useState<string | null>(null);
  const create = useMemo(
    () =>
      async (input: {
        readonly relativePath: string;
        readonly content: string;
      }) => {
        const outcome = await creator(input);
        try {
          if (!isCurrent || isCurrent()) setLast(resultText(outcome));
        } catch {
          /* Display failure cannot undo the known file outcome. */
        }
        return outcome;
      },
    [creator, isCurrent],
  );
  experimental_useCreateIfAbsentTool(
    "create_file_if_absent",
    {
      description:
        "Create a new file in this workspace. The parent must already exist; existing files are never overwritten.",
      params,
    },
    create,
  );
  return (
    <section>
      <h2>Workspace: {workspaceLabel}</h2>
      <p>
        Create one new file using an exact relative path and content. Read the
        result here; uncertain completion must not be retried automatically.
      </p>
      {last && (
        <>
          <h3>Last creation result</h3>
          <pre>{last}</pre>
        </>
      )}
    </section>
  );
}
export function WorkspaceCreateView({
  viewId,
  workspaceLabel,
  creator,
  isCurrent,
}: WorkspaceCreateViewProps) {
  return (
    <View
      id={viewId}
      type="WorkspaceCreate"
      name={`Workspace: ${workspaceLabel}`}
    >
      <WorkspaceCreateContent
        workspaceLabel={workspaceLabel}
        creator={creator}
        isCurrent={isCurrent}
      />
    </View>
  );
}
