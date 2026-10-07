export type RemoteLocale = "en" | "ko";

export type RemoteMessages = Readonly<{
  accepted: string;
  attached: string;
  cancelled: string;
  cancelIdle: string;
  cancelRunning: string;
  failed: string;
  statusIdle: string;
  statusRunning: string;
  workComplete: string;
}>;

const catalogs: Readonly<Record<RemoteLocale, RemoteMessages>> = {
  en: {
    accepted: "I've received your request and I'm checking it now.",
    attached: "I've passed that along to the current task.",
    cancelled: "The task was cancelled.",
    cancelIdle: "There isn't an active task to cancel.",
    cancelRunning: "I've cancelled the current task.",
    failed: "I couldn't complete the request. Please try again shortly.",
    statusIdle: "I'm currently idle.",
    statusRunning: "I'm currently working on a request.",
    workComplete: "The work is complete.",
  },
  ko: {
    accepted: "요청을 확인하고 있어요. 잠시만 기다려주세요.",
    attached: "말씀하신 내용을 진행 중인 작업에 전달했어요.",
    cancelled: "작업을 취소했어요.",
    cancelIdle: "취소할 작업이 없어요.",
    cancelRunning: "진행 중인 작업을 취소했어요.",
    failed: "작업을 완료하지 못했어요. 잠시 후 다시 시도해주세요.",
    statusIdle: "지금은 대기 중이에요.",
    statusRunning: "현재 작업을 처리하고 있어요.",
    workComplete: "작업을 마쳤어요.",
  },
};

export function resolveRemoteLocale(value?: string): RemoteLocale {
  return value?.trim().toLowerCase() === "ko" ? "ko" : "en";
}

export function remoteMessages(locale: RemoteLocale): RemoteMessages {
  return catalogs[locale];
}
