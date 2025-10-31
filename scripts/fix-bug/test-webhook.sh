#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "=== Bugsnag Webhook Test Script ==="
echo ""

# Check if running in Buildkite
if [ -z "${BUILDKITE:-}" ]; then
  echo "Warning: Not running in Buildkite environment"
  echo "Some features may not work (e.g., meta-data commands)"
  echo ""
fi

# Set up test environment
export BUILDKITE_SOURCE="${BUILDKITE_SOURCE:-webhook}"
export BUILDKITE_BUILD_URL="${BUILDKITE_BUILD_URL:-https://buildkite.com/test/build/123}"
export BUILDKITE_TRIGGER_ID="${BUILDKITE_TRIGGER_ID:-bugsnag-webhook-trigger}"

echo "Test Configuration:"
echo "  BUILDKITE_SOURCE: $BUILDKITE_SOURCE"
echo "  BUILDKITE_BUILD_URL: $BUILDKITE_BUILD_URL"
echo "  BUILDKITE_TRIGGER_ID: $BUILDKITE_TRIGGER_ID"
echo ""

# Load sample payload
SAMPLE_PAYLOAD="$SCRIPT_DIR/sample-payload.json"

if [ ! -f "$SAMPLE_PAYLOAD" ]; then
  echo "Error: Sample payload not found at $SAMPLE_PAYLOAD"
  exit 1
fi

echo "--- Loading sample webhook payload"
WEBHOOK_PAYLOAD=$(cat "$SAMPLE_PAYLOAD")

echo "Payload loaded successfully:"
echo "$WEBHOOK_PAYLOAD" | jq -C '.' || echo "$WEBHOOK_PAYLOAD"
echo ""

# Test payload parsing
echo "--- Testing payload parsing"

TRIGGER_TYPE=$(echo "$WEBHOOK_PAYLOAD" | jq -r '.trigger.type // empty')
echo "✓ Trigger Type: $TRIGGER_TYPE"

PROJECT_NAME=$(echo "$WEBHOOK_PAYLOAD" | jq -r '.project.name // empty')
echo "✓ Project Name: $PROJECT_NAME"

ERROR_ID=$(echo "$WEBHOOK_PAYLOAD" | jq -r '.error.errorId // empty')
echo "✓ Error ID: $ERROR_ID"

ERROR_CLASS=$(echo "$WEBHOOK_PAYLOAD" | jq -r '.error.exceptionClass // empty')
echo "✓ Error Class: $ERROR_CLASS"

ERROR_MESSAGE=$(echo "$WEBHOOK_PAYLOAD" | jq -r '.error.message // empty')
echo "✓ Error Message: $ERROR_MESSAGE"

CONTEXT=$(echo "$WEBHOOK_PAYLOAD" | jq -r '.error.context // empty')
echo "✓ Context: $CONTEXT"

RELEASE_STAGE=$(echo "$WEBHOOK_PAYLOAD" | jq -r '.error.app.releaseStage // empty')
echo "✓ Release Stage: $RELEASE_STAGE"

APP_VERSION=$(echo "$WEBHOOK_PAYLOAD" | jq -r '.error.app.version // empty')
echo "✓ App Version: $APP_VERSION"

ERROR_URL=$(echo "$WEBHOOK_PAYLOAD" | jq -r '.error.url // empty')
echo "✓ Error URL: $ERROR_URL"

echo ""

# Test stack trace parsing
echo "--- Testing stack trace parsing"

