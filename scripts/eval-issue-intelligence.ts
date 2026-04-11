import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Issue } from "@paperclipai/plugin-sdk";
import {
  analyzeIssueIntents,
  hasIntent,
  issueHeadline,
  issueRecommendedMove,
  type IssueActorDirectory,
  type LatestComment,
} from "../src/aperture/issue-intelligence.js";

type CorpusFixture = {
  name: string;
  issue: {
    id: string;
    identifier: string;
    title: string;
    description: string;
    status: Issue["status"];
  };
  comment?: string;
  directory?: IssueActorDirectory;
  expected: {
    intents: string[];
    owner?: string;
    blockingTarget?: string;
    recommendedMove?: string;
    headline?: string;
  };
};

function createIssue(input: CorpusFixture["issue"]): Issue {
  return {
    id: input.id,
    companyId: "company-eval",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: input.title,
    description: input.description,
    status: input.status,
    priority: "high",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    identifier: input.identifier,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-04-11T00:00:00.000Z"),
    updatedAt: new Date("2026-04-11T00:00:00.000Z"),
  };
}

function createComment(body?: string): LatestComment {
  return body
    ? {
        body,
        updatedAt: "2026-04-11T00:05:00.000Z",
      }
    : null;
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const fixturePath = resolve(scriptDir, "../tests/fixtures/issue-intelligence-corpus.json");
  const fixtures = JSON.parse(await readFile(fixturePath, "utf8")) as CorpusFixture[];

  const failures: string[] = [];

  for (const fixture of fixtures) {
    const issue = createIssue(fixture.issue);
    const comment = createComment(fixture.comment);
    const analysis = analyzeIssueIntents(issue, comment, fixture.directory);
    const recommendedMove = issueRecommendedMove(issue, analysis);
    const headline = issueHeadline(issue, analysis);

    for (const intent of fixture.expected.intents) {
      if (!hasIntent(analysis, intent as never)) {
        failures.push(`${fixture.name}: missing intent ${intent}`);
      }
    }

    if (fixture.expected.owner && analysis.owner !== fixture.expected.owner) {
      failures.push(`${fixture.name}: expected owner ${fixture.expected.owner}, got ${analysis.owner ?? "null"}`);
    }

    if (fixture.expected.blockingTarget && analysis.blockingTarget !== fixture.expected.blockingTarget) {
      failures.push(`${fixture.name}: expected blocking target ${fixture.expected.blockingTarget}, got ${analysis.blockingTarget ?? "null"}`);
    }

    if (fixture.expected.recommendedMove && recommendedMove !== fixture.expected.recommendedMove) {
      failures.push(`${fixture.name}: expected move "${fixture.expected.recommendedMove}", got "${recommendedMove ?? "null"}"`);
    }

    if (fixture.expected.headline && headline !== fixture.expected.headline) {
      failures.push(`${fixture.name}: expected headline "${fixture.expected.headline}", got "${headline}"`);
    }
  }

  if (failures.length > 0) {
    console.error("Issue intelligence eval failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(`Issue intelligence eval passed (${fixtures.length}/${fixtures.length} fixtures)`);
}

await main();
