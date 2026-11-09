// Repo locator abstraction — the sovereign-repo layer.
// A market binds {type, locator}; each forge type resolves to the two things
// verification needs: a clone URL (participant-hosted remotes) and a diff
// template for single-commit evidence. GitHub is the zero-setup baseline;
// knot/radicle/deltagit are opt-in sovereign remotes.

type LocatorType =
  | "github" | "gitlab" | "forgejo" | "codeberg"
  | "knot" | "radicle" | "deltagit" | "generic";

export interface RepoLocator {
  type: LocatorType;
  /** Canonical locator — URL, rad://, or did-based repo id. */
  locator: string;
  /** git clone URL (https or git://). */
  cloneUrl: string;
  /** Commit-diff URL template ({sha} substituted) — null when the forge
   *  has no HTTP diff surface (p2p remotes recompute via clone instead). */
  diffUrl: string | null;
  /** Commit-info API template ({sha} → JSON {message}) — null if none. */
  commitApi: string | null;
}

const TEMPLATES: Record<LocatorType, { diff: string | null; api: string | null }> = {
  github:   { diff: "https://github.com/{repo}/commit/{sha}.diff",
              api: "https://api.github.com/repos/{repo}/commits/{sha}" },
  gitlab:   { diff: "https://gitlab.com/{repo}/-/commit/{sha}.diff",
              api: "https://gitlab.com/api/v4/projects/{proj}/repository/commits/{sha}" },
  forgejo:  { diff: "https://codeberg.org/{repo}/commit/{sha}.diff",
              api: "https://codeberg.org/api/v1/repos/{repo}/commits/{sha}" },
  codeberg: { diff: "https://codeberg.org/{repo}/commit/{sha}.diff",
              api: "https://codeberg.org/api/v1/repos/{repo}/commits/{sha}" },
  knot:     { diff: null, api: null },   // tangled knot — clone + isomorphic-git
  radicle:  { diff: null, api: null },   // radicle — clone + isomorphic-git
  deltagit: { diff: null, api: null },   // delta-git op-log — evidence IS the ops
  generic:  { diff: null, api: null },
};

function detectType(url: string): LocatorType {
  if (/github\.com/.test(url)) return "github";
  if (/gitlab\.com/.test(url)) return "gitlab";
  if (/codeberg\.org/.test(url)) return "codeberg";
  if (/forgejo/i.test(url)) return "forgejo";
  if (/tangled\.sh|tangled\.org/.test(url)) return "knot";
  if (/radicle\.xyz|rad:\/\//.test(url)) return "radicle";
  if (/deltagit|dg:\/\//.test(url)) return "deltagit";
  return "generic";
}

/** Normalize any locator input → RepoLocator. Accepts shorthand
 *  "owner/repo" (github baseline), full URLs, rad://, or {type,locator}. */
export function resolveLocator(input: string | { type?: string; locator: string }): RepoLocator {
  if (typeof input === "string") {
    const s = input.trim().replace(/\.git\/?$/, "").replace(/\/+$/, "");
    // shorthand owner/repo → github
    if (/^[\w.-]+\/[\w.-]+$/.test(s) && !s.includes(":")) {
      return mk("github", `https://github.com/${s}`, s);
    }
    const type = detectType(s);
    const repoPath = s.replace(/^https?:\/\//, "").replace(/^git@([^:]+):/, "$1/").replace(/\.git$/, "");
    // strip host prefix for {repo} templates on known forges
    const hostStrip = repoPath.replace(/^(github\.com|gitlab\.com|codeberg\.org|tangled\.sh|radicle\.xyz)\//, "");
    return mk(type, s, hostStrip);
  }
  const type = (detectType(input.locator) || input.type || "generic") as LocatorType;
  return mk(type, input.locator, input.locator);
}

function mk(type: LocatorType, locator: string, repoPath: string): RepoLocator {
  const t = TEMPLATES[type];
  const fill = (tpl: string | null) =>
    tpl ? tpl.replace("{repo}", repoPath).replace("{proj}", encodeURIComponent(repoPath.replace(/\//g, "%2F"))) : null;
  return {
    type, locator,
    cloneUrl: locator.startsWith("http") || locator.startsWith("git@") || locator.startsWith("rad:")
      ? locator : `https://github.com/${repoPath}`,
    diffUrl: fill(t.diff) ?? null,
    commitApi: fill(t.api) ?? null,
  };
}

/** Commit diff URL for a sha — null for p2p remotes (clone path instead). */
export function diffUrlFor(loc: RepoLocator, sha: string): string | null {
  return loc.diffUrl?.replace("{sha}", sha) ?? null;
}