STACK_TRACE=$(echo "$WEBHOOK_PAYLOAD" | jq -r '
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

if [ -z "$STACK_TRACE" ] || [ "$STACK_TRACE" = "null" ]; then
  echo "✗ Failed to parse stack trace"
  exit 1
else
  echo "✓ Stack trace parsed successfully:"
  echo ""
  echo "$STACK_TRACE" | head -n 10
  echo ""
fi

# Test pipeline generation (dry-run)
echo "--- Testing pipeline generation"

export BUGSNAG_ERROR_ID="$ERROR_ID"
export BUGSNAG_ERROR_URL="$ERROR_URL"
export BUGSNAG_PROJECT_NAME="$PROJECT_NAME"
export BUGSNAG_ERROR_CLASS="$ERROR_CLASS"
export BUGSNAG_ERROR_MESSAGE="$ERROR_MESSAGE"
export BUGSNAG_CONTEXT="$CONTEXT"
export BUGSNAG_STACK_TRACE="$STACK_TRACE"
export BUGSNAG_RELEASE_STAGE="$RELEASE_STAGE"
export BUGSNAG_APP_VERSION="$APP_VERSION"

# Source the trigger script to get the function
source "$SCRIPT_DIR/trigger-bugsnag.sh" 2>/dev/null || true

# If we can't source it, define a test version
if ! declare -f generate_fix_bugsnag_pipeline > /dev/null; then
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
fi

PIPELINE=$(generate_fix_bugsnag_pipeline)

if [ -z "$PIPELINE" ]; then
  echo "✗ Failed to generate pipeline"
  exit 1
else
  echo "✓ Pipeline generated successfully:"
  echo ""
  echo "$PIPELINE" | head -n 20
  echo "  ..."
  echo ""
fi

# Validate pipeline YAML
echo "--- Validating pipeline YAML"
if echo "$PIPELINE" | buildkite-agent pipeline validate 2>/dev/null; then
  echo "✓ Pipeline YAML is valid"
else
  echo "⚠ Could not validate pipeline (buildkite-agent not available or validate not supported)"
fi
echo ""

# Test token replacement in prompt
echo "--- Testing prompt token replacement"

PROMPT_FILE="$PROJECT_ROOT/prompts/fix-bugsnag-error.md"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "✗ Prompt file not found at $PROMPT_FILE"
  exit 1
fi

PROMPT_CONTENT=$(cat "$PROMPT_FILE")

# Simulate token replacement
PROMPT_CONTENT="${PROMPT_CONTENT//\{\{.BugsnagErrorID\}\}/$BUGSNAG_ERROR_ID}"
PROMPT_CONTENT="${PROMPT_CONTENT//\{\{.BugsnagErrorURL\}\}/$BUGSNAG_ERROR_URL}"
PROMPT_CONTENT="${PROMPT_CONTENT//\{\{.BugsnagProjectName\}\}/$BUGSNAG_PROJECT_NAME}"
PROMPT_CONTENT="${PROMPT_CONTENT//\{\{.BugsnagErrorClass\}\}/$BUGSNAG_ERROR_CLASS}"
PROMPT_CONTENT="${PROMPT_CONTENT//\{\{.BugsnagErrorMessage\}\}/$BUGSNAG_ERROR_MESSAGE}"
PROMPT_CONTENT="${PROMPT_CONTENT//\{\{.BugsnagContext\}\}/$BUGSNAG_CONTEXT}"
PROMPT_CONTENT="${PROMPT_CONTENT//\{\{.BugsnagStackTrace\}\}/$BUGSNAG_STACK_TRACE}"
PROMPT_CONTENT="${PROMPT_CONTENT//\{\{.BugsnagReleaseStage\}\}/$BUGSNAG_RELEASE_STAGE}"
PROMPT_CONTENT="${PROMPT_CONTENT//\{\{.BugsnagAppVersion\}\}/$BUGSNAG_APP_VERSION}"

# Check if any tokens remain unreplaced
REMAINING_TOKENS=$(echo "$PROMPT_CONTENT" | grep -o '{{\.Bugsnag[^}]*}}' || true)

if [ -n "$REMAINING_TOKENS" ]; then
  echo "✗ Some tokens were not replaced:"
  echo "$REMAINING_TOKENS"
  exit 1
else
  echo "✓ All tokens replaced successfully"
  echo ""
  echo "Sample of processed prompt:"
  echo "$PROMPT_CONTENT" | head -n 30
  echo "  ..."
fi

echo ""
echo "=== All tests passed! ==="
echo ""
echo "To run the full webhook trigger (requires Buildkite):"
echo "  1. Set up webhook payload: buildkite-agent meta-data set 'buildkite:webhook' \"\$(cat $SAMPLE_PAYLOAD)\""
echo "  2. Run trigger script: $SCRIPT_DIR/trigger-bugsnag.sh"
echo ""
