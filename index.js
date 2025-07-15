#!/usr/bin/env node

const { spawn } = require('child_process');
const { program } = require('commander');
const keytar = require('keytar');
const readline = require('readline');
const { start: startProxyServer } = require('./proxy.js');

const SERVICE_NAME = 'kimi-code';
const ACCOUNT_NAME = 'groq-api-key';

program
  .name('kimi')
  .description('Start anthropic-proxy with Kimi model and run claude-code')
  .option('-k, --api-key <key>', 'Groq API key (will be stored in keychain)')
  .option('-p, --port <port>', 'Port for the proxy server', '3000')
  .option('--reasoning-model <model>', 'Reasoning model to use', 'moonshotai/kimi-k2-instruct')
  .option('--completion-model <model>', 'Completion model to use', 'moonshotai/kimi-k2-instruct')
  .option('--debug', 'Enable debug logging')
  .option('--reset-key', 'Reset the stored API key')
  .parse();

const options = program.opts();

let claudeProcess = null;

// Function to cleanup processes
function cleanup() {
  console.log('\nShutting down...');
  
  if (claudeProcess) {
    claudeProcess.kill('SIGTERM');
  }
  
  process.exit(0);
}

// Handle process termination
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Function to prompt for API key
function promptForApiKey() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    rl.question('Enter your Groq API key: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Function to get API key from keychain or prompt
async function getApiKey() {
  // If reset-key flag is used, delete the stored key
  if (options.resetKey) {
    try {
      await keytar.deletePassword(SERVICE_NAME, ACCOUNT_NAME);
      console.log('Stored API key has been reset.');
    } catch (error) {
      // Ignore error if key doesn't exist
    }
  }
  
  // Check if API key is provided via command line
  if (options.apiKey) {
    try {
      await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, options.apiKey);
      console.log('API key stored in keychain.');
      return options.apiKey;
    } catch (error) {
      console.error('Failed to store API key in keychain:', error.message);
      return options.apiKey;
    }
  }
  
  // Try to get API key from keychain
  try {
    const storedKey = await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
    if (storedKey) {
      console.log('Using stored API key from keychain.');
      return storedKey;
    }
  } catch (error) {
    console.error('Failed to retrieve API key from keychain:', error.message);
  }
  
  // Prompt for API key if not found
  console.log('No API key found. Please enter your Groq API key.');
  console.log('You can get one from: https://console.groq.com/keys');
  const newKey = await promptForApiKey();
  
  if (!newKey) {
    console.error('API key is required to continue.');
    process.exit(1);
  }
  
  // Store the new key in keychain
  try {
    await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, newKey);
    console.log('API key stored in keychain for future use.');
  } catch (error) {
    console.error('Failed to store API key in keychain:', error.message);
    console.log('Continuing with session-only API key...');
  }
  
  return newKey;
}

async function startProxy(apiKey) {
  console.log('Starting proxy server with Kimi model...');
  
  const proxyOptions = {
    key: apiKey,
    baseUrl: 'https://api.groq.com/openai',
    reasoningModel: options.reasoningModel,
    completionModel: options.completionModel,
    debug: options.debug
  };
  
  try {
    // Start the proxy server directly
    await startProxyServer(options.port, proxyOptions);
  } catch (error) {
    console.error('Failed to start proxy:', error);
    throw error;
  }
}

async function startClaude() {
  console.log('Starting claude-code...');
  
  const claudeEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://localhost:${options.port}`,
    ANTHROPIC_API_KEY: 'sk-ant-api03-demo'
  };
  
  claudeProcess = spawn('claude', [], {
    env: claudeEnv,
    stdio: 'inherit'
  });
  
  claudeProcess.on('error', (error) => {
    console.error('Failed to start claude-code:', error);
    console.error('Make sure claude-code is installed and available in your PATH');
    cleanup();
  });
  
  claudeProcess.on('exit', (code) => {
    console.log(`Claude-code exited with code ${code}`);
    cleanup();
  });
}

async function main() {
  try {
    console.log('🚀 Kimi Code CLI');
    console.log('================');
    
    const apiKey = await getApiKey();
    
    await startProxy(apiKey);
    console.log(`✅ Proxy started on port ${options.port}`);
    console.log(`🤖 Using model: ${options.reasoningModel}`);
    console.log('🔗 Base URL: https://api.groq.com/openai');
    
    // Wait a moment for the proxy to be fully ready
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    await startClaude();
  } catch (error) {
    console.error('❌ Error:', error.message);
    cleanup();
  }
}

main();
