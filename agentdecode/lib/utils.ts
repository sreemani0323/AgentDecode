import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function generateApiKey(): string {
  const randomBytes = new Uint8Array(16);
  crypto.getRandomValues(randomBytes);
  const hex = Array.from(randomBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return "al_" + hex;
}

export async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatCost(usd: number): string {
  if (usd < 0.0001 && usd > 0) {
    return "<$0.0001";
  }
  return `$${usd.toFixed(4)}`;
}

export function formatTokens(count: number): string {
  if (count < 1000) {
    return count.toString();
  }
  if (count < 1000000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return `${(count / 1000000).toFixed(1)}M`;
}

export function getSpanTypeColor(spanType: string): string {
  switch (spanType) {
    case 'llm':
      return "bg-purple-500";
    case 'tool':
      return "bg-blue-500";
    case 'retrieval':
      return "bg-green-500";
    case 'chain':
      return "bg-yellow-500";
    case 'agent':
      return "bg-orange-500";
    default:
      return "bg-gray-500";
  }
}

export function getStatusColor(status: string): string {
  switch (status) {
    case 'ok':
    case 'success':
      return "text-green-400";
    case 'error':
      return "text-red-400";
    case 'running':
      return "text-yellow-400";
    default:
      return "text-gray-400";
  }
}

export function getStatusBgColor(status: string): string {
  switch (status) {
    case 'ok':
    case 'success':
      return "bg-green-500/10 text-green-400 border-green-500/20";
    case 'error':
      return "bg-red-500/10 text-red-400 border-red-500/20";
    case 'running':
      return "bg-yellow-500/10 text-yellow-400 border-yellow-500/20";
    default:
      return "bg-gray-500/10 text-gray-400 border-gray-500/20";
  }
}
