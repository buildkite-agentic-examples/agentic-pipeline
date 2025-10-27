# Claude Code Chat Parser

A Go CLI tool that parses Claude Code streaming JSON output and presents it as a human-readable chat transcript.

## Overview

When running Claude Code in non-interactive mode, it emits streaming JSON output. This tool takes that output and converts it into a readable chat transcript format showing the conversation between the system, user, and assistant.

## Installation

Build the tool:

```bash
go build -o chat-parser chat-parser/main.go
```

## Usage

### From file:
```bash
./chat-parser output.json
```

### From stdin:
```bash
cat output.json | ./chat-parser -
```

## Output Format

The tool produces output in this format:

```
=== Claude Code Chat Transcript ===

[001] [15:04:05] SYSTEM:  Building first-draft MCP server...
[002] [15:04:05] SYSTEM:  Created temporary directory: /tmp/xyz
[003] [15:04:05] SYSTEM:  Session initialized (ID: abc123, Model: claude-opus-4)

[004] [15:04:05] ASSISTANT: I'll help you solve Linear Issue JW-88...
                          [Tokens: 2 in, 3 out]

[005] [15:04:05] ASSISTANT: [Using tool: get_linear_ticket with {"ticket_id":"JW-88"}]
                          [Tokens: 2 in, 99 out]

[006] [15:04:05] USER:    [Tool result received]
```

## Features

- **Line numbers**: Shows original line numbers from the streaming output
- **Timestamps**: Adds parsing timestamps for reference
- **Message types**: Clearly identifies SYSTEM, ASSISTANT, and USER messages
- **Tool usage**: Shows when tools are being used and with what parameters
- **Token usage**: Displays input/output token counts for assistant messages
- **Truncation**: Long tool results are truncated for readability

## JSON Message Types

The tool handles these JSON message types from Claude Code:

- `{"type":"system"}` - System initialization and status messages
- `{"type":"assistant"}` - Assistant responses (text and tool usage)
- `{"type":"user"}` - User messages (typically tool results)

## Examples

See the `output.json` file in this repository for a sample of Claude Code streaming output that can be parsed with this tool.
