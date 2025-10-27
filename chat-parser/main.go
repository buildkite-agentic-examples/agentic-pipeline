package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"
)

// ANSI color codes
const (
	ColorReset   = "\033[0m"
	ColorBold    = "\033[1m"
	ColorDim     = "\033[2m"
	ColorRed     = "\033[31m"
	ColorGreen   = "\033[32m"
	ColorYellow  = "\033[33m"
	ColorBlue    = "\033[34m"
	ColorMagenta = "\033[35m"
	ColorCyan    = "\033[36m"
	ColorWhite   = "\033[37m"
	ColorGray    = "\033[90m"
)

var staticLineNum int
var startTime time.Time

// formatRelativeTime formats duration since start as MM:SS or HH:MM:SS
func formatRelativeTime(elapsed time.Duration) string {
	totalSeconds := int(elapsed.Seconds())
	hours := totalSeconds / 3600
	minutes := (totalSeconds % 3600) / 60
	seconds := totalSeconds % 60

	if hours > 0 {
		return fmt.Sprintf("%02d:%02d:%02d", hours, minutes, seconds)
	}
	return fmt.Sprintf("%02d:%02d", minutes, seconds)
}

// createBuildkiteAnnotation creates a Buildkite annotation by parsing the raw JSON line
func createBuildkiteAnnotation(rawJSONLine string, lineNumber int, timestamp string) {
	// Skip empty lines
	rawJSONLine = strings.TrimSpace(rawJSONLine)
	if rawJSONLine == "" {
		return
	}

	// Create markdown content for the annotation
	var markdownContent strings.Builder
	var speaker string
	var content string
	var hasError bool
	var style string = "info" // default style

	// Add timestamp and line number
	markdownContent.WriteString(fmt.Sprintf("**Message %d** - `%s`\n\n", lineNumber, timestamp))

	// Try to parse as JSON to extract clean content
	if strings.HasPrefix(rawJSONLine, "{") {
		var msg Message
		if err := json.Unmarshal([]byte(rawJSONLine), &msg); err == nil {
			// Extract clean content from JSON without ANSI codes and check for errors
			speaker, content, hasError = extractCleanJSONContentWithErrorCheck(msg)

			// Skip annotation for unknown message types
			if content == "Unknown message type" {
				return
			}
		} else {
			// Not valid JSON, treat as plain text
			speaker = "SYSTEM"
			content = rawJSONLine
		}
	} else {
		// Plain text line
		speaker = "SYSTEM"
		content = rawJSONLine
	}

	// Add speaker with appropriate styling
	switch speaker {
	case "ASSISTANT":
		markdownContent.WriteString("🤖 **ASSISTANT**:\n\n")
		style = "info"
	case "USER":
		markdownContent.WriteString("👤 **USER**:\n\n")
		if hasError {
			style = "error"
		} else {
			style = "success"
		}
	case "SYSTEM":
		markdownContent.WriteString("⚙️ **SYSTEM**:\n\n")
		style = "warning"
	default:
		markdownContent.WriteString(fmt.Sprintf("**%s**:\n\n", speaker))
		style = "info"
	}

	// Add clean content (no ANSI codes)
	if content != "" {
		markdownContent.WriteString(content)
	}

	// Add raw JSON disclosure at the end with pretty formatting
	markdownContent.WriteString("\n\n<details>\n<summary>Show JSON</summary>\n\n```json\n")

	// Pretty-format the JSON if possible
	if strings.HasPrefix(rawJSONLine, "{") {
		var jsonObj interface{}
		if err := json.Unmarshal([]byte(rawJSONLine), &jsonObj); err == nil {
			if prettyJSON, err := json.MarshalIndent(jsonObj, "", "  "); err == nil {
				markdownContent.WriteString(string(prettyJSON))
			} else {
				// Fallback to raw JSON if formatting fails
				markdownContent.WriteString(rawJSONLine)
			}
		} else {
			// Fallback to raw JSON if parsing fails
			markdownContent.WriteString(rawJSONLine)
		}
	} else {
		// Not JSON, just show as-is
		markdownContent.WriteString(rawJSONLine)
	}

	markdownContent.WriteString("\n```\n\n</details>")

	// Create context to ensure unique annotations
	context := fmt.Sprintf("chat-message-%d", lineNumber)

	// Execute buildkite-agent annotate command
	cmd := exec.Command("buildkite-agent", "annotate",
		"--style", style,
		"--context", context,
		"--priority", "5")

	cmd.Stdin = strings.NewReader(markdownContent.String())

	// Run the command and capture any errors
	if err := cmd.Run(); err != nil {
		log.Printf("Warning: Failed to create Buildkite annotation: %v", err)
	}
}

