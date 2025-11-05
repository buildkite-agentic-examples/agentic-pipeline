#!/usr/bin/env node

import { execSync } from "child_process";
import { Pipeline } from "@buildkite/buildkite-sdk";
import { Octokit } from "octokit";

interface WebhookPayload {
  action?: string;
  label: {
    name: string;
  };
  pull_request: {
    number: number;
    head: {
      ref: string;
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
 * Finds failed builds for a branch using the Buildkite API
 */
async function findFailedBuildForBranch(
  branch: string,
  org: string,
  pipeline: string,
  targetCommit?: string,
): Promise<BuildkiteBuild | null> {
  console.error(`Searching for failed builds on branch: ${branch}`);
  if (targetCommit) {
    console.error(`Filtering for commit: ${targetCommit}`);
  }

  const buildkiteToken = process.env.BUILDKITE_API_TOKEN;
  if (!buildkiteToken) {
    throw new Error("BUILDKITE_API_TOKEN not set");
  }

  const response = await fetch(
    `https://api.buildkite.com/v2/organizations/${org}/pipelines/${pipeline}/builds?branch=${branch}&state=failed&per_page=10`,
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

  let failedBuild: BuildkiteBuild | undefined;

  if (targetCommit) {
    failedBuild = builds.find((build) => build.commit === targetCommit);
  } else {
    failedBuild = builds[0];
  }

  if (failedBuild) {
    console.error(`Found failed build #${failedBuild.number}`);
    console.error(`Build URL: ${failedBuild.web_url}`);
    console.error(`Build commit: ${failedBuild.commit}`);
    return failedBuild;
  } else {
    if (targetCommit) {
      console.error(
        `No failed builds found for branch: ${branch} at commit: ${targetCommit}`,
      );
    } else {
      console.error(`No failed builds found for branch: ${branch}`);
    }
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
    depends_on: null,
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
  console.log("--- :github: Processing fix-build label webhook");

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

  if (webhookEvent !== "labeled") {
    console.log("Not a labeled event, exiting");
    process.exit(0);
  }

  buildkiteAgent("meta-data", "set", "webhook:event", webhookEvent);
  buildkiteAgent("meta-data", "set", "webhook:source", "github");

  const labelName = payload.label.name;
  const prNumber = payload.pull_request.number;
  const prBranch = payload.pull_request.head.ref;
  const repoOwner = payload.repository.owner.login;
  const repoName = payload.repository.name;

  console.log(`Label: ${labelName}`);
  console.log(`PR number: ${prNumber}`);
  console.log(`PR branch: ${prBranch}`);
  console.log(`Repository: ${repoOwner}/${repoName}`);

  if (labelName !== "fix-build") {
    console.log("Label is not 'fix-build', exiting");
    process.exit(0);
  }

  console.log("Label is 'fix-build', checking for failed builds...");

  const pipelineSlug = repoName;
  const orgSlug = repoOwner;

  // Create Octokit instance for GitHub API calls
  const octokit = createOctokit();

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

  const failedBuild = await findFailedBuildForBranch(
    prBranch,
    orgSlug,
    pipelineSlug,
    prHeadCommit,
  );

  if (!failedBuild) {
    console.log(
      "No failed builds found for PR head commit, skipping pipeline upload",
    );
    process.exit(0);
  }

  console.log(
    "Found failed build for PR head commit, posting acknowledgement and uploading fix-build pipeline",
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
  process.env.WEBHOOK_BUILD_STATE = failedBuild.state;
  process.env.WEBHOOK_BUILD_NUMBER = failedBuild.number.toString();
  process.env.WEBHOOK_BUILD_URL = failedBuild.web_url;
  process.env.WEBHOOK_PIPELINE_SLUG = pipelineSlug;
  process.env.WEBHOOK_PULL_REQUEST_URL = webhookPullRequestUrl;

  const pipelineYaml = generateFixBuildPipeline(
    failedBuild.web_url,
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
