# PR Assist

Automatically triggers a pipeline to assist with pull requests when mentioned with `@buildsworth-bk` in a PR comment.

## How It Works

The pr-assist pipeline is triggered by GitHub webhook events:

### 1. GitHub Webhook (PR Comment)
When a comment is created on a pull request that starts with `@buildsworth-bk`:
1. `.buildkite/pipeline.yml` receives the webhook and runs `process-event.sh`
2. `process-event.sh` routes to `trigger-github.ts` based on the trigger ID
3. `trigger-github.ts` performs the following:
   - Verifies the comment starts with `@buildsworth-bk`
   - Parses the comment to determine the request type (review or fix-build)
   - Uses the GitHub API (via Octokit) to get the PR details and head commit
   - Uses the Buildkite API to find builds for the PR head commit
   - If a build is found, dynamically generates and uploads a pr-assist pipeline using the Buildkite SDK

### 2. Execution
Once the pr-assist pipeline is uploaded:
1. A Docker container is spun up with the agent environment
2. Based on the request type, `agent.sh` executes either:
   - `prompts/review.md` for review requests
   - `prompts/fix-build.md` for fix-build requests
3. The agent:
   - Acknowledges the request with a comment on the PR
   - Waits for the build to finish if it's still running
   - Processes the request based on the type:
     - **Review** (`review.md`): Reviews the code, provides feedback, and optionally opens a PR with suggested changes
     - **Fix Build** (`fix-build.md`): Analyzes failures, implements fixes, opens a PR, and verifies the fix passes CI

## Request Types

The agent supports two types of requests:

### Review Request
Triggered by comments like:
- `@buildsworth-bk please review this PR`
- `@buildsworth-bk can you review the changes?`

The agent will:
- Clone and analyze the PR code
- Provide high-value code review suggestions
- Optionally create a PR with proposed improvements
- Post a summary comment with findings

### Fix Build Request
Triggered by comments like:
- `@buildsworth-bk please fix the build`
- `@buildsworth-bk can you fix the failing CI?`

The agent will:
- Analyze failed CI jobs and logs
- Identify and fix the issues
- Open a PR with the fixes
- Verify the fixes pass CI
- Post a summary comment with results

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

Configure the GitHub webhook trigger in Buildkite:
1. Create a new webhook trigger in Buildkite for `issue_comment` events
2. Set the trigger ID in `.buildkite/pipeline.yml` as `PR_ASSIST_GITHUB_TRIGGER_ID`
3. Configure the webhook to filter for `issue_comment.created` events

## Usage

### GitHub Webhook Trigger
Triggers when a PR comment is created:

```bash
npm run pr-assist:trigger:github
```

This runs `trigger-github.ts` which processes `issue_comment.created` webhook events.

### Manual Testing
You can manually trigger the pipeline by posting a comment on a PR that starts with `@buildsworth-bk` followed by either:
- A review request: `@buildsworth-bk please review`
- A fix request: `@buildsworth-bk please fix the build`

## Webhook Configuration

To set up the GitHub webhook trigger in Buildkite:

1. Go to your Buildkite pipeline settings
2. Navigate to "Webhooks" section
3. Create a new webhook trigger with:
   - **Event**: GitHub `issue_comment`
   - **Filter**: Action is `created`
   - **Trigger ID**: Use the value set in `PR_ASSIST_GITHUB_TRIGGER_ID`

## Example Usage

### Review Request
```
@buildsworth-bk please review this PR
```

The agent will:
1. Post an acknowledgment comment
2. Wait for the build to complete
3. Clone the repository and analyze the changes
4. Post a detailed code review with suggestions
5. Optionally create a PR with improvements

### Fix Build Request
```
@buildsworth-bk the build is failing, can you fix it?
```

The agent will:
1. Post an acknowledgment comment
2. Wait for the build to complete if still running
3. Analyze the failed jobs and logs
4. Implement fixes and open a PR
5. Verify the fixes pass CI
6. Post a summary with the fix PR link