// extractCleanJSONContentWithErrorCheck extracts clean content from JSON message without ANSI codes and detects errors
func extractCleanJSONContentWithErrorCheck(msg Message) (speaker, content string, hasError bool) {
	switch msg.Type {
	case "system":
		if msg.Subtype == "init" {
			return "SYSTEM", fmt.Sprintf("Session initialized (ID: %s, Model: %s)",
				msg.SessionID, msg.Model), false
		}
		return "SYSTEM", "System message", false

	case "assistant":
		speaker = "ASSISTANT"
		if len(msg.Message.Content) > 0 {
			var contentParts []string
			for _, contentItem := range msg.Message.Content {
				switch contentItem.Type {
				case "text":
					if contentItem.Text != "" {
						contentParts = append(contentParts, contentItem.Text)
					}
				case "tool_use":
					toolInput := ""
					if contentItem.Input != nil {
						if inputBytes, err := json.MarshalIndent(contentItem.Input, "", "  "); err == nil {
							toolInput = string(inputBytes)
						}
					}

					toolDesc := fmt.Sprintf("🔧 Using tool: %s", contentItem.Name)
					if toolInput != "" && toolInput != "{}" {
						// Check if content needs progressive disclosure (multiple lines OR very long)
						lines := strings.Split(toolInput, "\n")
						const maxPreviewLength = 300

						needsDisclosure := len(lines) > 2 || len(toolInput) > maxPreviewLength

						if !needsDisclosure {
							// Short input, show it all
							toolDesc += fmt.Sprintf(" with %s", toolInput)
						} else {
							// Long input, show preview and put rest in disclosure
							var preview, remaining string

							if len(lines) > 2 {
								// Multiple lines: show first 2 lines
								preview = strings.Join(lines[:2], "\n")
								remaining = strings.Join(lines[2:], "\n")
							} else {
								// Single long line: truncate at reasonable length
								if len(toolInput) > maxPreviewLength {
									preview = toolInput[:maxPreviewLength] + "..."
									remaining = toolInput[maxPreviewLength:]
								} else {
									preview = toolInput
									remaining = ""
								}
							}

							if remaining != "" {
								// Use HTML details/summary for collapsible content
								toolDesc += fmt.Sprintf(" with %s\n\n<details>\n<summary>Show more input...</summary>\n\n```json\n%s\n```\n\n</details>",
									preview, remaining)
							} else {
								toolDesc += fmt.Sprintf(" with %s", preview)
							}
						}
					}
					contentParts = append(contentParts, toolDesc)
				}
			}
			content = strings.Join(contentParts, "\n\n")
		}
		return speaker, content, false

	case "user":
		speaker = "USER"
		hasError = false
		if len(msg.Message.Content) > 0 {
			var contentParts []string
			for _, contentItem := range msg.Message.Content {
				if contentItem.Type == "tool_result" {
					// Check for errors in tool results
					if contentItem.IsError {
						hasError = true
					}

					// Extract and display the actual tool result content
					var resultContent string
					if contentItem.Text != "" {
						resultContent = contentItem.Text
						// Try to pretty-format if it's JSON
						if json.Valid([]byte(resultContent)) {
							var jsonObj interface{}
							if err := json.Unmarshal([]byte(resultContent), &jsonObj); err == nil {
								if prettyBytes, err := json.MarshalIndent(jsonObj, "", "  "); err == nil {
									resultContent = string(prettyBytes)
								}
							}
						}
					} else if contentItem.Content != nil {
						// Try to extract content from the Content field
						if contentBytes, err := json.MarshalIndent(contentItem.Content, "", "  "); err == nil {
							resultContent = string(contentBytes)
						}
					}

					if resultContent != "" {
						errorIndicator := "✅ Tool result:"
						if contentItem.IsError {
							errorIndicator = "❌ Tool error:"
						}

						// Check if content needs progressive disclosure (multiple lines OR very long)
						lines := strings.Split(resultContent, "\n")
						const maxPreviewLength = 400

						needsDisclosure := len(lines) > 2 || len(resultContent) > maxPreviewLength

						if !needsDisclosure {
							// Short content, show it all
							contentParts = append(contentParts, errorIndicator+"\n"+resultContent)
						} else {
							// Long content, show preview and put rest in disclosure
							var preview, remaining string

							if len(lines) > 2 {
								// Multiple lines: show first 2 lines
								preview = strings.Join(lines[:2], "\n")
								remaining = strings.Join(lines[2:], "\n")
							} else {
								// Single long line: truncate at reasonable length
								if len(resultContent) > maxPreviewLength {
									preview = resultContent[:maxPreviewLength] + "..."
									remaining = resultContent[maxPreviewLength:]
								} else {
									preview = resultContent
									remaining = ""
								}
							}

							if remaining != "" {
								// Use HTML details/summary for collapsible content
								disclosureContent := fmt.Sprintf("%s\n%s\n\n<details>\n<summary>Show more...</summary>\n\n```\n%s\n```\n\n</details>",
									errorIndicator, preview, remaining)
								contentParts = append(contentParts, disclosureContent)
							} else {
								contentParts = append(contentParts, errorIndicator+"\n"+preview)
							}
						}
					} else {
						contentParts = append(contentParts, "✅ Tool result received")
					}
				} else if contentItem.Text != "" {
					contentParts = append(contentParts, contentItem.Text)
				}
			}
			content = strings.Join(contentParts, "\n\n")
		}
		return speaker, content, hasError

	default:
		speaker = strings.ToUpper(msg.Type)
		content = "Unknown message type"
		return speaker, content, false
	}
}

