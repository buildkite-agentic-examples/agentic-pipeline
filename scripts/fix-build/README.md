# Fix Build

Automatically triggers a pipeline to fix failed builds when a PR has the `buildy-fix` label.

## How It Works

The fix-build pipeline can be triggered in two ways:

### 1. Buildkite Webhook (Build Finished)
When a Buildkite build finishes:
1. `.buildkite/pipeline.yml` receives the webhook and runs `process-event.sh`
2. `process-event.sh` routes to `trigger-buildkite.ts` based on the trigger ID
3. `trigger-buildkite.ts` performs the following:
   - Verifies the build state is `failed`
   - Extracts repository information from the webhook payload
   - Uses the GitHub API (via Octokit) to find the associated open PR for the branch
   - Verifies the build commit matches the PR head commit (prevents stale builds)
   - Checks if the PR has the `buildy-fix` label
   - If all conditions are met, dynamically generates and uploads a fix-build pipeline using the Buildkite SDK

### 2. GitHub Webhook (PR Labeled)
When a PR is labeled with `buildy-fix`:
1. `.buildkite/pipeline.yml` receives the webhook and runs `process-event.sh`
2. `process-event.sh` routes to `trigger-github.ts` based on the trigger ID
3. `trigger-github.ts` performs the following:
   - Verifies the label is `buildy-fix`
   - Uses the GitHub API (via Octokit) to get the PR head commit
   - Uses the Buildkite API to search for failed builds on the PR branch at the head commit
   - If a failed build is found, dynamically generates and uploads a fix-build pipeline using the Buildkite SDK

### 3. Execution
Once the fix-build pipeline is uploaded:
1. A Docker container is spun up with the agent environment
2. `agent.sh` executes `prompts/fix-build.md` with build and PR metadata
3. The agent analyzes failures, implements fixes, opens a PR, and verifies the fix passes CI

## Requirements

- Node.js >= 18.0.0
- npm or compatible package manager

## Install

```bash
npm install
```

This installs the following dependencies:
- `@buildkite/buildkite-sdk` - For generating Buildkite pipeline YAML
- `octokit` - GitHub API client for PR and commit operations
- `tsx` - TypeScript execution environment

## Setup

Set required environment variables:

```bash
export GITHUB_TOKEN=your_github_token
export BUILDKITE_API_TOKEN=your_buildkite_token
export LINEAR_API_TOKEN=your_linear_token
```

## Usage

### Buildkite Webhook Trigger
Triggers when a Buildkite build finishes:

```bash
npm run fix-build:trigger:buildkite
```

This runs `trigger-buildkite.ts` which processes build.finished webhook events.

### GitHub Webhook Trigger
Triggers when a GitHub PR is labeled:

```bash
npm run fix-build:trigger:github
```

This runs `trigger-github.ts` which processes pull_request.labeled webhook events.
