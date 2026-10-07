import { type EventLog } from "../host/event-log.ts";

export interface KrakenIssueComment {
  author: string;
  body: string;
}

export interface KrakenIssueSources {
  issueNumber: number;
  repository: string;
  title: string;
  state: string;
  labels: string[];
  url: string;
  body: string;
  comments: KrakenIssueComment[];
  relatedLinks: string[];
}

export interface KrakenIssueFacts {
  issueNumber: number;
  repository: string;
  title: string;
  state: string;
  rootCauseHint: string;
  affectedArea: string[];
  reproSteps: string[];
  evidence: string[];
}

export interface CollectKrakenIssueSourcesInput {
  repository: string;
  issueNumber: number;
  log: EventLog;
  offlineSource?: KrakenIssueSources;
}

export interface ExtractKrakenIssueFactsInput {
  issue: KrakenIssueSources;
  log: EventLog;
}

export interface RenderKrakenIssueReportInput {
  facts: KrakenIssueFacts;
  log: EventLog;
}

const ISSUE_HOST = "https://github.com";

function normalizeRepository(input: string): string {
  const value = input.trim();
  return value.startsWith("https://") ? value.replace(/^https:\/\//, "") : value;
}

function defaultIssueSource(repository: string, issueNumber: number): KrakenIssueSources {
  const repo = normalizeRepository(repository);
  const url = `${ISSUE_HOST}/${repo}/issues/${issueNumber}`;
  return {
    issueNumber,
    repository: repo,
    title: `Issue ${issueNumber}`,
    state: "open",
    labels: [],
    url,
    body: "",
    comments: [],
    relatedLinks: [],
  };
}

export async function collectKrakenIssueSources(input: CollectKrakenIssueSourcesInput): Promise<KrakenIssueSources> {
  const repository = normalizeRepository(input.repository);
  const issueNumber = Number.isFinite(input.issueNumber) ? Math.trunc(input.issueNumber) : 0;

  const issue: KrakenIssueSources = normalizeIssue(
    input.offlineSource && isLikelyOfflineMatch(input.offlineSource, repository, issueNumber)
      ? input.offlineSource
      : defaultIssueSource(repository, issueNumber),
  );

  input.log.append({
    kind: "observe",
    name: "research/issue_sources",
    payload: {
      todo: "todo-kraken-source-collect",
      issueNumber: issue.issueNumber,
      repository: issue.repository,
      title: issue.title,
      state: issue.state,
      labels: issue.labels,
      commentCount: issue.comments.length,
      url: issue.url,
    },
  });

  return issue;
}

export function extractKrakenIssueFacts(input: ExtractKrakenIssueFactsInput): KrakenIssueFacts {
  const issue = normalizeIssue(input.issue);
  const allText = [issue.title, issue.body, ...issue.comments.map((comment) => comment.body)].join("\n").toLowerCase();

  const rootCauseHint = inferRootCause(allText);
  const affectedArea = inferAffectedArea(allText);
  const reproSteps = inferReproSteps(issue.body);
  const evidence = [issue.url, ...issue.relatedLinks, ...issue.comments.map((comment) => comment.body)].filter((line) => line.trim().length > 0);

  const facts: KrakenIssueFacts = {
    issueNumber: issue.issueNumber,
    repository: issue.repository,
    title: issue.title,
    state: issue.state,
    rootCauseHint,
    affectedArea,
    reproSteps,
    evidence,
  };

  input.log.append({
    kind: "observe",
    name: "research/issue_facts",
    payload: {
      todo: "todo-kraken-facts-derive",
      issueNumber: issue.issueNumber,
      affectedArea: facts.affectedArea,
      reproStepCount: facts.reproSteps.length,
      evidenceCount: facts.evidence.length,
    },
  });

  return facts;
}

export function renderKrakenIssueReport(input: RenderKrakenIssueReportInput): string {
  const facts = input.facts;
  const seen = input.log.events.some(
    (event) =>
      event.name === "research/issue_report" &&
      event.payload.issueNumber === facts.issueNumber &&
      event.payload.repository === facts.repository,
  );

  const lines = [
    `${facts.repository} 이슈 #${facts.issueNumber}: ${facts.title}`,
    `상태: ${facts.state}`,
    `원인 추정: ${facts.rootCauseHint}`,
    `영향 영역: ${facts.affectedArea.join(", ")}`,
    "재현 단서:",
    ...facts.reproSteps.map((item) => `- ${item}`),
    "근거 항목:",
    ...facts.evidence.map((item) => `- ${item}`),
  ];
  const report = `${lines.join("\n")}\n`;

  if (!seen) {
    input.log.append({
      kind: "observe",
      name: "research/issue_report",
      payload: {
        todo: "todo-kraken-report-compose",
        repository: facts.repository,
        issueNumber: facts.issueNumber,
        state: facts.state,
        reportLength: report.length,
      },
    });
  }

  return report;
}

function inferRootCause(text: string): string {
  if (text.includes("cache key")) {
    return "캐시 키 직렬화 변경과 관련된 회귀 가능성이 가장 높다.";
  }
  if (text.includes("checkout") || text.includes("worktree") || text.includes("worktree")) {
    return "체크아웃/워크트리 경로 처리 과정에서 회귀가 의심된다.";
  }
  if (text.includes("timeout") || text.includes("broken pipe")) {
    return "네트워크/IO 타임아웃 경로에서 예외 처리 누락이 의심된다.";
  }
  return "본문·코멘트 내용이 불완전해 추가 로그 캡처가 필요하다.";
}

function inferAffectedArea(text: string): string[] {
  const areas = new Set<string>();
  if (text.includes("cache") || text.includes("serialization")) {
    areas.add("cache-key serialization");
  }
  if (text.includes("checkout") || text.includes("worktree")) {
    areas.add("git worktree/CI checkout");
  }
  if (text.includes("broken pipe") || text.includes("pipeline") || text.includes("ci")) {
    areas.add("CI pipeline transport");
  }
  if (areas.size === 0) {
    areas.add("build orchestration");
  }
  return [...areas];
}

function inferReproSteps(body: string): string[] {
  const lines = body
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const bullets = lines.filter((line) => /^[-*]\s+/.test(line) || /^\d+[.)]\s+/.test(line));
  if (bullets.length > 0) {
    return bullets.map((line) => line.replace(/^[-*]\s+|^\d+[.)]\s+/, "").trim());
  }

  if (lines.length > 0) {
    return lines;
  }

  return ["이슈 본문이 비어 있어 공식 재현 스텝은 미수집됨."];
}

function isLikelyOfflineMatch(source: KrakenIssueSources, repository: string, issueNumber: number): boolean {
  return source.repository.toLowerCase() === normalizeRepository(repository).toLowerCase() && source.issueNumber === issueNumber;
}

function normalizeIssue(source: KrakenIssueSources): KrakenIssueSources {
  return {
    issueNumber: Math.max(1, Number.isFinite(source.issueNumber) ? Math.trunc(source.issueNumber) : 1),
    repository: normalizeRepository(source.repository),
    title: source.title.trim() || `Issue ${source.issueNumber}`,
    state: (source.state || "open").trim().toLowerCase(),
    labels: dedupeList(source.labels),
    url: source.url.trim() || `${ISSUE_HOST}/${normalizeRepository(source.repository)}/issues/${source.issueNumber}`,
    body: source.body.trim(),
    comments: [...source.comments].map((comment) => ({
      author: comment.author.trim(),
      body: comment.body.trim(),
    })),
    relatedLinks: dedupeList(source.relatedLinks),
  };
}

function dedupeList(values: string[]): string[] {
  const seen = new Set<string>();
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .filter((value) => {
      if (seen.has(value)) {
        return false;
      }
      seen.add(value);
      return true;
    });
}
