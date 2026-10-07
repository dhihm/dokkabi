/**
 * Host executable lookup is deliberately independent of PATH. A repository
 * may contain `bin/bwrap` or `bin/docker`, and the operator may launch from a
 * shell whose PATH includes that directory. Neither fact grants host-code
 * execution before the sandbox opens.
 */
export function hostExecutableCandidates(
  name: "bwrap" | "docker" | "gh" | "git" | "ssh" | "scp" | "rsync" | "python3" | "seatbelt" | "cursor-agent",
  _workspaceRoot?: string,
): readonly string[] {
  // The vendor's installer puts it under the operator's home; a package
  // manager may also place it on a shared prefix. Both are fixed paths, and
  // the seal is the file's own digest either way.
  if (name === "cursor-agent") {
    const home = process.env.HOME?.trim();
    return [
      ...(home ? [`${home}/.local/bin/cursor-agent`, `${home}/.cursor/bin/cursor-agent`] : []),
      "/opt/homebrew/bin/cursor-agent",
      "/usr/local/bin/cursor-agent",
      "/usr/bin/cursor-agent",
    ];
  }
  if (name === "python3") return process.platform === "darwin"
    ? ["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"]
    : ["/usr/bin/python3", "/usr/local/bin/python3"];
  if (name === "scp") return process.platform === "darwin"
    ? ["/usr/bin/scp", "/opt/homebrew/bin/scp", "/usr/local/bin/scp"]
    : ["/usr/bin/scp", "/bin/scp", "/usr/local/bin/scp"];
  if (name === "rsync") return process.platform === "darwin"
    ? ["/usr/bin/rsync", "/opt/homebrew/bin/rsync", "/usr/local/bin/rsync"]
    : ["/usr/bin/rsync", "/bin/rsync", "/usr/local/bin/rsync"];
  if (name === "seatbelt") {
    return process.platform === "darwin" ? ["/usr/bin/sandbox-exec"] : [];
  }
  if (name === "bwrap") {
    return process.platform === "linux"
      ? ["/usr/bin/bwrap", "/usr/local/bin/bwrap"]
      : [];
  }
  if (name === "docker") return process.platform === "darwin"
    ? [
        "/usr/local/bin/docker",
        "/opt/homebrew/bin/docker",
        "/Applications/Docker.app/Contents/Resources/bin/docker",
      ]
    : ["/usr/bin/docker", "/usr/local/bin/docker", "/snap/bin/docker"];
  if (name === "gh") return process.platform === "darwin"
    ? ["/usr/bin/gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"]
    : ["/usr/bin/gh", "/bin/gh", "/usr/local/bin/gh"];
  if (name === "ssh") return process.platform === "darwin"
    ? ["/usr/bin/ssh", "/opt/homebrew/bin/ssh", "/usr/local/bin/ssh"]
    : ["/usr/bin/ssh", "/bin/ssh", "/usr/local/bin/ssh"];
  return process.platform === "darwin"
    ? ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]
    : ["/usr/bin/git", "/bin/git", "/usr/local/bin/git"];
}
