#!/usr/bin/env bash

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

# Check if repository URL is provided
if [ $# -lt 1 ]; then
    log_error "Usage: $0 <repository_url> [target_directory]"
    exit 1
fi

REPO_URL="$1"
TARGET_DIR="${2:-}"

# Extract repository name from URL if target directory not provided
if [ -z "$TARGET_DIR" ]; then
    TARGET_DIR=$(basename "$REPO_URL" .git)
fi

log_info "Cloning repository: $REPO_URL"
log_info "Target directory: $TARGET_DIR"

# Clone the repository
if [ -d "$TARGET_DIR" ]; then
    log_warning "Directory $TARGET_DIR already exists"
    read -p "Do you want to remove it and re-clone? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        log_info "Removing existing directory..."
        rm -rf "$TARGET_DIR"
    else
        log_info "Using existing directory..."
    fi
fi

if [ ! -d "$TARGET_DIR" ]; then
    git clone "$REPO_URL" "$TARGET_DIR"
    log_info "Repository cloned successfully"
fi

# Change to the repository directory
cd "$TARGET_DIR"

# Check if Gemfile exists and run bundle install
if [ -f "Gemfile" ]; then
    log_info "Gemfile detected, running bundle install..."

    # Check if bundler is installed
    if ! command -v bundle &> /dev/null; then
        log_warning "Bundler not found, installing..."
        gem install bundler
    fi

    bundle install
    log_info "Bundle install completed successfully!"
else
    log_warning "No Gemfile found in repository"
fi

# Check if package.json exists and run npm/yarn install
if [ -f "package.json" ]; then
    log_info "package.json detected, installing dependencies..."

    # Prefer yarn if yarn.lock exists and yarn is available
    if [ -f "yarn.lock" ] && command -v yarn &> /dev/null; then
        log_info "Using yarn..."
        yarn install
    elif command -v npm &> /dev/null; then
        log_info "Using npm..."
        npm install
    else
        log_warning "Neither npm nor yarn found, skipping JavaScript dependencies"
    fi

    log_info "JavaScript dependencies installed successfully!"
else
    log_warning "No package.json found in repository"
fi

# Check if go.mod exists and run go mod download
if [ -f "go.mod" ]; then
    log_info "go.mod detected, downloading dependencies..."

    # Check if go is installed
    if command -v go &> /dev/null; then
        go mod download
        log_info "Go dependencies downloaded successfully!"
    else
        log_warning "Go not found, skipping Go dependencies"
    fi
else
    log_warning "No go.mod found in repository"
fi

log_info "Project ready at: $(pwd)"
