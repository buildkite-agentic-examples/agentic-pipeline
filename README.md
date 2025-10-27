# Buildkite Agentic Pipelines

AI-powered automation for Linear issues and Buildkite builds. Uses Claude AI agents to analyze support requests, implement features, and fix failing builds.

## Features

- **Analyze Requests**: Triages Linear support issues, provides analysis for complex problems, and implements fixes for simple ones
- **Complete Tasks**: Implements Linear tasks labeled `first-draft` and creates draft pull requests
- **Fix Builds**: Automatically fixes failing CI builds triggered by GitHub or Buildkite webhooks
- **Fix Bugsnag Errors**: Automatically analyzes and fixes production errors when Bugsnag detects error spikes

## Dependencies

### API Keys
- **Linear API Token**: Read issues, create/update comments, update status
- **GitHub Token**: Fine-grained PAT with `repo` and `pull_request` read/write scope
- **Buildkite API Token**: Read builds, jobs, logs, and pipelines
- **Anthropic Claude API**: Via Buildkite Hosted Models (`BUILDKITE_AGENT_ENDPOINT/ai/anthropic`)
- **Bugsnag API Token**: Read errors/events, create comments (only for error fixing workflow)

### External Systems
- **Linear**: Project management and issue tracking
- **GitHub**: Code repository, PR management, CI status checks
- **Buildkite**: CI/CD platform with webhook triggers and Hosted Models enabled
- **Bugsnag**: Error monitoring and spike detection

### Infrastructure
- **Buildkite Pipeline**: With Docker Compose plugin support
- **Buildkite Agent**: With access to Hosted Models and sufficient resources

### Webhook Configuration

Trigger IDs are configured as environment variables in `.buildkite/pipeline.yml`.

#### Buildkite Pipeline Triggers
Create webhook triggers in Buildkite Pipeline Settings with trigger IDs matching the environment variables above. You can customize the trigger IDs by modifying the environment variables in `.buildkite/pipeline.yml`.

#### External Webhook Sources
Configure webhooks in external services to POST to your Buildkite pipeline webhook URL with the appropriate trigger ID:

**Linear**:
- **Events**: Issue created, Issue updated
- **Filter**: Issues with `first-draft` label
- **Payload fields**: `action`, `data.id`, `data.title`, `data.description`, `data.state.name`, `data.labels[].name`
- **Target trigger**: Use `COMPLETE_TASK_TRIGGER_ID` for task completion or `ANALYZE_REQUEST_TRIGGER_ID` for analysis

**GitHub**:
- **Events**: Check suite/run failures
- **Payload fields**: PR number, repository, commit SHA, check status
- **Target trigger**: Use `FIX_BUILD_GITHUB_TRIGGER_ID`

**Buildkite**:
- **Events**: Build state changed (filter for `failed` state)
- **Filter**: PRs with `buildy-fix` label
- **Payload fields**: Build URL, build state, build number, branch, commit
- **Target trigger**: Use `FIX_BUILD_BUILDKITE_TRIGGER_ID`

**Bugsnag**:
- **Events**: `projectSpiking` (error spike detection)
- **Payload fields**: `project.name`, `error.errorId`, `error.url`, `error.exceptionClass`, `error.message`, `error.context`, `error.app.releaseStage`, `error.app.version`, `error.stacktrace`
- **Target trigger**: Use `FIX_BUG_TRIGGER_ID`

## Installation

1. Create a new Buildkite pipeline using this repository
2. Configure the following secrets in Buildkite Secrets:
   - `LINEAR_API_TOKEN`: Linear API token with read and comment permissions
   - `GITHUB_TOKEN`: GitHub Fine Grained Personal Access Token with `repo` and `pull_request` read/write scope
   - `BUILDKITE_API_TOKEN`: Buildkite API token for build access
   - `BUGSNAG_API_TOKEN`: (Optional) Bugsnag API token for error analysis and commenting
3. Create Pipeline Triggers in Project Settings

## Usage

The agent automatically processes events based on trigger IDs:
- Linear issues with the `first-draft` label trigger task completion or analysis
- Failed Buildkite PR builds with the `buildy-fix` label trigger automatic fix attempts
- Bugsnag error spikes trigger automatic error analysis and fix attempts
