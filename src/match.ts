import type { Rule } from "./rules";

// Lowercase, turn anything that isn't a letter or digit into a space, pad with spaces
// so a keyword can be checked as a whole word: " link " in " pls link me ".
function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

export function findRule(text: string, mediaId: string | undefined, rules: Rule[]): Rule | undefined {
  const haystack = normalize(text);
  return rules.find((rule) => {
    if (rule.media && rule.media.length > 0 && (!mediaId || !rule.media.includes(mediaId))) {
      return false;
    }
    return rule.keywords.some((kw) => {
      const needle = normalize(kw);
      return needle.trim().length > 0 && haystack.includes(needle);
    });
  });
}

export function pickReply(replies: string[] | undefined, random: () => number = Math.random): string | undefined {
  if (!replies || replies.length === 0) return undefined;
  return replies[Math.floor(random() * replies.length)];
}
