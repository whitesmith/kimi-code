# Kimi Code CLI

A CLI tool that starts the anthropic-proxy server configured for Groq API with Kimi model and then runs claude-code. When claude-code exits, the proxy is automatically stopped.

## Installation

```bash
npm install -g kimi-code
```

Or run directly with npx:

```bash
npx kimi-code
```

## Usage

```bash
# First time - will prompt for Groq API key and store it in keychain
kimi

# Using command line option to set/update API key
kimi --api-key your-groq-api-key

# With custom port
kimi --port 3001

# With custom models
kimi --reasoning-model "llama3-70b-8192" --completion-model "llama3-8b-8192"

# Enable debug logging
kimi --debug

# Reset stored API key
kimi --reset-key
```

## Options

- `-k, --api-key <key>`: Groq API key (will be stored in macOS keychain)
- `-p, --port <port>`: Port for the proxy server (default: 3000)
- `--reasoning-model <model>`: Reasoning model to use (default: moonshotai/kimi-k2-instruct)
- `--completion-model <model>`: Completion model to use (default: moonshotai/kimi-k2-instruct)
- `--debug`: Enable debug logging
- `--reset-key`: Reset the stored API key

## Features

- 🔐 **Secure Key Storage**: API keys are stored securely in macOS keychain
- 🤖 **Kimi Model**: Uses Moonshot AI's Kimi K2 Instruct model by default
- 🚀 **Simple Setup**: Just run `kimi` and it handles everything
- 🔄 **Auto Cleanup**: Automatically stops proxy when claude-code exits

## Requirements

- Node.js 14 or higher
- macOS (for keychain integration)
- `claude-code` installed and available in PATH

## Getting a Groq API Key

1. Visit [Groq Console](https://console.groq.com/keys)
2. Sign up or log in
3. Create a new API key
4. Run `kimi` and enter your key when prompted

## How it works

1. Securely retrieves or prompts for your Groq API key
2. Starts a built-in proxy server that translates Anthropic API calls to Groq API format
3. Configures the proxy to use Groq's API endpoint (`https://api.groq.com/openai`) with Kimi models
4. Sets the `ANTHROPIC_BASE_URL` environment variable to point to the local proxy
5. Launches claude-code with the configured environment
6. When claude-code exits, automatically stops the proxy server

## Troubleshooting

### Keychain Issues
If you encounter keychain permission issues, you can:
1. Run `kimi --reset-key` to clear stored credentials
2. Use `kimi --api-key your-key` to bypass keychain storage

### API Key Management
- To update your API key: `kimi --api-key new-key`
- To reset stored key: `kimi --reset-key`
- Keys are stored under service "kimi-code" in your keychain

## License

MIT

## Thanks

Anthropic proxy code is based on https://github.com/maxnowack/anthropic-proxy
