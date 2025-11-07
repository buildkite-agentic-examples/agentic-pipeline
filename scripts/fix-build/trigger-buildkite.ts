#!/usr/bin/env node

import { execSync } from "child_process";
import { Pipeline } from "@buildkite/buildkite-sdk";
import { Octokit } from "octokit";

interface WebhookPayload {
  event?: string;
  build: {
    state: string;
    number: number;
    web_url: string;
    branch: string;
    commit: string;
  };
  pipeline: {
    slug: string;
    repository?: string;
  };
}

/**
 * Creates an authenticated Octokit instance
 */
function createOctokit(): Octokit {
  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    throw new Error("GITHUB_TOKEN not set");
  }

  return new Octokit({ auth: githubToken });
}

/**
 * Finds an open PR for a given branch using the GitHub API
 */
async function findOpenPrForBranch(
  octokit: Octokit,
  branch: string,
  repoOwner: string,
  repoName: string,
): Promise<number | null> {
  console.error(`Checking GitHub for open PRs on branch: ${branch}`);

  const { data: prs } = await octokit.rest.pulls.list({
    owner: repoOwner,
    repo: repoName,
    state: "open",
    head: `${repoOwner}:${branch}`,
    per_page: 1,
  });

  const prNumber = prs[0]?.number;

  if (prNumber) {
    console.error(`Found open PR #${prNumber} for branch ${branch}`);
    return prNumber;
  } else {
    console.error(`No open PR found for branch: ${branch}`);
    return null;
  }
}

/**
 * Checks if a PR has the "fix-build" label
 */
async function checkPrhasLabel(
  octokit: Octokit,
  prNumber: number,
  repoOwner: string,
  repoName: string,
): Promise<boolean> {
  console.error(`Checking if PR #${prNumber} has 'fix-build' label...`);

  const { data: pr } = await octokit.rest.pulls.get({
    owner: repoOwner,
    repo: repoName,
    pull_number: prNumber,
  });

  const hasLabel = pr.labels.some((label) => label.name === "fix-build");

  if (hasLabel) {
    console.error(`PR #${prNumber} has 'fix-build' label`);
  } else {
    console.error(`PR #${prNumber} does not have 'fix-build' label`);
  }

  return hasLabel;
}

/**
 * Gets the head commit SHA for a PR
 */
async function getPrHeadCommit(
  octokit: Octokit,
  prNumber: number,
  repoOwner: string,
  repoName: string,
): Promise<string | null> {
  console.error(`Getting head commit for PR #${prNumber}...`);

  const { data: pr } = await octokit.rest.pulls.get({
    owner: repoOwner,
    repo: repoName,
    pull_number: prNumber,
  });

  const commitSha = pr.head.sha;

  if (commitSha) {
    console.error(`PR #${prNumber} head commit: ${commitSha}`);
    return commitSha;
  } else {
    console.error(`Could not get head commit for PR #${prNumber}`);
    return null;
  }
}

/**
 * Generates the fix-build pipeline using the Buildkite SDK
 */
function generateFixBuildPipeline(
  webhookBuildUrl: string,
  webhookPullRequestUrl: string,
  agentBuildUrl: string,
): string {
  const pipeline = new Pipeline();

  const tokenArgs = [
    `BuildURL=${webhookBuildUrl}`,
    `PullRequestURL=${webhookPullRequestUrl}`,
    `AgentBuildURL=${agentBuildUrl}`,
  ];

  pipeline.addStep({
    command: `./agent.sh prompts/fix-build.md ${tokenArgs.join(" ")}`,
    label: ":buildkite: Fixing the build",
    depends_on: "process-event",
    plugins: [
      {
        "docker-compose#v5.11.0": {
          run: "buildsworth",
          build: {
            context: ".",
            dockerfile: "Dockerfile.agent",
          },
          "mount-checkout": false,
          "mount-buildkite-agent": true,
          environment: [
            "BUILDKITE",
            "BUILDKITE_AGENT_ENDPOINT",
            "BUILDKITE_AGENT_ACCESS_TOKEN",
            "BUILDKITE_BUILD_URL",
            "LINEAR_API_TOKEN",
            "GITHUB_TOKEN",
            "BUILDKITE_API_TOKEN",
            "WEBHOOK_BUILD_STATE",
            "WEBHOOK_BUILD_NUMBER",
            "WEBHOOK_BUILD_URL",
            "WEBHOOK_PIPELINE_SLUG",
            "WEBHOOK_PULL_REQUEST_URL",
          ],
        },
      },
    ],
  });

  // Add secrets at the pipeline level
  const yamlOutput = pipeline.toYAML();

  // Prepend secrets to the YAML output
  const secretsYaml = `secrets:
  LINEAR_API_TOKEN: LINEAR_API_TOKEN
  GITHUB_TOKEN: GITHUB_TOKEN
  BUILDKITE_API_TOKEN: API_TOKEN_BUILDKITE

`;

  return secretsYaml + yamlOutput;
}

/**
 * Executes a buildkite-agent command
 */
function buildkiteAgent(...args: string[]): string {
  const command = `buildkite-agent ${args.join(" ")}`;
  return execSync(command, { encoding: "utf-8" });
}

/**
 * Main processing logic
 */
