#!/usr/bin/env node

import { execSync } from "child_process";
import { Pipeline } from "@buildkite/buildkite-sdk";
import { Octokit } from "octokit";

interface WebhookPayload {
  action?: string;
  issue?: {
    number: number;
    pull_request?: {
      url: string;
    };
  };
  comment?: {
    body: string;
    user: {
      login: string;
    };
  };
  repository: {
    owner: {
      login: string;
    };
    name: string;
  };
}

interface BuildkiteBuild {
  number: number;
  web_url: string;
  state: string;
  commit: string;
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
 * Finds builds for a branch using the Buildkite API
 */
async function findBuildsForBranch(
  branch: string,
  org: string,
  pipeline: string,
  targetCommit?: string,
): Promise<BuildkiteBuild | null> {
  console.error(`Searching for builds on branch: ${branch}`);
  if (targetCommit) {
    console.error(`Filtering for commit: ${targetCommit}`);
  }

  const buildkiteToken = process.env.BUILDKITE_API_TOKEN;
  if (!buildkiteToken) {
    throw new Error("BUILDKITE_API_TOKEN not set");
  }

  const response = await fetch(
    `https://api.buildkite.com/v2/organizations/${org}/pipelines/${pipeline}/builds?branch=${branch}&per_page=10`,
    {
      headers: {
        Authorization: `Bearer ${buildkiteToken}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `Buildkite API error: ${response.status} ${response.statusText}`,
    );
  }

  const builds: BuildkiteBuild[] = await response.json();

  let build: BuildkiteBuild | undefined;

  if (targetCommit) {
    build = builds.find((b) => b.commit === targetCommit);
  } else {
    build = builds[0];
  }

  if (build) {
    console.error(`Found build #${build.number}`);
    console.error(`Build URL: ${build.web_url}`);
    console.error(`Build commit: ${build.commit}`);
    console.error(`Build state: ${build.state}`);
    return build;
  } else {
    if (targetCommit) {
      console.error(
        `No builds found for branch: ${branch} at commit: ${targetCommit}`,
      );
    } else {
      console.error(`No builds found for branch: ${branch}`);
    }
    return null;
  }
}

/**
 * Generates the pr-assist pipeline using the Buildkite SDK
 */
function generatePrAssistPipeline(
  webhookBuildUrl: string,
  webhookPullRequestUrl: string,
  agentBuildUrl: string,
  requestType: string,
  commentAuthor: string,
): string {
  const pipeline = new Pipeline();

  // Choose the appropriate prompt based on request type
  const promptFile =
    requestType === "review" ? "prompts/review.md" : "prompts/fix-build.md";
  const label =
    requestType === "review" ? ":mag: PR Review" : ":wrench: Fix Build";

  const tokenArgs = [
    `BuildURL=${webhookBuildUrl}`,
    `PullRequestURL=${webhookPullRequestUrl}`,
    `AgentBuildURL=${agentBuildUrl}`,
    `CommentAuthor=${commentAuthor}`,
  ];

  pipeline.addStep({
    command: `./agent.sh ${promptFile} ${tokenArgs.join(" ")}`,
    label: label,
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
 * Determines the request type from the comment body
 */
function determineRequestType(commentBody: string): string | null {
  const lowerBody = commentBody.toLowerCase();

  // Check for review request
  if (lowerBody.includes("review")) {
    return "review";
  }

  // Check for fix build request
  if (
    lowerBody.includes("fix") &&
    (lowerBody.includes("build") || lowerBody.includes("ci"))
  ) {
    return "fix-build";
  }

  return null;
}

/**
 * Main processing logic
 */
async function main() {
  console.log("--- :github: Processing PR comment webhook");

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

  const webhookEvent = payload.action;

  if (!webhookEvent) {
    console.error("Error: Could not determine webhook event");
    process.exit(1);
  }

  console.log(`Webhook event: ${webhookEvent}`);

  if (webhookEvent !== "created") {
    console.log("Not a created event, exiting");
    process.exit(0);
  }

  buildkiteAgent("meta-data", "set", "webhook:event", webhookEvent);
  buildkiteAgent("meta-data", "set", "webhook:source", "github");

  // Verify this is a PR comment
  if (!payload.issue?.pull_request) {
    console.log("Not a pull request comment, exiting");
    process.exit(0);
  }

  const commentBody = payload.comment?.body;
  const commentAuthor = payload.comment?.user.login;

  if (!commentBody || !commentAuthor) {
    console.error("Error: Could not extract comment details");
    process.exit(1);
  }

  console.log(`Comment author: ${commentAuthor}`);
  console.log(`Comment body: ${commentBody}`);

  // Check if comment starts with @buildsworth-bk mention
  if (!commentBody.trim().startsWith("@buildsworth-bk")) {
    console.log("Comment does not start with @buildsworth-bk, exiting");
    process.exit(0);
  }

  console.log("Comment starts with @buildsworth-bk, processing request...");

  // Determine request type
  const requestType = determineRequestType(commentBody);

  if (!requestType) {
    console.log(
      "Could not determine request type (review or fix-build), exiting",
    );
    process.exit(0);
  }

  console.log(`Request type: ${requestType}`);

  const prNumber = payload.issue.number;
  const repoOwner = payload.repository.owner.login;
  const repoName = payload.repository.name;

  console.log(`PR number: ${prNumber}`);
  console.log(`Repository: ${repoOwner}/${repoName}`);

  const pipelineSlug = repoName;
  const orgSlug = repoOwner;

  // Create Octokit instance for GitHub API calls
  const octokit = createOctokit();

  // Get PR details to find the branch
  const { data: pr } = await octokit.rest.pulls.get({
    owner: repoOwner,
    repo: repoName,
    pull_number: prNumber,
  });

  const prBranch = pr.head.ref;
  console.log(`PR branch: ${prBranch}`);

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

  // Look for builds at the PR head commit
  const build = await findBuildsForBranch(
    prBranch,
    orgSlug,
    pipelineSlug,
    prHeadCommit,
  );

  if (!build) {
    console.log("No builds found for PR head commit, skipping pipeline upload");
    process.exit(0);
  }

  console.log(
    "Found build for PR head commit, posting acknowledgement and uploading pr-assist pipeline",
  );

  const webhookPullRequestUrl = `https://github.com/${repoOwner}/${repoName}/pull/${prNumber}`;

  // Post acknowledgement comment on the PR
  const agentBuildUrl = process.env.BUILDKITE_BUILD_URL || "";
  const acknowledgementEmoji = requestType === "review" ? "👀" : "🛠️";
  const acknowledgementText =
    requestType === "review" ? "reviewing" : "fixing the build";
  const acknowledgementBody = `I'm on it! ${acknowledgementEmoji}\n\nI'll start ${acknowledgementText}. You can follow my progress here: ${agentBuildUrl}`;

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
  process.env.WEBHOOK_BUILD_STATE = build.state;
  process.env.WEBHOOK_BUILD_NUMBER = build.number.toString();
  process.env.WEBHOOK_BUILD_URL = build.web_url;
  process.env.WEBHOOK_PIPELINE_SLUG = pipelineSlug;
  process.env.WEBHOOK_PULL_REQUEST_URL = webhookPullRequestUrl;

  const pipelineYaml = generatePrAssistPipeline(
    build.web_url,
    webhookPullRequestUrl,
    process.env.BUILDKITE_BUILD_URL || "",
    requestType,
    commentAuthor,
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
