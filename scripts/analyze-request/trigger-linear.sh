#!/bin/bash

set -euo pipefail

# Function to generate dynamic pipeline for Linear events
generate_linear_pipeline() {
  TOKEN_ARGS=(
    "LinearIssueID=$LINEAR_ISSUE_ID"
    "AgentBuildURL=$BUILDKITE_BUILD_URL"
  )

  cat <<EOF
secrets:
  LINEAR_API_TOKEN: LINEAR_API_TOKEN
  GITHUB_TOKEN: GITHUB_TOKEN
  BUILDKITE_API_TOKEN: API_TOKEN_BUILDKITE

steps:
  - command: "./agent.sh prompts/analyze-request.md ${TOKEN_ARGS[*]}"
    label: ":linear: Handle Issue Update"
    depends_on: ~
    plugins:
      - docker-compose#v5.11.0:
          run: buildy
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
            - "LINEAR_ISSUE_ID"
            - "LINEAR_ISSUE_TITLE"
            - "LINEAR_ISSUE_DESCRIPTION"
EOF
}

# Main Linear webhook processing logic
echo "--- :linear: Processing Linear webhook"

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

WEBHOOK_ACTION=$(echo "$WEBHOOK_PAYLOAD" | jq -r '.action // empty')

if [ -z "$WEBHOOK_ACTION" ]; then
  echo "Error: Could not determine webhook action"
  exit 1
fi

echo "Webhook action: $WEBHOOK_ACTION"

buildkite-agent meta-data set "webhook:action" "$WEBHOOK_ACTION"
buildkite-agent meta-data set "webhook:source" "linear"

case "$WEBHOOK_ACTION" in
  "create" | "update")
    echo "Processing $WEBHOOK_ACTION webhook"

    LINEAR_ISSUE_ID=$(echo "$WEBHOOK_PAYLOAD" | jq -r '.data.id // empty')
    LINEAR_ISSUE_TITLE=$(echo "$WEBHOOK_PAYLOAD" | jq -r '.data.title // empty')
    LINEAR_ISSUE_DESCRIPTION=$(echo "$WEBHOOK_PAYLOAD" | jq -r '.data.description // empty')
    LINEAR_ISSUE_STATE=$(echo "$WEBHOOK_PAYLOAD" | jq -r '.data.state.name // empty')

    echo "Issue ID: $LINEAR_ISSUE_ID"
    echo "Issue Title: $LINEAR_ISSUE_TITLE"
    echo "Issue State: $LINEAR_ISSUE_STATE"

    if [ -z "$LINEAR_ISSUE_ID" ]; then
      echo "Error: Could not extract issue ID from webhook payload"
      exit 1
    fi

    LINEAR_ISSUE_LABELS=$(echo "$WEBHOOK_PAYLOAD" | jq -r '.data.labels[]?.name // empty')

    echo "Issue Labels:"
    echo "$LINEAR_ISSUE_LABELS"

    if echo "$LINEAR_ISSUE_LABELS" | grep -q "^buildy-analysis$"; then
      echo "Issue has 'buildy-analysis' label, uploading pipeline"

      generate_linear_pipeline | buildkite-agent pipeline upload
    else
      echo "Issue does not have 'buildy-analysis' label, skipping pipeline upload"
    fi
    ;;
  *)
    echo "Ignoring Linear webhook action: $WEBHOOK_ACTION"
    ;;
esac