// Message represents a Claude Code streaming message
type Message struct {
	Type    string `json:"type"`
	Subtype string `json:"subtype,omitempty"`
	Message struct {
		ID      string `json:"id"`
		Type    string `json:"type"`
		Role    string `json:"role"`
		Model   string `json:"model,omitempty"`
		Content []struct {
			Type      string      `json:"type"`
			Text      string      `json:"text,omitempty"`
			ID        string      `json:"id,omitempty"`
			Name      string      `json:"name,omitempty"`
			Input     interface{} `json:"input,omitempty"`
			ToolUseID string      `json:"tool_use_id,omitempty"`
			Content   interface{} `json:"content,omitempty"`
			IsError   bool        `json:"is_error,omitempty"`
		} `json:"content"`
		Usage struct {
			InputTokens  int `json:"input_tokens"`
			OutputTokens int `json:"output_tokens"`
		} `json:"usage,omitempty"`
	} `json:"message,omitempty"`
	SessionID string   `json:"session_id,omitempty"`
	Tools     []string `json:"tools,omitempty"`
	Model     string   `json:"model,omitempty"`
}

// ChatEntry represents a formatted chat entry
type ChatEntry struct {
	LineNumber int
	Speaker    string
	Content    string
	Timestamp  string
	IsJSON     bool
	RawLine    string
}

