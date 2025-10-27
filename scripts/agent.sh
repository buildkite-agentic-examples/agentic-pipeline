#!/bin/bash

set -euo pipefail

# Setup Buildkite Hosted Models
export ANTHROPIC_BASE_URL="$BUILDKITE_AGENT_ENDPOINT/ai/anthropic"
export ANTHROPIC_API_KEY="$BUILDKITE_AGENT_ACCESS_TOKEN"

# Configure GitHub authentication using gh CLI if GITHUB_TOKEN is available
if [ -n "$GITHUB_TOKEN" ]; then
    echo "Configuring GitHub authentication with gh CLI..."
    echo "$GITHUB_TOKEN" | gh auth login --with-token || {
        echo "Warning: Failed to authenticate with gh CLI, falling back to git token authentication"
    }

    # Verify gh authentication and setup git integration
    if gh auth status >/dev/null 2>&1; then
        echo "Successfully authenticated with GitHub via gh CLI"
        gh auth setup-git || {
            echo "Warning: Failed to setup git integration with gh CLI"
        }
    else
        echo "Warning: gh CLI authentication verification failed"
    fi
fi

# Parse arguments
if [ $# -lt 1 ]; then
    echo "Usage: $0 <prompt_file> [KEY=VALUE ...]"
    echo ""
    echo "Arguments:"
    echo "  prompt_file    Path to the prompt markdown file"
    echo "  KEY=VALUE      Optional key-value pairs for token replacement"
    echo ""
    echo "Example:"
    echo "  $0 prompts/buildkite-build.md BuildURL=https://example.com/build/123"
    exit 1
fi

PROMPT_FILE="$1"
shift

# Verify prompt file exists
if [ ! -f "$PROMPT_FILE" ]; then
    echo "Error: Prompt file not found: $PROMPT_FILE"
    exit 1
fi

# Load system prompt append
SYSTEM_PROMPT_APPEND=$(cat "prompts/system-prompt-append.md") || {
    echo "Failed to read system_prompt_append.md file"
    exit 1
}

# Read prompt content
prompt_content=$(cat "$PROMPT_FILE") || {
    echo "Failed to read prompt file: $PROMPT_FILE"
    exit 1
}

echo "--- :scroll: Processing prompt: $PROMPT_FILE"

# Perform token replacements from arguments
for arg in "$@"; do
    if [[ "$arg" =~ ^([A-Za-z0-9_]+)=(.*)$ ]]; then
        key="${BASH_REMATCH[1]}"
        value="${BASH_REMATCH[2]}"
        echo "Replacing {{.$key}} with: $value"
        prompt_content="${prompt_content//\{\{.$key\}\}/$value}"
    else
        echo "Warning: Ignoring invalid argument format: $arg (expected KEY=VALUE)"
    fi
done

echo "--- :robot_face: Starting Claude agent"
echo "Files in current directory:"
ls -lash

echo "$prompt_content" | claude \
    --mcp-config .mcp.json \
    --strict-mcp-config \
    -p \
    --verbose \
    --output-format=stream-json \
    --debug \
    --permission-mode bypassPermissions \
    --append-system-prompt "$SYSTEM_PROMPT_APPEND" | ./chat-parser -
