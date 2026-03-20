import { mkdtemp, mkdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);

const BASE_URL = process.env.PAPERCLIP_BASE_URL ?? "http://127.0.0.1:3100";
const OUTPUT_DIR = join(process.cwd(), "docs", "assets");
const MP4_PATH = join(OUTPUT_DIR, "focus-demo.mp4");
const GIF_PATH = join(OUTPUT_DIR, "focus-demo.gif");
const POSTER_PATH = join(OUTPUT_DIR, "focus-demo-poster.png");

const CAPTURE_INTERVAL_MS = 500;
const TOTAL_DURATION_MS = 50_000;
const ACTION_DELAY_MS = 1_200;

type Company = {
  id: string;
  name: string;
  issuePrefix: string;
};

type Issue = {
  id: string;
  identifier: string;
  title: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireIssue(issue: Issue | null, context: string): Issue {
  if (!issue) throw new Error(context);
  return issue;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} failed (${response.status})`);
  }

  return response.json() as Promise<T>;
}

async function createCompany(name: string): Promise<Company> {
  return api<Company>("/api/companies", {
    method: "POST",
    body: JSON.stringify({
      name,
      description: "Automated demo company for the Paperclip Aperture live attention walkthrough.",
    }),
  });
}

async function listCompanies(): Promise<Company[]> {
  return api<Company[]>("/api/companies");
}

async function deleteCompany(companyId: string): Promise<void> {
  await api(`/api/companies/${companyId}`, { method: "DELETE" });
}

async function createIssue(
  companyId: string,
  input: {
    title: string;
    description: string;
    status: string;
    priority: string;
  },
): Promise<Issue> {
  return api<Issue>(`/api/companies/${companyId}/issues`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

async function addIssueComment(issueId: string, body: string): Promise<void> {
  await api(`/api/issues/${issueId}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

async function createBudgetApproval(companyId: string, issue: Issue): Promise<void> {
  await api(`/api/companies/${companyId}/approvals`, {
    method: "POST",
    body: JSON.stringify({
      type: "budget_override_required",
      issueIds: [issue.id],
      payload: {
        title: `Approve launch budget override for ${issue.identifier}`,
        summary: "Budget controls are blocking the final launch validation pass.",
        requestedAmount: "$2,500",
        reason: "Need a short override to finish the staging verification and budget mitigation plan.",
        decisionContext: `Allow the team to finish launch readiness work tied to ${issue.identifier}.`,
      },
    }),
  });
}

async function createHireApproval(companyId: string, issue: Issue): Promise<void> {
  await api(`/api/companies/${companyId}/approvals`, {
    method: "POST",
    body: JSON.stringify({
      type: "hire_agent",
      issueIds: [issue.id],
      payload: {
        title: `Hire Launch QA Agent for ${issue.identifier}`,
        name: "Launch QA Agent",
        role: "operator",
        adapterType: "codex_local",
        capabilities: "Validate launch readiness, summarize issues, and coordinate final QA follow-through.",
        budgetMonthlyCents: 120000,
      },
    }),
  });
}

async function renderVideo(framesDir: string): Promise<void> {
  const framePattern = join(framesDir, "frame-%04d.png");
  const palettePath = join(framesDir, "palette.png");

  await execFileAsync("ffmpeg", [
    "-y",
    "-framerate",
    "2",
    "-i",
    framePattern,
    "-vf",
    "scale=1600:-2:flags=lanczos,format=yuv420p",
    "-movflags",
    "+faststart",
    MP4_PATH,
  ]);

  await execFileAsync("ffmpeg", [
    "-y",
    "-framerate",
    "2",
    "-i",
    framePattern,
    "-vf",
    "fps=2,scale=1400:-1:flags=lanczos,palettegen",
    palettePath,
  ]);

  await execFileAsync("ffmpeg", [
    "-y",
    "-framerate",
    "2",
    "-i",
    framePattern,
    "-i",
    palettePath,
    "-lavfi",
    "fps=2,scale=1400:-1:flags=lanczos[x];[x][1:v]paletteuse",
    GIF_PATH,
  ]);
}

async function approveNowItem(page: import("playwright").Page, expectedTitleFragment: string): Promise<void> {
  await page.getByText(expectedTitleFragment, { exact: false }).first().waitFor({ state: "visible", timeout: 12_000 });
  const approveButton = page.getByRole("button", { name: "Approve" }).first();
  await approveButton.waitFor({ state: "visible", timeout: 5_000 });
  await page.waitForTimeout(800);
  await approveButton.click();
  await page.waitForTimeout(1_600);
}

async function postCommentOnNowItem(
  page: import("playwright").Page,
  expectedTitleFragment: string,
  body: string,
): Promise<void> {
  await page.getByText(expectedTitleFragment, { exact: false }).first().waitFor({ state: "visible", timeout: 12_000 });
  const commentButton = page.getByRole("button", { name: "Comment" }).first();
  await commentButton.waitFor({ state: "visible", timeout: 5_000 });
  await page.waitForTimeout(800);
  await commentButton.click();
  const composer = page.getByPlaceholder("Add a short operator note back to the issue…");
  await composer.waitFor({ state: "visible", timeout: 5_000 });
  await page.waitForTimeout(700);
  await composer.click();
  await composer.pressSequentially(body, { delay: 40 });
  await page.waitForTimeout(1_000);
  const postButton = page.getByRole("button", { name: "Post comment" }).first();
  await postButton.waitFor({ state: "visible", timeout: 5_000 });
  await page.waitForTimeout(600);
  await postButton.click();
  await page.waitForTimeout(1_600);
}

async function acknowledgeNowItem(
  page: import("playwright").Page,
  expectedTitleFragment: string,
): Promise<void> {
  await page.getByText(expectedTitleFragment, { exact: false }).first().waitFor({ state: "visible", timeout: 12_000 });
  const acknowledgeButton = page.getByRole("button", { name: "Acknowledge" }).first();
  await acknowledgeButton.waitFor({ state: "visible", timeout: 5_000 });
  await page.waitForTimeout(800);
  await acknowledgeButton.click();
  await page.waitForTimeout(1_600);
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const framesDir = await mkdtemp(join(tmpdir(), "focus-demo-"));

  try {
    const existingCompanies = await listCompanies();
    const demoCompanies = existingCompanies.filter((company) => company.name.startsWith("Live Attention Demo "));
    for (const demoCompany of demoCompanies) {
      await deleteCompany(demoCompany.id);
      console.log(`Deleted prior demo company ${demoCompany.issuePrefix}`);
    }

    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 12);
    const company = await createCompany(`Live Attention Demo ${stamp}`);
    console.log(`Created company ${company.name} (${company.issuePrefix})`);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1600, height: 980 },
      deviceScaleFactor: 1,
      colorScheme: "dark",
    });
    const page = await context.newPage();
    await page.route("**/api/plugins/**/actions/comment-on-issue", async (route) => {
      await sleep(ACTION_DELAY_MS);
      await route.continue();
    });
    await page.route("**/api/plugins/**/actions/acknowledge-frame", async (route) => {
      await sleep(ACTION_DELAY_MS);
      await route.continue();
    });
    await page.route("**/api/plugins/**/actions/record-approval-response", async (route) => {
      await sleep(ACTION_DELAY_MS);
      await route.continue();
    });
    await page.route("**/api/approvals/**/approve", async (route) => {
      await sleep(ACTION_DELAY_MS);
      await route.continue();
    });
    await page.goto(`${BASE_URL}/${company.issuePrefix}/aperture`, { waitUntil: "networkidle" });
    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          transition: none !important;
          animation: none !important;
          caret-color: transparent !important;
        }
      `,
    });
    await page.waitForTimeout(1000);

    let resolvedIssue: Issue | null = null;
    let reviewIssue: Issue | null = null;
    let blockedIssue: Issue | null = null;

    const scheduledTasks = [
      (async () => {
        await sleep(1_500);
        resolvedIssue = await createIssue(company.id, {
          title: "Unblock onboarding workflow copy for launch",
          description: "Launch is blocked on final onboarding copy direction.",
          status: "blocked",
          priority: "high",
        });
        const current = requireIssue(resolvedIssue, "Resolved issue missing");
        await addIssueComment(
          current.id,
          [
            "## CEO Confirmation — Onboarding Copy",
            "",
            "Here is the final direction. Lock these in.",
            "",
            "Use these. This is not a request for iteration.",
            `Unblock [${current.identifier}](/${company.issuePrefix}/issues/${current.identifier}) and proceed to launch review.`,
          ].join("\n"),
        );
        console.log(`Created resolved blocker ${current.identifier}`);
      })(),
      (async () => {
        await sleep(5_500);
        reviewIssue = await createIssue(company.id, {
          title: "Review pricing experiment memo",
          description: "The board needs to review the latest memo before work proceeds.",
          status: "in_review",
          priority: "high",
        });
        const current = requireIssue(reviewIssue, "Review issue missing");
        await addIssueComment(
          current.id,
          "I don't actually see the actual memo. Can you share it with the board?",
        );
        console.log(`Created review-required issue ${current.identifier}`);
      })(),
      (async () => {
        await sleep(9_000);
        const current = requireIssue(reviewIssue, "Review issue missing before approval");
        await createBudgetApproval(company.id, current);
        console.log(`Created budget approval for ${current.identifier}`);
      })(),
      (async () => {
        await sleep(12_500);
        blockedIssue = await createIssue(company.id, {
          title: "Confirm reference customers for testimonials",
          description: "Marketing cannot finish the launch page until reference customers are confirmed.",
          status: "blocked",
          priority: "medium",
        });
        const current = requireIssue(blockedIssue, "Blocked issue missing");
        await addIssueComment(
          current.id,
          "Blocked on final customer references. Need the exact logos and quotes before launch page copy can proceed.",
        );
        console.log(`Created blocked next item ${current.identifier}`);
      })(),
      (async () => {
        await sleep(16_000);
        const current = requireIssue(reviewIssue, "Review issue missing before approval click");
        await approveNowItem(page, `Approve launch budget override for ${current.identifier}`);
        console.log(`Approved budget override for ${current.identifier}`);
      })(),
      (async () => {
        await sleep(24_000);
        const current = requireIssue(reviewIssue, "Review issue missing before comment");
        await postCommentOnNowItem(
          page,
          current.identifier,
          "Please attach or link the memo in this thread so the board can review it without leaving the issue.",
        );
        console.log(`Posted Focus comment on ${current.identifier}`);
      })(),
      (async () => {
        await sleep(34_000);
        const current = requireIssue(reviewIssue, "Review issue missing before acknowledge");
        await acknowledgeNowItem(page, current.identifier);
        console.log(`Acknowledged ${current.identifier} from Focus`);
      })(),
      (async () => {
        await sleep(39_000);
        const current = requireIssue(resolvedIssue, "Resolved issue missing before hire approval");
        await createHireApproval(company.id, current);
        console.log(`Created hire approval for ${current.identifier}`);
      })(),
    ];

    const captureStart = Date.now();
    let frameIndex = 0;

    while (Date.now() - captureStart <= TOTAL_DURATION_MS) {
      const framePath = join(framesDir, `frame-${String(frameIndex).padStart(4, "0")}.png`);
      await page.screenshot({ path: framePath, fullPage: false });
      frameIndex += 1;
      await sleep(CAPTURE_INTERVAL_MS);
    }

    await Promise.all(scheduledTasks);

    const posterSource = join(framesDir, `frame-${String(Math.max(frameIndex - 1, 0)).padStart(4, "0")}.png`);
    await copyFile(posterSource, POSTER_PATH);
    await renderVideo(framesDir);

    await context.close();
    await browser.close();

    console.log(`Wrote ${MP4_PATH}`);
    console.log(`Wrote ${GIF_PATH}`);
    console.log(`Wrote ${POSTER_PATH}`);
    console.log(`Demo company available at ${BASE_URL}/${company.issuePrefix}/aperture`);
  } finally {
    await rm(framesDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