func main() {
	// Initialize start time for relative timestamps
	startTime = time.Now()

	var outputFile string
	var inputSource string

	// Parse command line arguments
	args := os.Args[1:]
	if len(args) == 0 {
		printUsage()
		os.Exit(1)
	}

	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "-o":
			if i+1 >= len(args) {
				fmt.Println("Error: -o requires a filename")
				printUsage()
				os.Exit(1)
			}
			outputFile = args[i+1]
			i++ // Skip the next argument as it's the filename
		case "-":
			inputSource = "-"
		default:
			if inputSource == "" {
				inputSource = args[i]
			} else {
				fmt.Printf("Error: unexpected argument '%s'\n", args[i])
				printUsage()
				os.Exit(1)
			}
		}
	}

	if inputSource == "" {
		printUsage()
		os.Exit(1)
	}

	var scanner *bufio.Scanner
	isStreaming := false

	if inputSource == "-" {
		// Read from stdin
		scanner = bufio.NewScanner(os.Stdin)
		isStreaming = true
	} else {
		// Read from file
		file, err := os.Open(inputSource)
		if err != nil {
			log.Fatalf("Error opening file: %v", err)
		}
		defer file.Close()
		scanner = bufio.NewScanner(file)
	}

	// Validate -o option usage
	if outputFile != "" && !isStreaming {
		fmt.Println("Error: -o option can only be used when streaming from stdin")
		os.Exit(1)
	}

	// Print colorful header and process input line by line
	fmt.Printf("%s%s=== Claude Code Chat Transcript ===%s\n", ColorCyan, ColorBold, ColorReset)
	fmt.Println()

	if outputFile != "" {
		parseAndStreamOutputWithFile(scanner, outputFile)
	} else {
		parseAndStreamOutput(scanner)
	}
}

func printUsage() {
	fmt.Println("Usage: chat-parser <input-file>")
	fmt.Println("       cat <input-file> | chat-parser -")
	fmt.Println("       cat <input-file> | chat-parser - -o <output-file>")
	fmt.Println("")
	fmt.Println("Options:")
	fmt.Println("  -o <file>    Save output to file (only when streaming from stdin)")
}

// parseAndStreamOutput processes input line by line and prints entries immediately
func parseAndStreamOutput(scanner *bufio.Scanner) {
	for scanner.Scan() {
		line := scanner.Text()
		entry := parseLine(line)
		if entry != nil {
			printSingleEntry(*entry)
			createBuildkiteAnnotation(line, entry.LineNumber, entry.Timestamp)
		}
	}

	if err := scanner.Err(); err != nil {
		log.Fatalf("Error reading input: %v", err)
	}
}

// parseAndStreamOutputWithFile processes input and outputs to both stdout and file
func parseAndStreamOutputWithFile(scanner *bufio.Scanner, outputFilename string) {
	// Create/open output file
	outputFile, err := os.Create(outputFilename)
	if err != nil {
		log.Fatalf("Error creating output file '%s': %v", outputFilename, err)
	}
	defer outputFile.Close()

	for scanner.Scan() {
		line := scanner.Text()

		// Write raw JSON line to file
		fmt.Fprintln(outputFile, line)

		// Parse and display the line
		entry := parseLine(line)
		if entry != nil {
			// Print to stdout with colors
			printSingleEntry(*entry)
			// Create Buildkite annotation
			createBuildkiteAnnotation(line, entry.LineNumber, entry.Timestamp)
		}
	}

	if err := scanner.Err(); err != nil {
		log.Fatalf("Error reading input: %v", err)
	}
}

func parseLine(line string) *ChatEntry {
	line = strings.TrimSpace(line)
	if line == "" {
		return nil
	}

	// Use a static line counter since the file doesn't have line numbers
	staticLineNum++

	entry := &ChatEntry{
		LineNumber: staticLineNum,
		RawLine:    line,
		Timestamp:  formatRelativeTime(time.Since(startTime)),
	}

	content := line

	// Try to parse as JSON
	if strings.HasPrefix(content, "{") {
		var msg Message
		if err := json.Unmarshal([]byte(content), &msg); err == nil {
			entry.IsJSON = true
			entry.Speaker, entry.Content = formatJSONMessage(msg)
		} else {
			// Not valid JSON, treat as plain text
			entry.Speaker = "SYSTEM"
			entry.Content = content
		}
	} else {
		// Plain text line
		entry.Speaker = "SYSTEM"
		entry.Content = content
	}

	return entry
}

