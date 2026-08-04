import type { SessionInfo } from "./types.ts";

const ALIAS_BOUNDARY_RE = /[a-z0-9_-]/i;

export function shortSessionId(sessionId: string): string {
  const normalized = sessionId.startsWith("session-")
    ? sessionId.slice("session-".length)
    : sessionId;
  return normalized.slice(0, 8);
}

export function sessionAlias(session: SessionInfo): string {
  return session.name?.trim() || shortSessionId(session.id);
}


function aliasBoundary(text: string, index: number): boolean {
  if (index >= text.length) return true;
  return !ALIAS_BOUNDARY_RE.test(text[index] ?? "");
}

export function referencedSessionAliases(
  text: string,
  aliases: ReadonlySet<string>,
): string[] {
  const lowerText = text.toLowerCase();
  const matches: Array<{ index: number; alias: string }> = [];
  const sortedAliases = [...aliases].sort((a, b) => b.length - a.length);

  for (const alias of sortedAliases) {
    const needle = `#${alias.toLowerCase()}`;
    let index = lowerText.indexOf(needle);
    while (index !== -1) {
      const afterAlias = index + needle.length;
      if ((index === 0 || text[index - 1] !== "#") && aliasBoundary(text, afterAlias)) {
        matches.push({ index, alias });
      }
      index = lowerText.indexOf(needle, afterAlias);
    }
  }

  matches.sort((a, b) => a.index - b.index);
  const names: string[] = [];
  for (const match of matches) {
    if (!names.includes(match.alias)) {
      names.push(match.alias);
    }
  }
  return names;
}
