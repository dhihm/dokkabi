/** Canonical self-links add no navigation inside the target discussion.
 * Source/discussion anchors, other targets and literal code remain useful. */
export function hasRedundantGithubSelfLink(body: string, owner: string, repo: string, number: number): boolean {
  let fence: { char: string; size: number } | undefined;
  for (const line of body.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.size && !marker[2]!.trim()) fence = undefined;
      continue;
    }
    if (marker) { fence = { char: marker[1]![0]!, size: marker[1]!.length }; continue; }
    const prose = line.replace(/(`+)(?!`)(.*?)\1(?!`)/g, "");
    const links = prose.matchAll(/https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:pull|issues)\/([1-9]\d*)\/?(?=$|[\s<>"')\].,;!])/gi);
    for (const link of links) {
      if (link[1]!.toLowerCase() === owner.toLowerCase() && link[2]!.toLowerCase() === repo.toLowerCase() && Number(link[3]) === number) return true;
    }
  }
  return false;
}
