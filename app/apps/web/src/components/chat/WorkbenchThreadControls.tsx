import { Fragment, type ComponentProps } from "react";
import { WorkbenchContextBar } from "./WorkbenchContextBar";
import { WorkbenchWorkModeControl } from "./WorkbenchWorkModeControl";
import { WorkbenchBranchesBar } from "./WorkbenchBranchesBar";
import { WorkbenchResumeControl } from "./WorkbenchResumeControl";

type Props = Pick<
  ComponentProps<typeof WorkbenchBranchesBar>,
  "environmentId" | "threadId" | "providerInstanceId" | "createBranchTarget" | "onOpenChildThread"
> &
  Pick<ComponentProps<typeof WorkbenchContextBar>, "onOpenGraph" | "onOpenRecord" | "onOpenCode">;

/** Controls share one conversation owner; timeline and composer stay outside
 * this group's lifetime so an owner switch cannot discard their state. */
export function WorkbenchThreadControls(props: Props) {
  const { environmentId, threadId, providerInstanceId } = props;
  const scopeKey = JSON.stringify([environmentId, threadId, providerInstanceId ?? null]);
  return (
    <Fragment key={scopeKey}>
      <WorkbenchContextBar
        key="overview"
        environmentId={environmentId}
        threadId={threadId}
        providerInstanceId={providerInstanceId}
        onOpenGraph={props.onOpenGraph}
        onOpenRecord={props.onOpenRecord}
        onOpenCode={props.onOpenCode}
      />
      <WorkbenchWorkModeControl
        key="work-mode"
        environmentId={environmentId}
        threadId={threadId}
        providerInstanceId={providerInstanceId}
      />
      <WorkbenchBranchesBar
        key="branches"
        environmentId={environmentId}
        threadId={threadId}
        providerInstanceId={providerInstanceId}
        visible
        createBranchTarget={props.createBranchTarget}
        onOpenChildThread={props.onOpenChildThread}
      />
      <WorkbenchResumeControl
        key="resume"
        environmentId={environmentId}
        threadId={threadId}
        providerInstanceId={providerInstanceId}
      />
    </Fragment>
  );
}
