import {
  View,
  useMemo,
  useState,
  useViewTypeTool,
  type OperationResult,
} from "@aotui/sdk";
import {
  mapWorkspaceFileCreationResult,
  type WorkspaceFileCreator,
} from "../core/conditional-file-create.js";
export interface WorkspaceCreateViewProps {
  readonly viewId: string;
  readonly workspaceLabel: string;
  readonly creator: WorkspaceFileCreator;
  readonly isCurrent?: () => boolean;
}
function resultText(result: OperationResult): string {
  const fields = Object.getOwnPropertyDescriptors(result);
  const lines =
    typeof fields.success?.value === "boolean"
      ? [`success: ${fields.success.value}`]
      : [];
  if (typeof fields.effects?.value === "string")
    lines.push(`effects: ${fields.effects.value}`);
  const error = fields.error?.value;
  if (error && typeof error === "object") {
    const details = Object.getOwnPropertyDescriptors(error);
    for (const key of ["code", "message"] as const) {
      if (typeof details[key]?.value === "string")
        lines.push(`${key}: ${details[key]!.value}`);
    }
  }
  const data = fields.data?.value;
  if (data && typeof data === "object") {
    const metadata = Object.getOwnPropertyDescriptors(data);
    if (typeof metadata.filePath?.value === "string")
      lines.push(`filePath: ${metadata.filePath.value}`);
    if (
      typeof metadata.bytesWritten?.value === "number" &&
      Number.isFinite(metadata.bytesWritten.value)
    )
      lines.push(`bytesWritten: ${metadata.bytesWritten.value}`);
  }
  return (
    lines.join("\n") || "Consult the operation receipt for the outcome"
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
        const result = mapWorkspaceFileCreationResult(await creator(input));
        try {
          if (!isCurrent || isCurrent()) setLast(resultText(result));
        } catch {
          /* Display failure cannot undo the known file outcome. */
        }
        return result;
      },
    [creator, isCurrent],
  );
  const [CreateTool] = useViewTypeTool(
    "create_file_if_absent",
    {
      description:
        "Create a new workspace file with the supplied relative path and exact text. Its parent must already exist, and existing files are never overwritten. Inspect the receipt before retrying an uncertain result.",
      params,
    },
    create,
  );
  return (
    <section>
      <h2>Workspace: {workspaceLabel}</h2>
      <p>
        Create one new file using an exact relative path and content. Read the
        receipt here; uncertain completion must not be retried automatically.
      </p>
      <CreateTool>Create file</CreateTool>
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