func formatJSONMessage(msg Message) (speaker, content string) {
	switch msg.Type {
	case "system":
		if msg.Subtype == "init" {
			return "SYSTEM", fmt.Sprintf("Session initialized (ID: %s, Model: %s)",
				msg.SessionID, msg.Model)
		}
		return "SYSTEM", "System message"

	case "assistant":
		speaker = "ASSISTANT"
		if len(msg.Message.Content) > 0 {
			var contentParts []string
			for _, content := range msg.Message.Content {
				switch content.Type {
				case "text":
					if content.Text != "" {
						contentParts = append(contentParts, content.Text)
					}
				case "tool_use":
					toolInput := ""
					if content.Input != nil {
						if inputBytes, err := json.Marshal(content.Input); err == nil {
							toolInput = string(inputBytes)
						}
					}
					contentParts = append(contentParts,
						fmt.Sprintf("%s🔧 Using tool: %s%s%s",
							ColorGreen,
							content.Name,
							func() string {
								if toolInput != "" && toolInput != "{}" {
									return " with " + toolInput
								}
								return ""
							}(),
							ColorReset))
				}
			}
			content = strings.Join(contentParts, "\n")

			// Add usage info if available
			// if msg.Message.Usage.OutputTokens > 0 {
			// 	content += fmt.Sprintf("\n[Tokens: %d in, %d out]",
			// 		msg.Message.Usage.InputTokens, msg.Message.Usage.OutputTokens)
			// }
		}

	case "user":
		speaker = "USER"
		if len(msg.Message.Content) > 0 {
			var contentParts []string
			for _, contentItem := range msg.Message.Content {
				if contentItem.Type == "tool_result" {
					// Extract and display the actual tool result content
					var resultContent string
					if contentItem.Text != "" {
						resultContent = contentItem.Text
						// Try to pretty-format if it's JSON
						if json.Valid([]byte(resultContent)) {
							var jsonObj interface{}
							if err := json.Unmarshal([]byte(resultContent), &jsonObj); err == nil {
								if prettyBytes, err := json.MarshalIndent(jsonObj, "", "  "); err == nil {
									resultContent = string(prettyBytes)
								}
							}
						}
					} else if contentItem.Content != nil {
						// Try to extract content from the Content field
						if contentBytes, err := json.MarshalIndent(contentItem.Content, "", "  "); err == nil {
							resultContent = string(contentBytes)
						}
					}

					if resultContent != "" {
						errorIndicator := ""
						if contentItem.IsError {
							errorIndicator = ColorRed + "❌ Tool error:" + ColorReset
						} else {
							errorIndicator = ColorMagenta + "✅ Tool result:" + ColorReset
						}
						contentParts = append(contentParts, errorIndicator+"\n"+resultContent)
					} else {
						contentParts = append(contentParts, ColorMagenta+"✅ Tool result received"+ColorReset)
					}
				} else if contentItem.Text != "" {
					contentParts = append(contentParts, contentItem.Text)
				}
			}
			content = strings.Join(contentParts, "\n")
		}

	default:
		speaker = strings.ToUpper(msg.Type)
		content = "Unknown message type"
	}

	return speaker, content
}

// printSingleEntry prints a single chat entry immediately (for streaming mode)
func printSingleEntry(entry ChatEntry) {
	if entry.Content == "" {
		return
	}

	// Choose color based on speaker
	var speakerColor, contentColor string
	switch entry.Speaker {
	case "ASSISTANT":
		speakerColor = ColorGreen + ColorBold
		contentColor = ColorGreen
	case "USER":
		speakerColor = ColorBlue + ColorBold
		contentColor = ColorBlue
	case "SYSTEM":
		speakerColor = ColorYellow + ColorBold
		contentColor = ColorGray
	default:
		speakerColor = ColorWhite
		contentColor = ColorWhite
	}

	// Format: [LINE:123] [MM:SS] SPEAKER: content
	prefix := fmt.Sprintf("%s[%03d] %s[%s]%s %s:%s",
		ColorGray, entry.LineNumber, ColorDim, entry.Timestamp, ColorReset, speakerColor+entry.Speaker, ColorReset)

	// Handle multi-line content
	lines := strings.Split(entry.Content, "\n")
	for i, line := range lines {
		if i == 0 {
			fmt.Printf("%-45s %s%s%s\n", prefix, contentColor, line, ColorReset)
		} else {
			fmt.Printf("%s%s%s\n", contentColor, line, ColorReset)
		}
	}

	// Add spacing between messages for readability
	if entry.IsJSON {
		fmt.Println()
	}
}
