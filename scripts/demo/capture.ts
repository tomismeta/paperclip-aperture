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
const TOTAL_DURATION_MS = 24_000;

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
      description: "Automated demo company for the Focus plugin walkthrough.",
    }),
  });
}

async function createIssue(companyId: string): Promise<Issue> {
  return api<Issue>(`/api/companies/${companyId}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: "Investigate sandbox compute spike before launch sign-off",
      description:
        "Ops noticed sandbox compute costs jumping during the final staging run. The team needs a quick validation pass before approving launch spend.",
      status: "backlog",
      priority: "medium",
    }),
  });
}

async function createBudgetApproval(companyId: string, issue: Issue): Promise<void> {
  await api(`/api/companies/${companyId}/approvals`, {
    method: "POST",
    body: JSON.stringify({
      type: "budget_override_required",
      issueIds: [issue.id],
      payload: {
        title: `Approve temporary budget override for ${issue.identifier}`,
        summary: "Budget controls are blocking a short investigation into the sandbox compute spike.",
        requestedAmount: "$2,500",
        reason: "Need 48 hours of additional sandbox runtime to rerun load tests and isolate the cost regression.",
        decisionContext: `Allow a temporary override so the team can finish the launch readiness investigation for ${issue.identifier}.`,
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
        title: `Hire FinOps Analyst for ${issue.identifier}`,
        name: "FinOps Analyst",
        role: "operator",
        adapterType: "codex_local",
        capabilities: "Investigate cost regressions, summarize findings, and coordinate launch budget mitigation.",
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
  await page.getByText(expectedTitleFragment, { exact: false }).waitFor({ state: "visible", timeout: 12_000 });
  const approveButton = page.getByRole("button", { name: "Approve" }).first();
  await approveButton.waitFor({ state: "visible", timeout: 5_000 });
  await approveButton.click();
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const framesDir = await mkdtemp(join(tmpdir(), "focus-demo-"));
  let browserClosed = false;

  try {
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 12);
    const company = await createCompany(`Northstar Robotics Demo ${stamp}`);
    console.log(`Created company ${company.name} (${company.issuePrefix})`);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1600, height: 980 },
      deviceScaleFactor: 1,
      colorScheme: "dark",
    });
    const page = await context.newPage();
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

    let issue: Issue | null = null;
    const scheduledTasks = [
      (async () => {
        await sleep(1_500);
        issue = await createIssue(company.id);
        console.log(`Created ambient issue ${issue.identifier}`);
      })(),
      (async () => {
        await sleep(5_500);
        const currentIssue = requireIssue(issue, "Issue not ready before budget approval");
        await createBudgetApproval(company.id, currentIssue);
        console.log(`Created budget approval for ${currentIssue.identifier}`);
      })(),
      (async () => {
        await sleep(10_500);
        const currentIssue = requireIssue(issue, "Issue not ready before hire approval");
        await createHireApproval(company.id, currentIssue);
        console.log(`Created hire approval for ${currentIssue.identifier}`);
      })(),
      (async () => {
        await sleep(15_500);
        const currentIssue = requireIssue(issue, "Issue not ready before first approval click");
        await approveNowItem(page, `Approve temporary budget override for ${currentIssue.identifier}`);
        console.log(`Approved budget override for ${currentIssue.identifier}`);
      })(),
      (async () => {
        await sleep(18_500);
        const currentIssue = requireIssue(issue, "Issue not ready before second approval click");
        await approveNowItem(page, `Hire FinOps Analyst for ${currentIssue.identifier}`);
        console.log(`Approved hire request for ${currentIssue.identifier}`);
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
    browserClosed = true;

    console.log(`Wrote ${MP4_PATH}`);
    console.log(`Wrote ${GIF_PATH}`);
    console.log(`Wrote ${POSTER_PATH}`);
    console.log(`Demo company available at ${BASE_URL}/${company.issuePrefix}/aperture`);
  } finally {
    if (!browserClosed) {
      // no-op; browser/context are scoped above and will be closed by process exit on failure
    }
    await rm(framesDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
