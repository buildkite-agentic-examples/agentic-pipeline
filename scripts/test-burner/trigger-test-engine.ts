#!/usr/bin/env node

import { execSync } from "child_process";
import { Pipeline } from "@buildkite/buildkite-sdk";
import { Octokit } from "octokit";

interface WebhookPayload {
  subject: {
    type: "test";
    test_id: string;
    test_full_name: string;
    test_location: string;
    test_url: string;
  };
  workflow_id: string;
  workflow_url: string;
  event: string;
  workflow_event: {
    type: string;
    timestamp: string;
    execution_branch: string | null;
    execution_commit_sha: string | null;
    tag_filters: string[];
  };
  workflow_actions: Array<{
    type: string;
    value: string;
  }>;
}

// Mapping from suite name to pipeline slug
// Extract suite name from test_url: .../analytics/suites/{suite-name}/tests/...
const SUITE_TO_PIPELINE_MAP: Record<string, string> = {
  "kitesocial-rspec": "kitesocial-test-burner",
  // Add more mappings as needed
};

/**
 * Extracts the suite name from a Buildkite Analytics test URL
 */
function extractSuiteFromTestUrl(testUrl: string): string | null {
  const match = testUrl.match(/\/analytics\/suites\/([^/]+)\//);
  return match ? match[1] : null;
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
 * Generates the test-burner pipeline using the Buildkite SDK
 */
function generateTestBurnerPipeline(
  repo: string,
  branch: string,
  location: string,
  prUrl: string | null,
  agentBuildUrl: string,
  pipelineTrigger: string,
): string {
  const pipeline = new Pipeline();

  // Step 1: Trigger the test-burner pipeline synchronously
  pipeline.addStep({
    trigger: pipelineTrigger,
    label: `:fire: Burning test 1000 times (${pipelineTrigger})`,
    build: {
      message: `Burning test: ${location}`,
      branch: branch,
      meta_data: {
        test_repo: repo,
        test_branch: branch,
        test_location: location,
      },
    },
    async: false, // Synchronous - wait for the build to complete
  });

  // Step 2: Analyze the test burning results
  const tokenArgs = [
    `TestRepo=${repo}`,
    `TestBranch=${branch}`,
    `TestLocation=${location}`,
    `PullRequestURL=${prUrl || ""}`,
    `AgentBuildURL=${agentBuildUrl}`,
  ];

  pipeline.addStep({
    command: `./agent.sh prompts/test-burner.md ${tokenArgs.join(" ")}`,
    label: ":mag: Analyzing test burn results",
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
  console.log("--- :test_tube: Processing new test webhook");

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

  // Extract suite name from test URL
  const suiteName = extractSuiteFromTestUrl(payload.subject.test_url);
  if (!suiteName) {
    console.error("Error: Could not extract suite name from test URL");
    console.error(`Test URL: ${payload.subject.test_url}`);
    process.exit(1);
  }

  console.log(`Suite name: ${suiteName}`);

  // Look up the pipeline trigger from the suite mapping
  const pipelineTrigger = SUITE_TO_PIPELINE_MAP[suiteName];
  if (!pipelineTrigger) {
    console.error(`Error: No pipeline mapping found for suite: ${suiteName}`);
    console.error("Available mappings:", Object.keys(SUITE_TO_PIPELINE_MAP));
    process.exit(1);
  }

  console.log(`Pipeline trigger: ${pipelineTrigger}`);

  const location = payload.subject.test_location;
  console.log(`Test location: ${location}`);

  // For now, we'll need to derive the repo and branch from the pipeline trigger
  // This is a reverse mapping from pipeline slug to repo
  // TODO: We may need to store a more complete mapping or fetch this from Buildkite API
  const repoMatch = pipelineTrigger.match(/^(.+)-test-burner$/);
  if (!repoMatch) {
    console.error(
      `Error: Could not derive repo name from pipeline trigger: ${pipelineTrigger}`,
    );
    process.exit(1);
  }

  const repoName = repoMatch[1];
  // For now, assume all repos are under buildkite-agentic-examples
  const repoOwner = "buildkite-agentic-examples";
  const repo = `https://github.com/${repoOwner}/${repoName}.git`;

  console.log(`Derived repository: ${repoOwner}/${repoName}`);

  // Use execution_branch if available, otherwise use main
  const branch = payload.workflow_event.execution_branch || "main";
  console.log(`Branch: ${branch}`);

  // Create Octokit instance for GitHub API calls
  const octokit = createOctokit();

  // Check if there's an open PR for this branch (only if not main)
  let prNumber: number | null = null;
  if (branch !== "main") {
    prNumber = await findOpenPrForBranch(octokit, branch, repoOwner, repoName);
  }

  let prUrl: string | null = null;
  if (prNumber) {
    prUrl = `https://github.com/${repoOwner}/${repoName}/pull/${prNumber}`;
    console.log(`Found PR for this test: ${prUrl}`);
  } else {
    console.log("No PR found for this branch");
  }

  const agentBuildUrl = process.env.BUILDKITE_BUILD_URL || "";

  const pipelineYaml = generateTestBurnerPipeline(
    repo,
    branch,
    location,
    prUrl,
    agentBuildUrl,
    pipelineTrigger,
  );

  console.log("--- :pipeline: Uploading test-burner pipeline");
  console.log(pipelineYaml);

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