async function main() {
  console.log("--- :buildkite: Processing failed build webhook");

  const webhookPayload = buildkiteAgent(
    "meta-data",
    "get",
    "buildkite:webhook",
  ).trim();

  if (!webhookPayload) {
    console.error("Error: No webhook payload found");
    process.exit(1);
  }

  console.log("Received webhook payload:");
  const payload: WebhookPayload = JSON.parse(webhookPayload);
  console.log(JSON.stringify(payload, null, 2));

  const webhookEvent = payload.event;

  if (!webhookEvent) {
    console.error("Error: Could not determine webhook event");
    process.exit(1);
  }

  console.log(`Webhook event: ${webhookEvent}`);

  if (webhookEvent !== "build.finished") {
    console.log("Not a build.finished event, exiting");
    process.exit(0);
  }

  buildkiteAgent("meta-data", "set", "webhook:event", webhookEvent);
  buildkiteAgent("meta-data", "set", "webhook:source", "buildkite");

  const webhookBuildState = payload.build.state;
  const webhookBuildNumber = payload.build.number;
  const webhookBuildUrl = payload.build.web_url;
  const webhookPipelineSlug = payload.pipeline.slug;
  const webhookBuildBranch = payload.build.branch;
  const webhookBuildCommit = payload.build.commit;

  console.log(`Build state: ${webhookBuildState}`);
  console.log(`Build number: ${webhookBuildNumber}`);
  console.log(`Pipeline: ${webhookPipelineSlug}`);
  console.log(`Branch: ${webhookBuildBranch}`);
  console.log(`Build commit: ${webhookBuildCommit}`);
  console.log(`Build URL: ${webhookBuildUrl}`);

  if (webhookBuildState !== "failed") {
    console.log(`Build state is ${webhookBuildState}, not failed - exiting`);
    process.exit(0);
  }

  console.log("Build has failed, checking for associated PR...");

  const repoUrl = payload.pipeline.repository;
  if (!repoUrl) {
    console.error("Error: No repository URL in webhook payload");
    process.exit(1);
  }

  const repoOwnerMatch = repoUrl.match(/github\.com[:/]([^/]*)\//);
  const repoNameMatch = repoUrl.match(/github\.com[:/][^/]*\/([^/.]*)/);

  if (!repoOwnerMatch || !repoNameMatch) {
    console.error("Error: Could not extract repo info from webhook payload");
    console.error(`Repository URL: ${repoUrl}`);
    process.exit(1);
  }

  const repoOwner = repoOwnerMatch[1];
  const repoName = repoNameMatch[1];

  console.log(`Repository: ${repoOwner}/${repoName}`);

  // Create Octokit instance for GitHub API calls
  const octokit = createOctokit();

  const prNumber = await findOpenPrForBranch(
    octokit,
    webhookBuildBranch,
    repoOwner,
    repoName,
  );

  if (!prNumber) {
    console.log(`No open PR found for branch: ${webhookBuildBranch}`);
    console.log("Skipping pipeline upload");
    process.exit(0);
  }

  console.log(`Found open PR #${prNumber} for branch ${webhookBuildBranch}`);

  const prHeadCommit = await getPrHeadCommit(
    octokit,
    prNumber,
    repoOwner,
    repoName,
  );

  if (!prHeadCommit) {
    console.log("Could not get PR head commit, skipping pipeline upload");
    process.exit(0);
  }

  if (webhookBuildCommit !== prHeadCommit) {
    console.log(
      `Build commit (${webhookBuildCommit}) does not match PR head commit (${prHeadCommit})`,
    );
    console.log(
      "Skipping pipeline upload - this build is not for the current PR head",
    );
    process.exit(0);
  }

  console.log("Build commit matches PR head commit");

  const hasLabel = await checkPrhasLabel(
    octokit,
    prNumber,
    repoOwner,
    repoName,
  );

  if (!hasLabel) {
    console.log("PR does not have 'fix-build' label, skipping pipeline upload");
    process.exit(0);
  }

  console.log(
    "PR has 'fix-build' label, posting acknowledgement and uploading fix-build pipeline",
  );

  const webhookPullRequestUrl = `https://github.com/${repoOwner}/${repoName}/pull/${prNumber}`;

  // Post acknowledgement comment on the PR
  const agentBuildUrl = process.env.BUILDKITE_BUILD_URL || "";
  const acknowledgementBody = `I'm on it! 🛠️\n\nYou can follow my progress here: ${agentBuildUrl}`;

  try {
    await octokit.rest.issues.createComment({
      owner: repoOwner,
      repo: repoName,
      issue_number: prNumber,
      body: acknowledgementBody,
    });
    console.log("Posted acknowledgement comment on PR");
  } catch (error) {
    console.error("Failed to post acknowledgement comment:", error);
    // Continue with pipeline upload even if comment fails
  }

  // Set environment variables for the pipeline
  process.env.WEBHOOK_BUILD_STATE = webhookBuildState;
  process.env.WEBHOOK_BUILD_NUMBER = webhookBuildNumber.toString();
  process.env.WEBHOOK_BUILD_URL = webhookBuildUrl;
  process.env.WEBHOOK_PIPELINE_SLUG = webhookPipelineSlug;
  process.env.WEBHOOK_PULL_REQUEST_URL = webhookPullRequestUrl;

  const pipelineYaml = generateFixBuildPipeline(
    webhookBuildUrl,
    webhookPullRequestUrl,
    process.env.BUILDKITE_BUILD_URL || "",
  );

  // Upload the pipeline
  const uploadProcess = execSync("buildkite-agent pipeline upload", {
    input: pipelineYaml,
    encoding: "utf-8",
  });

  console.log(uploadProcess);
}

// Run the main function
main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
