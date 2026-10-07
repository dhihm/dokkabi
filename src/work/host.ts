import { splitTodo } from "./decompose.ts";
import { driveWork } from "./drive.ts";
import { nextAction } from "./next.ts";
import { verifyPlan } from "./verify.ts";
import { viewPlan } from "./view.ts";

export function createWorkFacade() {
  return {
    view: viewPlan,
    next: nextAction,
    verify: verifyPlan,
    split: splitTodo,
    drive: driveWork,
  };
}

export type WorkFacade = ReturnType<typeof createWorkFacade>;
