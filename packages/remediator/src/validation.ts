import type { ProviderConfig, RemediationRequest } from './types.js';

export const ALLOWED_REPOSITORY = 'iotserver24/nexathon';
export const ALLOWED_PATH_PREFIX = 'apps/sample/';
const FORBIDDEN_SEGMENTS = /(^|\/)(?:node_modules|\.git|\.supercharge|dist|build|coverage|\.next)(\/|$)|(^|\/)(?:\.env(?:\.|$)|.*\.(?:pem|key)$)/i;

export function validateRequest(request: RemediationRequest, allowedRepository = ALLOWED_REPOSITORY): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(request.incidentId)) throw new Error('Invalid incident ID');
  if (request.repository !== allowedRepository) throw new Error('Repository is not allowlisted');
  if (!/^[0-9a-f]{40}$/i.test(request.commitSha)) throw new Error('A full 40-character commit SHA is required');
  for (const command of [request.setupCommand, request.reproduceCommand, request.testCommand, request.buildCommand]) {
    if (!command || command.length > 500 || /[\0\r\n]/.test(command)) throw new Error('Invalid project command');
  }
  if (!Array.isArray(request.evidence) || request.evidence.length > 20 || request.evidence.some((line) => typeof line !== 'string' || line.length > 1000)) {
    throw new Error('Evidence must be redacted and bounded');
  }
}

export function validateProvider(config: ProviderConfig): void {
  if (!config.modelId || !config.modelName || !config.apiKey) throw new Error('Dedicated Supercharge model credentials are required');
  if (!config.githubReadToken) throw new Error('Read-only GitHub MCP token is required');
  const url = new URL(config.baseUrl);
  if (url.protocol !== 'https:') throw new Error('Model provider base URL must use HTTPS');
  if (!['chat_completions', 'messages', 'responses'].includes(config.apiBackend)) throw new Error('Unsupported model API backend');
}

export function validateChangedFiles(paths: string[]): void {
  if (paths.length === 0) throw new Error('The agent produced no changed files');
  if (paths.length > 40) throw new Error('Too many changed files');
  for (const path of paths) {
    if (!path.startsWith(ALLOWED_PATH_PREFIX) || path.includes('..') || FORBIDDEN_SEGMENTS.test(path)) {
      throw new Error(`Patch contains a disallowed path: ${path}`);
    }
  }
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function truncate(value: string, max = 6000): string {
  return value.length > max ? `${value.slice(0, max)}\n[truncated]` : value;
}
