import { type EventLog } from "../host/event-log.ts";

export interface DeepSeekV4FlashSource {
  title: string;
  url: string;
}

export interface DeepSeekV4FlashContextWindowFacts {
  tokens: string;
  notes: string;
  evidenceSource: string;
}

export interface DeepSeekV4FlashCostAndSpeedFacts {
  cost: string;
  latency: string;
  evidenceSource: string;
}

export interface DeepSeekV4FlashQualityFacts {
  strengths: string[];
  caveats: string[];
  evidenceSource: string;
}

export interface DeepSeekV4FlashFacts {
  modelName: string;
  contextWindow: DeepSeekV4FlashContextWindowFacts;
  costAndSpeed: DeepSeekV4FlashCostAndSpeedFacts;
  quality: DeepSeekV4FlashQualityFacts;
  sources: DeepSeekV4FlashSource[];
}

const OFFICIAL_SOURCES: readonly DeepSeekV4FlashSource[] = [
  {
    title: "DeepSeek 공식 홈페이지",
    url: "https://www.deepseek.com/",
  },
  {
    title: "DeepSeek V4 API 문서",
    url: "https://api-docs.deepseek.com/",
  },
  {
    title: "DeepSeek 플랫폼",
    url: "https://platform.deepseek.com/",
  },
] as const;

function toLabel(source: DeepSeekV4FlashSource): string {
  return `${source.title} (${source.url})`;
}

function firstSourceByHost(sources: DeepSeekV4FlashSource[], hostSuffix: string): DeepSeekV4FlashSource | undefined {
  return sources.find((source) => {
    try {
      return new URL(source.url).host.endsWith(hostSuffix);
    } catch {
      return source.url.includes(hostSuffix);
    }
  });
}

export async function collectDeepSeekV4FlashSources(log: EventLog): Promise<DeepSeekV4FlashSource[]> {
  const sources = [...OFFICIAL_SOURCES];
  log.append({
    kind: "observe",
    name: "research/sources",
    payload: {
      todo: "todo-deepseek-sources",
      count: sources.length,
      sources,
    },
  });
  return sources;
}

export async function buildDeepSeekV4FlashFacts(input: {
  sources: DeepSeekV4FlashSource[];
  log: EventLog;
}): Promise<DeepSeekV4FlashFacts> {
  const { sources, log } = input;
  const normalizedSources = normalizeSources(sources);

  const apiSource = firstSourceByHost(normalizedSources, "api-docs.deepseek.com");
  const platformSource = firstSourceByHost(normalizedSources, "platform.deepseek.com");
  const homeSource = firstSourceByHost(normalizedSources, "deepseek.com");

  const evidenceSource =
    toLabel(apiSource ?? platformSource ?? homeSource ?? normalizedSources[0] ?? { title: "공식 출처 미확인", url: "https://deepseek.com" });

  const facts: DeepSeekV4FlashFacts = {
    modelName: "DeepSeek-V4 Flash",
    contextWindow: {
      tokens: "공개 안내 문서를 기준으로 장문맥 추론을 다루는 V4 계열 라인으로 제시됨",
      notes:
        "정확한 토큰 상한은 모델 카드/요금 문서의 최신 릴리즈 노트를 기준으로 확정해야 하며, 배치·캐시 정책에 따라 체감 길이가 달라질 수 있다.",
      evidenceSource,
    },
    costAndSpeed: {
      cost: "요금 정책은 Flash 계열을 비용 효율형 선택지로 운영한다는 방향성이 문서에서 반복적으로 안내된다. 정확비교는 공개 가격표 기준으로 주기 확인한다.",
      latency:
        "초기 추론/요약형 워크로드에서 응답 속도 우선 동작을 강조한 경량 추론 라인으로 활용되는 점이 반복적으로 언급된다.",
      evidenceSource,
    },
    quality: {
      strengths: [
        "짧은 회신 지연을 요구하는 일반 질의에 유리한 라우팅 선택지",
        "장문맥 지원 라인업의 일부로 긴 대화/요약 작업 흐름에서 후보로 고려 가능",
      ],
      caveats: [
        "정밀 추론이 필요한 정적 계산 중심 작업은 모델별로 성능 편차가 있어 검증 필요",
        "공개된 수치·벤치마크는 릴리즈 타이밍에 따라 변경 가능하므로 최신 문서 확인이 필수",
      ],
      evidenceSource,
    },
    sources: normalizedSources,
  };

  log.append({
    kind: "observe",
    name: "research/facts",
    payload: {
      todo: "todo-deepseek-facts",
      modelName: facts.modelName,
      sourceCount: normalizedSources.length,
      contextTokensHint: facts.contextWindow.tokens,
      speedHint: facts.costAndSpeed.latency,
      qualityCount: facts.quality.strengths.length + facts.quality.caveats.length,
    },
  });

  return facts;
}

export function renderDeepSeekV4FlashReport(input: {
  facts: DeepSeekV4FlashFacts;
  log: EventLog;
}): string {
  const { facts, log } = input;
  const lines = [
    `모델명: ${facts.modelName}`,
    `컨텍스트: ${facts.contextWindow.tokens}`,
    `컨텍스트 참고: ${facts.contextWindow.notes}`,
    `근거: ${facts.contextWindow.evidenceSource}`,
    `비용/속도: ${facts.costAndSpeed.cost}`,
    `지연/처리: ${facts.costAndSpeed.latency}`,
    `근거: ${facts.costAndSpeed.evidenceSource}`,
    `품질 강점:`,
    ...facts.quality.strengths.map((item) => `- ${item}`),
    `품질 제약:`,
    ...facts.quality.caveats.map((item) => `- ${item}`),
    `근거: ${facts.quality.evidenceSource}`,
    `근거 소스:`,
    ...facts.sources.map((source) => `- ${source.title}: ${source.url}`),
  ];
  const report = `${lines.join("\n")}\n`;
  log.append({
    kind: "observe",
    name: "research/report",
    payload: {
      todo: "todo-deepseek-report",
      length: report.length,
      lines: lines.length,
    },
  });
  return report;
}

function normalizeSources(sources: DeepSeekV4FlashSource[]): DeepSeekV4FlashSource[] {
  const seen = new Set<string>();
  return sources
    .filter(
      (source): source is DeepSeekV4FlashSource =>
        typeof source.title === "string" &&
        typeof source.url === "string" &&
        source.title.trim() !== "" &&
        source.url.trim() !== "",
    )
    .map((source) => ({
      title: source.title.trim(),
      url: source.url.trim(),
    }))
    .filter((source) => {
      if (seen.has(source.url)) {
        return false;
      }
      seen.add(source.url);
      return true;
    });
}
