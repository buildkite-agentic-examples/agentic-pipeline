#!/usr/bin/env node

import { execSync } from "child_process";
import { Pipeline } from "@buildkite/buildkite-sdk";

interface LinearWebhookPayload {
  action?: string;
  data: {
    id: string;
    title?: string;
    description?: string;
    state?: {
      name: string;
    };
    assignee?: {
      id: string;
    };
  };
}

/**
 * Generates the complete-task pipeline using the Buildkite SDK
 */
function generateLinearPipeline(
  issueId: string,
  agentBuildUrl: string,
): string {
  const pipeline = new Pipeline();

  const tokenArgs = [
    `LinearIssueID=${issueId}`,
    `AgentBuildURL=${agentBuildUrl}`,
  ];

  pipeline.addStep({
    command: `./agent.sh prompts/complete-task.md ${tokenArgs.join(" ")}`,
    label: ":linear: Handle Issue Update",
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
            "LINEAR_ISSUE_ID",
            "LINEAR_ISSUE_TITLE",
            "LINEAR_ISSUE_DESCRIPTION",
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
  console.log("--- :linear: Processing Linear webhook");

  if (process.env.BUILDKITE_SOURCE !== "webhook") {
    console.log("Not a webhook trigger, exiting");
    process.exit(0);
  }

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
  const payload: LinearWebhookPayload = JSON.parse(webhookPayload);
  console.log(JSON.stringify(payload, null, 2));

  const webhookAction = payload.action;

  if (!webhookAction) {
    console.error("Error: Could not determine webhook action");
    process.exit(1);
  }

  console.log(`Webhook action: ${webhookAction}`);

  buildkiteAgent("meta-data", "set", "webhook:action", webhookAction);
  buildkiteAgent("meta-data", "set", "webhook:source", "linear");

  switch (webhookAction) {
    case "create":
    case "update":
      console.log(`Processing ${webhookAction} webhook`);

      const linearIssueId = payload.data.id;
      const linearIssueTitle = payload.data.title || "";
      const linearIssueDescription = payload.data.description || "";
      const linearIssueState = payload.data.state?.name || "";

      console.log(`Issue ID: ${linearIssueId}`);
      console.log(`Issue Title: ${linearIssueTitle}`);
      console.log(`Issue State: ${linearIssueState}`);

      if (!linearIssueId) {
        console.error("Error: Could not extract issue ID from webhook payload");
        process.exit(1);
      }

      const linearIssueAssigneeId = payload.data.assignee?.id || "";

      console.log(`Issue Assignee ID: ${linearIssueAssigneeId}`);

      const BUILDSWORTH_USER_ID = "73f5316c-236c-4f50-9684-98890e0ea4fd";

      if (linearIssueAssigneeId === BUILDSWORTH_USER_ID) {
        console.log("Issue is assigned to 'buildsworth', uploading pipeline");

        // Set environment variables for the pipeline
        process.env.LINEAR_ISSUE_ID = linearIssueId;
        process.env.LINEAR_ISSUE_TITLE = linearIssueTitle;
        process.env.LINEAR_ISSUE_DESCRIPTION = linearIssueDescription;

        const pipelineYaml = generateLinearPipeline(
          linearIssueId,
          process.env.BUILDKITE_BUILD_URL || "",
        );

        // Upload the pipeline
        const uploadProcess = execSync("buildkite-agent pipeline upload", {
          input: pipelineYaml,
          encoding: "utf-8",
        });

        console.log(uploadProcess);
      } else {
        console.log(
          "Issue is not assigned to 'buildsworth', skipping pipeline upload",
        );
      }
      break;

    default:
      console.log(`Ignoring Linear webhook action: ${webhookAction}`);
      break;
  }
}

// Run the main function
main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
