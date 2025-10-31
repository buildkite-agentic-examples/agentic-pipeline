#!/bin/bash

set -euo pipefail

# Function to generate pipeline for fixing Bugsnag errors
generate_fix_bugsnag_pipeline() {
  TOKEN_ARGS=(
    "BugsnagErrorID=$BUGSNAG_ERROR_ID"
    "BugsnagErrorURL=$BUGSNAG_ERROR_URL"
    "BugsnagProjectName=$BUGSNAG_PROJECT_NAME"
    "BugsnagErrorClass=$BUGSNAG_ERROR_CLASS"
    "BugsnagErrorMessage=$BUGSNAG_ERROR_MESSAGE"
    "BugsnagContext=$BUGSNAG_CONTEXT"
    "BugsnagStackTrace=$BUGSNAG_STACK_TRACE"
    "BugsnagReleaseStage=$BUGSNAG_RELEASE_STAGE"
    "BugsnagAppVersion=$BUGSNAG_APP_VERSION"
    "AgentBuildURL=$BUILDKITE_BUILD_URL"
  )

  cat <<EOF
secrets:
  LINEAR_API_TOKEN: LINEAR_API_TOKEN
  GITHUB_TOKEN: GITHUB_TOKEN
  BUILDKITE_API_TOKEN: API_TOKEN_BUILDKITE
  BUGSNAG_API_TOKEN: BUGSNAG_API_TOKEN

steps:
  - command: "./agent.sh prompts/fix-bugsnag-error.md ${TOKEN_ARGS[*]}"
    label: ":bug: Fixing Bugsnag Error"
    depends_on: ~
    plugins:
      - docker-compose#v5.11.0:
          run: buildsworth
          build:
            context: .
            dockerfile: Dockerfile.agent
          mount-checkout: false
          mount-buildkite-agent: true
          environment:
            - "BUILDKITE"
            - "BUILDKITE_AGENT_ENDPOINT"
            - "BUILDKITE_AGENT_ACCESS_TOKEN"
            - "BUILDKITE_BUILD_URL"
            - "LINEAR_API_TOKEN"
            - "GITHUB_TOKEN"
            - "BUILDKITE_API_TOKEN"
            - "BUGSNAG_API_TOKEN"
            - "BUGSNAG_ERROR_ID"
            - "BUGSNAG_ERROR_URL"
            - "BUGSNAG_PROJECT_NAME"
            - "BUGSNAG_ERROR_CLASS"
            - "BUGSNAG_ERROR_MESSAGE"
            - "BUGSNAG_CONTEXT"
            - "BUGSNAG_STACK_TRACE"
            - "BUGSNAG_RELEASE_STAGE"
            - "BUGSNAG_APP_VERSION"
EOF
}

# Main processing logic
echo "--- :bug: Processing Bugsnag webhook"

if [[ "${BUILDKITE_SOURCE}" != "webhook" ]]; then
  echo "Not a webhook trigger, exiting"
  exit 0
fi

WEBHOOK_PAYLOAD=$(buildkite-agent meta-data get "buildkite:webhook")

if [ -z "$WEBHOOK_PAYLOAD" ]; then
  echo "Error: No webhook payload found"
  exit 1
fi

echo "Received webhook payload:"
echo "$WEBHOOK_PAYLOAD" | jq '.'

WEBHOOK_TRIGGER_TYPE=$(echo "$WEBHOOK_PAYLOAD" | jq -r '.trigger.type // empty')

if [ -z "$WEBHOOK_TRIGGER_TYPE" ]; then
  echo "Error: Could not determine webhook trigger type"
  exit 1
fi

echo "Webhook trigger type: $WEBHOOK_TRIGGER_TYPE"

buildkite-agent meta-data set "webhook:trigger_type" "$WEBHOOK_TRIGGER_TYPE"
buildkite-agent meta-data set "webhook:source" "bugsnag"

# Only process error spike events
if [ "$WEBHOOK_TRIGGER_TYPE" != "projectSpiking" ]; then
  echo "Not a projectSpiking event, exiting"
  exit 0
fi

# Extract error information
BUGSNAG_PROJECT_NAME=$(echo "$WEBHOOK_PAYLOAD" | jq -r '.project.name // empty')
BUGSNAG_ERROR_ID=$(echo "$WEBHOOK_PAYLOAD" | jq -r '.error.errorId // empty')
BUGSNAG_ERROR_URL=$(echo "$WEBHOOK_PAYLOAD" | jq -r '.error.url // empty')
BUGSNAG_ERROR_CLASS=$(echo "$WEBHOOK_PAYLOAD" | jq -r '.error.exceptionClass // empty')
BUGSNAG_ERROR_MESSAGE=$(echo "$WEBHOOK_PAYLOAD" | jq -r '.error.message // empty')
BUGSNAG_CONTEXT=$(echo "$WEBHOOK_PAYLOAD" | jq -r '.error.context // empty')
BUGSNAG_RELEASE_STAGE=$(echo "$WEBHOOK_PAYLOAD" | jq -r '.error.app.releaseStage // empty')
BUGSNAG_APP_VERSION=$(echo "$WEBHOOK_PAYLOAD" | jq -r '.error.app.version // empty')

echo "Project: $BUGSNAG_PROJECT_NAME"
echo "Error ID: $BUGSNAG_ERROR_ID"
echo "Error URL: $BUGSNAG_ERROR_URL"
echo "Error Class: $BUGSNAG_ERROR_CLASS"
echo "Error Message: $BUGSNAG_ERROR_MESSAGE"
echo "Context: $BUGSNAG_CONTEXT"
echo "Release Stage: $BUGSNAG_RELEASE_STAGE"
echo "App Version: $BUGSNAG_APP_VERSION"

if [ -z "$BUGSNAG_ERROR_ID" ]; then
  echo "Error: Could not extract error ID from webhook payload"
  exit 1
fi

# Extract and format stack trace
BUGSNAG_STACK_TRACE=$(echo "$WEBHOOK_PAYLOAD" | jq -r '
  if .error.exceptions then
    .error.exceptions[0].stacktrace
  elif .error.stackTrace then
    .error.stackTrace
  else
    []
  end |
  map(
    if .inProject then "* " else "  " end +
    (.file // "unknown") + ":" + (.lineNumber // "?" | tostring) +
    " in " + (.method // "unknown")
  ) | join("\n")
')

if [ -z "$BUGSNAG_STACK_TRACE" ] || [ "$BUGSNAG_STACK_TRACE" = "null" ]; then
  echo "Warning: No stack trace found in webhook payload"
  BUGSNAG_STACK_TRACE="No stack trace available"
fi

echo "Stack trace extracted (first 5 lines):"
echo "$BUGSNAG_STACK_TRACE" | head -n 5

export BUGSNAG_ERROR_ID
export BUGSNAG_ERROR_URL
export BUGSNAG_PROJECT_NAME
export BUGSNAG_ERROR_CLASS
export BUGSNAG_ERROR_MESSAGE
export BUGSNAG_CONTEXT
export BUGSNAG_STACK_TRACE
export BUGSNAG_RELEASE_STAGE
export BUGSNAG_APP_VERSION

echo "Uploading fix-bugsnag-error pipeline"
generate_fix_bugsnag_pipeline | buildkite-agent pipeline upload
